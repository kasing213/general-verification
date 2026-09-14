'use strict';

/**
 * The receiver name is the primary recipient identity.
 *
 * Cambodian bank receipts do not consistently expose the destination account
 * number.  A matching receiver name must therefore remain verifiable when the
 * account number is absent.  Conversely, an account-number match must never
 * override a wrong or missing receiver name.
 */

jest.mock('../src/db/mongo', () => ({
  payments: { findByTransactionId: jest.fn().mockResolvedValue(null) },
  getDb: () => { throw new Error('no db in test'); }
}));
jest.mock('../src/core/ocr-engine', () => ({ analyzePaymentScreenshot: jest.fn() }));

const { analyzePaymentScreenshot } = require('../src/core/ocr-engine');
const { verifyPayment } = require('../src/core/verification');
const { FRAUD_TYPES } = require('../src/core/fraud-types');

const RECEIVER = 'CHAN K. & THOEURN T.';
const ACCOUNT = '086 228 226';

function receipt(overrides = {}) {
  return {
    isBankStatement: true,
    isPaid: true,
    confidence: 'high',
    amount: 25000,
    currency: 'KHR',
    transactionId: 'FT262562T5JP',
    toAccount: ACCOUNT,
    recipientName: RECEIVER,
    bankName: 'Canadia',
    transactionDate: new Date().toISOString(),
    ...overrides
  };
}

const expected = {
  amount: 25000,
  currency: 'KHR',
  toAccount: ACCOUNT,
  recipientNames: [RECEIVER],
  tolerancePercent: 5
};

async function run(overrides = {}, expectedOverrides = {}) {
  analyzePaymentScreenshot.mockResolvedValue(receipt(overrides));
  return verifyPayment(
    Buffer.from('receipt'),
    { ...expected, ...expectedOverrides },
    { merchantId: 'tenant-1' }
  );
}

describe('receiver name is the primary recipient check', () => {
  test('matching receiver verifies when the receipt omits the account number', async () => {
    const result = await run({ toAccount: null });

    expect(result.validation.recipientNames.match).toBe(true);
    expect(result.validation.toAccount.skipped).toBe(true);
    expect(result.validation.toAccount.confidence).toBeNull();
    expect(result.validation.toAccount.matchType).toBe('skipped');
    expect(result.verification.status).toBe('verified');
  });

  test('an abbreviated receiver can verify at medium read quality without account or transaction id', async () => {
    const result = await run(
      {
        confidence: 'medium',
        toAccount: null,
        transactionId: null,
        recipientName: 'CHAN K. & THOEURN T.'
      },
      { recipientNames: ['CHAN KANHA & THOEURN THAVRY'] }
    );

    expect(result.validation.recipientNames.match).toBe(true);
    expect(result.validation.recipientNames.confidence).toBeGreaterThanOrEqual(85);
    expect(result.verification.status).toBe('verified');
  });

  test('wrong receiver is rejected even when the account number matches', async () => {
    const result = await run({ recipientName: 'SOMEONE ELSE' });

    expect(result.validation.toAccount.match).toBe(true);
    expect(result.validation.toAccount.confidence).toBe(100);
    expect(result.validation.toAccount.matchType).toBe('account_exact');
    expect(result.validation.recipientNames.match).toBe(false);
    expect(result.verification.status).toBe('rejected');
    expect(result.verification.rejectionReason).toBe(FRAUD_TYPES.WRONG_RECIPIENT);
  });

  test('missing receiver goes to review even when the account number matches', async () => {
    const result = await run({ recipientName: null });

    expect(result.validation.toAccount.match).toBe(true);
    expect(result.validation.recipientNames.match).toBeNull();
    expect(result.verification.status).toBe('pending');
    expect(result.verification.rejectionReason).toBe(FRAUD_TYPES.RECIPIENT_UNVERIFIABLE);
  });

  test('an invoice without an expected receiver cannot auto-verify from account alone', async () => {
    const result = await run({}, { recipientNames: [] });

    expect(result.verification.status).toBe('pending');
    expect(result.verification.rejectionReason).toBe(FRAUD_TYPES.RECIPIENT_UNVERIFIABLE);
  });

  test('an account mismatch is recorded but does not override a matching receiver', async () => {
    const result = await run({ toAccount: '999 999 999' });

    expect(result.validation.toAccount.match).toBe(false);
    expect(result.validation.toAccount.confidence).toBe(0);
    expect(result.validation.toAccount.matchType).toBe('account_mismatch');
    expect(result.validation.recipientNames.match).toBe(true);
    expect(result.verification.status).toBe('verified');
  });
});

describe('date and amount remain required supporting checks', () => {
  test('matching receiver and amount still require a transaction date', async () => {
    const result = await run({ toAccount: null, transactionDate: null });

    expect(result.verification.status).toBe('pending');
    expect(result.verification.rejectionReason).toBe(FRAUD_TYPES.MISSING_DATE);
  });

  test('matching receiver and date do not auto-verify a wrong amount', async () => {
    const result = await run({ toAccount: null, amount: 10000 });

    expect(result.verification.status).toBe('pending');
    expect(result.verification.rejectionReason).toBe(FRAUD_TYPES.AMOUNT_MISMATCH);
  });
});
