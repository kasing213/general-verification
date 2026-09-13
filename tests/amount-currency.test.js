'use strict';

/**
 * The amount check compared two different units.
 *
 * Stage 3d converted the EXTRACTED amount to KHR and then compared it against
 * `expected.amount` straight off the invoice, which is in the INVOICE's
 * currency. `verifyAmount`'s own docstring says both sides must be KHR.
 *
 * So a $2.50 invoice was compared as `2.5` against `10000`, and every USD
 * invoice failed the amount check no matter what the customer paid:
 *
 *   Stage 3d: Amount mismatch | Expected: 2.5, Got: 40000000
 *
 * KHR invoices happened to work, which is why this survived.
 */

jest.mock('../src/db/mongo', () => ({
  payments: { findByTransactionId: jest.fn().mockResolvedValue(null) },
  getDb: () => { throw new Error('no db in test'); }
}));
jest.mock('../src/core/ocr-engine', () => ({ analyzePaymentScreenshot: jest.fn() }));

const { analyzePaymentScreenshot } = require('../src/core/ocr-engine');
const { verifyPayment } = require('../src/core/verification');
const { FRAUD_TYPES } = require('../src/core/fraud-types');

function paid(amount, currency) {
  return {
    isBankStatement: true, isPaid: true, confidence: 'high',
    amount, currency,
    transactionId: 'FT262562T5JP', toAccount: '086 228 226',
    recipientName: 'CHAN KANHA', bankName: 'Canadia',
    transactionDate: new Date().toISOString()
  };
}

const run = (expected) =>
  verifyPayment(Buffer.from('x'), expected, { merchantId: 't1' });

describe('an invoice is compared in one unit, whatever the currencies are', () => {
  test.each([
    ['USD invoice paid in USD', { amount: 2.5, currency: 'USD' }, 2.5, 'USD'],
    ['USD invoice paid in KHR', { amount: 2.5, currency: 'USD' }, 10000, 'KHR'],
    ['KHR invoice paid in KHR', { amount: 10000, currency: 'KHR' }, 10000, 'KHR'],
    ['KHR invoice paid in USD', { amount: 10000, currency: 'KHR' }, 2.5, 'USD']
  ])('%s matches', async (_label, expected, amount, currency) => {
    analyzePaymentScreenshot.mockResolvedValue(paid(amount, currency));

    const r = await run(expected);

    expect(r.validation.amount.match).toBe(true);
    expect(r.verification.rejectionReason).not.toBe(FRAUD_TYPES.AMOUNT_MISMATCH);
  });

  test('a genuine underpayment is still caught on a USD invoice', async () => {
    analyzePaymentScreenshot.mockResolvedValue(paid(1.0, 'USD'));

    const r = await run({ amount: 2.5, currency: 'USD' });

    expect(r.validation.amount.match).toBe(false);
    expect(r.verification.rejectionReason).toBe(FRAUD_TYPES.AMOUNT_MISMATCH);
  });

  test('the real log case: 10000 USD against a $2.50 invoice is a mismatch', async () => {
    // If the receipt really does say USD 10,000 that IS wrong for a $2.50
    // invoice, so this must stay a mismatch even after the unit fix.
    analyzePaymentScreenshot.mockResolvedValue(paid(10000, 'USD'));

    const r = await run({ amount: 2.5, currency: 'USD' });

    expect(r.validation.amount.match).toBe(false);
  });
});

describe('the numbers shown to a merchant carry their currency', () => {
  test('expected and actual are reported as read, with units', async () => {
    analyzePaymentScreenshot.mockResolvedValue(paid(10000, 'USD'));

    const { amount } = (await run({ amount: 2.5, currency: 'USD' })).validation;

    // "invoice 2.5, screenshot 40000000" told the merchant nothing. Reporting
    // both sides as read is what makes a currency misread visible.
    expect(amount.expected).toBe(2.5);
    expect(amount.expectedCurrency).toBe('USD');
    expect(amount.actual).toBe(10000);
    expect(amount.actualCurrency).toBe('USD');
  });
});

describe('a currency the reader was not sure about', () => {
  test('a null currency is treated as the invoice currency, not guessed', async () => {
    // Better an honest null from the extractor than a wrong "USD". The
    // invoice's own currency is the sane default: it is the merchant's
    // account currency and the one being billed.
    analyzePaymentScreenshot.mockResolvedValue(paid(10000, null));

    const r = await run({ amount: 10000, currency: 'KHR' });

    expect(r.validation.amount.match).toBe(true);
    expect(r.validation.amount.currencyAssumed).toBe(true);
  });

  test('a stated currency is never overridden', async () => {
    analyzePaymentScreenshot.mockResolvedValue(paid(2.5, 'USD'));

    const r = await run({ amount: 10000, currency: 'KHR' });

    expect(r.validation.amount.currencyAssumed).toBeFalsy();
    expect(r.validation.amount.actualCurrency).toBe('USD');
  });
});

describe('a mismatch that would match under the other currency is flagged', () => {
  test('10000 read as USD against a 10000 KHR invoice is called out', async () => {
    // The exact failure shape from the log: the number is right, the currency
    // label is not. Never auto-accepted - paying 10,000 KHR against a $10,000
    // invoice must not clear - but the merchant is told what we noticed.
    analyzePaymentScreenshot.mockResolvedValue(paid(10000, 'USD'));

    const r = await run({ amount: 10000, currency: 'KHR' });

    expect(r.validation.amount.match).toBe(false);
    expect(r.validation.amount.currencySuspect).toBe(true);
    expect(r.verification.status).toBe('pending');
  });

  test('an ordinary mismatch is not flagged as a currency problem', async () => {
    analyzePaymentScreenshot.mockResolvedValue(paid(3000, 'KHR'));

    const r = await run({ amount: 10000, currency: 'KHR' });

    expect(r.validation.amount.match).toBe(false);
    expect(r.validation.amount.currencySuspect).toBeFalsy();
  });
});
