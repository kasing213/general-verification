'use strict';

/**
 * Read each image once, and a duplicate keeps the original's verdict.
 *
 * Live staging, 2026-10-19: a customer sent the same ABA receipt 3 times
 * within seconds. Every POST ran the full pipeline - 3 Claude agents each, 9
 * calls for one receipt - and sends 2 and 3 then hit E11000 on the
 * transactionId and answered "pending", although send 1 had answered
 * "rejected" (WRONG_RECIPIENT). The main backend then told the customer "your
 * merchant is confirming" after it had already told them "rejected".
 *
 * Runs the real route -> verification -> ocr-engine -> claude-ocr chain with
 * only the Anthropic SDK and Mongo faked. The fake payments collection
 * enforces the same unique transactionId index as production, so the E11000
 * path is the real one.
 */

const request = require('supertest');
const express = require('express');

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
);

// In-memory stand-in for src/db/mongo. `mockDb` survives jest.resetModules(),
// which is how the "restart" test drops in-process state but keeps the data.
const mockDb = { payments: [] };
jest.mock('../src/db/mongo', () => {
  const clone = (o) => structuredClone(o);
  return {
    getDb: () => { throw new Error('no db in test'); },
    invoices: { findById: jest.fn(async () => null), update: jest.fn(async () => ({})) },
    fraudAlerts: { create: jest.fn(async () => ({})) },
    screenshots: { upload: jest.fn(async () => 'gridfs-file-id') },
    payments: {
      async create(doc) {
        if (doc.transactionId && mockDb.payments.some(p => p.transactionId === doc.transactionId)) {
          throw Object.assign(new Error('E11000 duplicate key error'), {
            code: 11000, keyPattern: { transactionId: 1 }
          });
        }
        mockDb.payments.push(clone({ ...doc, uploadedAt: new Date() }));
        return { insertedId: doc._id };
      },
      async findById(id) {
        const p = mockDb.payments.find(x => x._id === id);
        return p ? clone(p) : null;
      },
      async findByTransactionId(trx) {
        const p = mockDb.payments.find(x => x.transactionId === trx);
        return p ? clone(p) : null;
      },
      async findRecentByImageKey(imageKey, since) {
        const hits = mockDb.payments
          .filter(p => p.imageKey === imageKey && p.uploadedAt >= since && p.responseSnapshot)
          .sort((a, b) => a.uploadedAt - b.uploadedAt);
        return hits.length ? clone(hits[0]) : null;
      },
      async update() { return {}; }
    }
  };
});

const TRX = '100FT40083767438';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function yesterday() {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} | 09:15 AM`;
}

function reply(json) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(json) }],
    usage: { input_tokens: 1600, output_tokens: 40 }
  };
}

// Each agent call is slow enough that three near-simultaneous POSTs overlap.
function mockAgents({ recipientName = 'KHIEV SAMNANG', transactionId = TRX, delayMs = 20 } = {}) {
  mockCreate.mockImplementation(async (req) => {
    await new Promise(r => setTimeout(r, delayMs));
    const prompt = req.messages[0].content[1].text;
    if (prompt.includes('transaction date/time')) return reply({ dateRaw: yesterday() });
    if (prompt.includes('amount fields')) return reply({ amount: 20000, currency: 'KHR' });
    return reply({
      isBankStatement: true, isPaid: true, confidence: 'high',
      transactionId, toAccount: null, recipientName, bankName: 'ABA'
    });
  });
}

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'OCR_PRIMARY', 'IMAGE_DEDUPE_WINDOW_HOURS'];
let savedEnv;
let app;

function buildApp() {
  const verifyRoutes = require('../src/routes/verify');
  const a = express();
  a.use(express.json());
  a.use('/api/v1/verify', verifyRoutes);
  return a;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  mockDb.payments.length = 0;
  mockCreate.mockReset();
  jest.resetModules();
  app = buildApp();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

const IMAGE_A = Buffer.from('aba-receipt-bytes-AAAA');
const IMAGE_B = Buffer.from('aba-receipt-bytes-BBBB (re-screenshot, different bytes)');

function send(image, { merchant = 'tenant-aaa', names = ['MEAS CHANTHA'], amount = 20000 } = {}) {
  return request(app)
    .post('/api/v1/verify')
    .set('X-API-Key', process.env.API_KEY)
    .field('merchant_id', merchant)
    .field('expectedPayment', JSON.stringify({ amount, currency: 'KHR', recipientNames: names }))
    .attach('image', image, { filename: 'receipt.png', contentType: 'image/png' });
}

describe('the same image is read once', () => {
  test('resent 3 times in a row: Claude runs once, all 3 get the original verdict', async () => {
    mockAgents();

    const r1 = await send(IMAGE_A);
    const r2 = await send(IMAGE_A);
    const r3 = await send(IMAGE_A);

    expect(mockCreate).toHaveBeenCalledTimes(3); // one scan = 3 agents, not 9

    expect(r1.status).toBe(200);
    expect(r1.body.verification.status).toBe('rejected');
    expect(r1.body.verification.rejectionReason).toBe('WRONG_RECIPIENT');
    expect(r1.body.duplicate).toBe(false);

    for (const r of [r2, r3]) {
      expect(r.status).toBe(200);
      expect(r.body.verification.status).toBe('rejected');
      expect(r.body.verification.rejectionReason).toBe('WRONG_RECIPIENT');
      expect(r.body.verification.userMessage).toBe(r1.body.verification.userMessage);
      expect(r.body.duplicate).toBe(true);
      expect(r.body.duplicateOf).toBe(r1.body.record_id);
      expect(r.body.duplicateReason).toBe('SAME_IMAGE');
      expect(r.body.record_id).toBe(r1.body.record_id);
      expect(r.body.extracted_data).toEqual(r1.body.extracted_data);
      expect(r.body.confidence).toBe(r1.body.confidence);
    }

    // Only the original is stored; the replays add no payment rows.
    expect(mockDb.payments).toHaveLength(1);
    expect(mockDb.payments[0].imageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('resent 3 times at once: the in-flight run is shared, Claude runs once', async () => {
    mockAgents({ delayMs: 80 });

    const [r1, r2, r3] = await Promise.all([send(IMAGE_A), send(IMAGE_A), send(IMAGE_A)]);

    expect(mockCreate).toHaveBeenCalledTimes(3);
    const all = [r1, r2, r3];
    for (const r of all) {
      expect(r.status).toBe(200);
      expect(r.body.verification.status).toBe('rejected');
      expect(r.body.verification.rejectionReason).toBe('WRONG_RECIPIENT');
    }
    const originals = all.filter(r => r.body.duplicate === false);
    const dups = all.filter(r => r.body.duplicate === true);
    expect(originals).toHaveLength(1);
    expect(dups).toHaveLength(2);
    for (const d of dups) expect(d.body.duplicateOf).toBe(originals[0].body.record_id);
    expect(mockDb.payments).toHaveLength(1);
  });

  test('survives a restart: the hash is read back from Mongo', async () => {
    mockAgents();
    const r1 = await send(IMAGE_A);

    jest.resetModules(); // drop every in-process cache, keep the "database"
    app = buildApp();
    const r2 = await send(IMAGE_A);

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(r2.body.duplicate).toBe(true);
    expect(r2.body.duplicateOf).toBe(r1.body.record_id);
    expect(r2.body.verification.status).toBe('rejected');
  });

  test('outside the window the image is read again', async () => {
    mockAgents();
    await send(IMAGE_A);
    mockDb.payments[0].uploadedAt = new Date(Date.now() - 25 * 3600 * 1000);
    mockDb.payments[0].transactionId = 'OLD-' + TRX; // keep this test about the image, not the trx

    const r2 = await send(IMAGE_A);
    expect(mockCreate).toHaveBeenCalledTimes(6);
    expect(r2.body.duplicate).toBe(false);
  });

  test('the window is configurable with IMAGE_DEDUPE_WINDOW_HOURS', async () => {
    process.env.IMAGE_DEDUPE_WINDOW_HOURS = '1';
    mockAgents();
    await send(IMAGE_A);
    mockDb.payments[0].uploadedAt = new Date(Date.now() - 2 * 3600 * 1000);
    mockDb.payments[0].transactionId = 'OLD-' + TRX;

    await send(IMAGE_A);
    expect(mockCreate).toHaveBeenCalledTimes(6);
  });

  test('another tenant sending the same image is not served this tenant\'s result', async () => {
    mockAgents();
    const r1 = await send(IMAGE_A, { merchant: 'tenant-aaa' });
    const r2 = await send(IMAGE_A, { merchant: 'tenant-bbb' });

    expect(mockCreate).toHaveBeenCalledTimes(6);
    expect(r2.body.record_id).not.toBe(r1.body.record_id);
    // Cross-tenant transaction collision keeps its detail-free treatment.
    expect(r2.body.verification.rejectionReason).toBe('DUPLICATE_TRANSACTION_OTHER_ACCOUNT');
    expect(r2.body.verification.duplicateOf).toEqual({ scope: 'other_merchant' });
    expect(r2.body.duplicateOf).toBeNull();
  });

  test('the same image against a different expected payment is judged again', async () => {
    mockAgents();
    await send(IMAGE_A, { names: ['MEAS CHANTHA'] });
    await send(IMAGE_A, { names: ['SOMEONE ELSE'] });
    expect(mockCreate).toHaveBeenCalledTimes(6);
  });

  test('a verified original is never handed out as verified a second time', async () => {
    mockAgents({ recipientName: 'MEAS CHANTHA' });
    const r1 = await send(IMAGE_A);
    expect(r1.body.verification.status).toBe('verified');

    const r2 = await send(IMAGE_A);
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(r2.body.duplicate).toBe(true);
    expect(r2.body.duplicateOf).toBe(r1.body.record_id);
    expect(r2.body.verification.status).toBe('pending');
    expect(r2.body.verification.rejectionReason).toBe('DUPLICATE_TRANSACTION');
    expect(r2.body.verification.originalStatus).toBe('verified');
    expect(r2.body.verification.duplicateOf).toMatchObject({
      scope: 'same_merchant', record_id: r1.body.record_id
    });
  });
});

describe('a different image of the same transaction keeps the original verdict', () => {
  test('E11000 answers with the original record, not a fresh "pending"', async () => {
    // The original was rejected for a reason the fresh read would not give,
    // so the test can tell the original's verdict from a re-derived one.
    mockDb.payments.push({
      _id: 'rec-original',
      merchant_id: 'tenant-aaa',
      transactionId: TRX,
      verificationStatus: 'rejected',
      paymentLabel: 'UNPAID',
      rejectionReason: 'OLD_SCREENSHOT',
      userMessage: 'This screenshot appears to be outdated. Please upload a recent payment screenshot.',
      amount: 20000,
      currency: 'KHR',
      uploadedAt: new Date(Date.now() - 60 * 1000)
    });
    mockAgents();

    const r = await send(IMAGE_B);

    expect(mockCreate).toHaveBeenCalledTimes(3); // a new image is still read
    expect(r.status).toBe(200);
    expect(r.body.verification.status).toBe('rejected');
    expect(r.body.verification.rejectionReason).toBe('OLD_SCREENSHOT');
    expect(r.body.verification.userMessage).toBe(
      'This screenshot appears to be outdated. Please upload a recent payment screenshot.'
    );
    expect(r.body.verification.originalStatus).toBe('rejected');
    expect(r.body.verification.duplicateOf).toMatchObject({
      scope: 'same_merchant', record_id: 'rec-original'
    });
    expect(r.body.duplicate).toBe(true);
    expect(r.body.duplicateOf).toBe('rec-original');
    expect(r.body.duplicateReason).toBe('SAME_TRANSACTION');

    // The audit copy is stored with the verdict that was actually returned.
    const audit = mockDb.payments.find(p => p._id === r.body.record_id);
    expect(audit.verificationStatus).toBe('rejected');
    expect(audit.rejectionReason).toBe('OLD_SCREENSHOT');
    expect(audit.transactionId).toBeUndefined();
  });

  test('the live sequence: rejected first, re-screenshot answers rejected too', async () => {
    mockAgents();
    const r1 = await send(IMAGE_A);
    const r2 = await send(IMAGE_B);

    expect(r1.body.verification.status).toBe('rejected');
    expect(r2.body.verification.status).toBe('rejected');
    expect(r2.body.verification.rejectionReason).toBe('WRONG_RECIPIENT');
    expect(r2.body.verification.userMessage).toBe(r1.body.verification.userMessage);
    expect(r2.body.duplicateOf).toBe(r1.body.record_id);
  });
});

describe('duplicateTransactionVerdict', () => {
  const load = () => require('../src/core/verification');

  test('original not found (lookup failed): held, detail-free - the old scope=unknown answer', () => {
    const { duplicateTransactionVerdict } = load();
    const d = duplicateTransactionVerdict(null, 'tenant-aaa');
    expect(d.scope).toBe('unknown');
    expect(d.verification.status).toBe('pending');
    expect(d.verification.rejectionReason).toBe('DUPLICATE_TRANSACTION_OTHER_ACCOUNT');
    expect(d.verification.duplicateOf).toEqual({ scope: 'other_merchant' });
  });

  test('pending original, same merchant: held as DUPLICATE_TRANSACTION, like the pre-check', () => {
    const { duplicateTransactionVerdict } = load();
    const d = duplicateTransactionVerdict(
      { _id: 'rec-1', merchant_id: 'tenant-aaa', verificationStatus: 'pending', rejectionReason: 'AMOUNT_MISMATCH' },
      'tenant-aaa'
    );
    expect(d.verification.status).toBe('pending');
    expect(d.verification.rejectionReason).toBe('DUPLICATE_TRANSACTION');
    expect(d.verification.originalStatus).toBe('pending');
    expect(d.verification.duplicateOf.record_id).toBe('rec-1');
  });

  test('rejected original stored before userMessage was persisted: message from its reason', () => {
    const { duplicateTransactionVerdict, USER_MESSAGES } = load();
    const d = duplicateTransactionVerdict(
      { _id: 'rec-1', merchant_id: 'tenant-aaa', verificationStatus: 'rejected', rejectionReason: 'WRONG_RECIPIENT' },
      'tenant-aaa'
    );
    expect(d.verification.status).toBe('rejected');
    expect(d.verification.paymentLabel).toBe('UNPAID');
    expect(d.verification.userMessage).toBe(USER_MESSAGES.WRONG_RECIPIENT);
  });

  test('another merchant\'s rejected original: its verdict is not leaked', () => {
    const { duplicateTransactionVerdict } = load();
    const d = duplicateTransactionVerdict(
      { _id: 'rec-1', merchant_id: 'tenant-bbb', verificationStatus: 'rejected', rejectionReason: 'WRONG_RECIPIENT' },
      'tenant-aaa'
    );
    expect(d.verification.status).toBe('pending');
    expect(d.verification.rejectionReason).toBe('DUPLICATE_TRANSACTION_OTHER_ACCOUNT');
    expect(d.verification.originalStatus).toBeNull();
  });
});
