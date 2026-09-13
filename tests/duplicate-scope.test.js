'use strict';

/**
 * A duplicate transaction is the merchant's call, not an auto-refusal.
 *
 * It used to be `rejected` + a CRITICAL fraud alert, so the customer was
 * refused outright and the merchant was never told. The innocent explanations
 * (customer resent the screenshot, one transfer covering two invoices) are at
 * least as common as the guilty one.
 *
 * The awkward part is WHOSE payment we collided with. The unique index on
 * transactionId is GLOBAL, not per-tenant, so a hit can point at a completely
 * different shop's payment. Listing that shop's invoice number and amount to
 * this merchant would be a cross-tenant leak, so only same-merchant hits carry
 * detail.
 */

jest.mock('../src/db/mongo', () => ({
  payments: { findByTransactionId: jest.fn() },
  getDb: () => { throw new Error('no db in test'); }
}));

jest.mock('../src/core/ocr-engine', () => ({
  analyzePaymentScreenshot: jest.fn()
}));

const { payments } = require('../src/db/mongo');
const { analyzePaymentScreenshot } = require('../src/core/ocr-engine');
const { verifyPayment } = require('../src/core/verification');
const { FRAUD_TYPES } = require('../src/core/fraud-types');

const OURS = 'tenant-aaa';
const THEIRS = 'tenant-bbb';

function ocrResult(overrides = {}) {
  return Object.assign({
    isBankStatement: true,
    isPaid: true,
    confidence: 'high',
    amount: 20000,
    currency: 'KHR',
    transactionId: '100FT38982569217',
    toAccount: '086 228 226',
    recipientName: 'HONG KUNTHEA',
    bankName: 'ABA',
    transactionDate: new Date().toISOString()
  }, overrides);
}

function existing(merchantId) {
  return {
    _id: 'rec-original',
    verificationStatus: 'verified',
    merchant_id: merchantId,
    invoice_id: 'INV-0031',
    amount: 20000,
    currency: 'KHR',
    transactionDate: new Date('2026-09-12T07:00:00Z'),
    uploadedAt: new Date('2026-09-12T07:22:00Z')
  };
}

beforeEach(() => {
  analyzePaymentScreenshot.mockResolvedValue(ocrResult());
  payments.findByTransactionId.mockReset();
});

const run = (opts) => verifyPayment(Buffer.from('x'), { amount: 20000, currency: 'KHR' },
  Object.assign({ merchantId: OURS }, opts));

describe('a duplicate goes to the merchant instead of being refused', () => {
  test('same shop: held for review, not rejected', async () => {
    payments.findByTransactionId.mockResolvedValue(existing(OURS));

    const r = await run();

    expect(r.verification.status).toBe('pending');
    expect(r.verification.paymentLabel).toBe('PENDING');
    expect(r.verification.rejectionReason).toBe(FRAUD_TYPES.DUPLICATE_TRANSACTION);
  });

  test('same shop: the original payment is listed out', async () => {
    payments.findByTransactionId.mockResolvedValue(existing(OURS));

    const { duplicateOf } = (await run()).verification;

    expect(duplicateOf.scope).toBe('same_merchant');
    expect(duplicateOf.invoice_number).toBe('INV-0031');
    expect(duplicateOf.amount).toBe(20000);
    expect(duplicateOf.record_id).toBe('rec-original');
  });

  test('other shop: still held, but under its own reason code', async () => {
    payments.findByTransactionId.mockResolvedValue(existing(THEIRS));

    const r = await run();

    expect(r.verification.status).toBe('pending');
    expect(r.verification.rejectionReason)
      .toBe(FRAUD_TYPES.DUPLICATE_TRANSACTION_OTHER_ACCOUNT);
  });

  test('other shop: NOTHING about the original is handed back', async () => {
    payments.findByTransactionId.mockResolvedValue(existing(THEIRS));

    const r = await run();

    expect(r.verification.duplicateOf).toEqual({ scope: 'other_merchant' });
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('INV-0031');
    expect(serialized).not.toContain('rec-original');
    expect(serialized).not.toContain(THEIRS);
  });

  test('an unknown merchant on either side is treated as another shop', async () => {
    // Historical rows stored customer_id in merchant_id, so they will not
    // match a tenant. Falling through to the detail-free branch is the safe
    // direction: it under-shares, it never leaks.
    payments.findByTransactionId.mockResolvedValue(existing(undefined));

    const r = await run();

    expect(r.verification.duplicateOf).toEqual({ scope: 'other_merchant' });
  });

  test('a caller that sends no merchantId cannot be told it is the same shop', async () => {
    payments.findByTransactionId.mockResolvedValue(existing(OURS));

    const r = await verifyPayment(Buffer.from('x'), { amount: 20000 }, {});

    expect(r.verification.duplicateOf).toEqual({ scope: 'other_merchant' });
  });
});

describe('the audit trail does not get thinner', () => {
  test('a fraud alert is still written for both cases', async () => {
    payments.findByTransactionId.mockResolvedValue(existing(OURS));
    expect((await run()).fraud).toBeTruthy();

    payments.findByTransactionId.mockResolvedValue(existing(THEIRS));
    expect((await run()).fraud).toBeTruthy();
  });

  test('severity separates the innocent case from the suspicious one', async () => {
    payments.findByTransactionId.mockResolvedValue(existing(OURS));
    expect((await run()).fraud.severity).toBe('MEDIUM');

    payments.findByTransactionId.mockResolvedValue(existing(THEIRS));
    expect((await run()).fraud.severity).toBe('CRITICAL');
  });
});

describe('a previously rejected payment is not a duplicate', () => {
  test('a rejected original does not block a retry', async () => {
    payments.findByTransactionId.mockResolvedValue(
      Object.assign(existing(OURS), { verificationStatus: 'rejected' })
    );

    const r = await run();

    expect(r.verification.rejectionReason).not.toBe(FRAUD_TYPES.DUPLICATE_TRANSACTION);
  });
});

describe('date failures the customer cannot control go to review', () => {
  test.each([
    ['a future date', new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(), FRAUD_TYPES.FUTURE_DATE],
    ['an unreadable date', 'not a date at all', FRAUD_TYPES.INVALID_DATE]
  ])('%s is held, not refused', async (_label, transactionDate, expected) => {
    payments.findByTransactionId.mockResolvedValue(null);
    analyzePaymentScreenshot.mockResolvedValue(ocrResult({ transactionDate }));

    const r = await run();

    expect(r.verification.rejectionReason).toBe(expected);
    expect(r.verification.status).toBe('pending');
  });

  test('an old screenshot IS still refused - that one is reuse-shaped', async () => {
    payments.findByTransactionId.mockResolvedValue(null);
    analyzePaymentScreenshot.mockResolvedValue(ocrResult({
      transactionDate: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString()
    }));

    const r = await run();

    expect(r.verification.rejectionReason).toBe(FRAUD_TYPES.OLD_SCREENSHOT);
    expect(r.verification.status).toBe('rejected');
  });
});
