'use strict';

/**
 * Bank receipts carry LOCAL wall-clock time, with no timezone on them.
 *
 * The parser built every Date with the server's own timezone (UTC on
 * Railway), so an ABA receipt reading "Sep 13, 2026 02:04 PM" - 14:04 in
 * Phnom Penh, 07:04 UTC - was read as 14:04 UTC. Seven hours ahead of the
 * instant it actually happened.
 *
 * The future-date check then compared that against `new Date()` with ZERO
 * tolerance, so:
 *
 *     parsed > now  <=>  uploaded less than 7 hours after paying
 *
 * which is every honest customer who pays and sends the screenshot straight
 * away. They were refused outright. A screenshot uploaded the NEXT day passed.
 * Exactly backwards, and it produced the observed log line:
 *
 *     Stage 3b: FUTURE_DATE | Transaction date is 1 days in the future
 *
 * (Math.ceil turns a 7-hour skew into "1 days".)
 */

const { parseKhmerDate } = require('../src/core/khmer-date');
const { validateTransactionDate } = require('../src/core/fraud-detector');
const { FRAUD_TYPES } = require('../src/core/fraud-types');

const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;

describe('bank receipts are read in Cambodia time, not server time', () => {
  test('an afternoon ABA receipt maps to the correct UTC instant', () => {
    const parsed = parseKhmerDate('Sep 13, 2026 02:04 PM');
    // 14:04 ICT is 07:04 UTC. The bug produced 14:04 UTC.
    expect(parsed.toISOString()).toBe('2026-09-13T07:04:00.000Z');
  });

  test('a date with no time is midnight in Cambodia, not midnight UTC', () => {
    const parsed = parseKhmerDate('13/09/2026');
    expect(parsed.toISOString()).toBe('2026-09-12T17:00:00.000Z');
  });

  test('an explicit timezone on the string is trusted, not re-shifted', () => {
    const parsed = parseKhmerDate('2026-09-13T07:04:00Z');
    expect(parsed.toISOString()).toBe('2026-09-13T07:04:00.000Z');
  });

  test('parsing does not depend on the server timezone', () => {
    // Same input, and the answer must not move when the host TZ does.
    const before = process.env.TZ;
    const results = [];
    for (const tz of ['UTC', 'Asia/Phnom_Penh', 'America/New_York']) {
      process.env.TZ = tz;
      results.push(parseKhmerDate('Sep 13, 2026 02:04 PM').toISOString());
    }
    process.env.TZ = before;
    expect(new Set(results).size).toBe(1);
  });
});

describe('the observed production failure', () => {
  test('paying at 2:04 PM and uploading immediately is NOT a future date', () => {
    const parsed = parseKhmerDate('Sep 13, 2026 02:04 PM');
    // The customer sends it seconds later, so "now" is that same instant.
    const uploadedAt = new Date('2026-09-13T07:04:30Z');

    const res = validateTransactionDate(parsed, uploadedAt, 7);

    expect(res.fraudType).toBeNull();
    expect(res.isValid).toBe(true);
  });

  test('any upload within seven hours of paying used to break, and must not', () => {
    const parsed = parseKhmerDate('Sep 13, 2026 02:04 PM');
    for (const mins of [0, 1, 30, 120, 400]) {
      const uploadedAt = new Date(parsed.getTime() + mins * 60000);
      expect(validateTransactionDate(parsed, uploadedAt, 7).isValid).toBe(true);
    }
  });
});

describe('the future check still catches what it is for', () => {
  test('a date a day ahead is still refused', () => {
    const uploadedAt = new Date('2026-09-13T07:04:00Z');
    const tomorrow = new Date(uploadedAt.getTime() + 24 * 3600 * 1000);

    const res = validateTransactionDate(tomorrow, uploadedAt, 7);

    expect(res.isValid).toBe(false);
    expect(res.fraudType).toBe(FRAUD_TYPES.FUTURE_DATE);
  });

  test('small clock skew on a phone is tolerated, not called fraud', () => {
    const uploadedAt = new Date('2026-09-13T07:04:00Z');
    const slightlyAhead = new Date(uploadedAt.getTime() + 4 * 60000);

    expect(validateTransactionDate(slightlyAhead, uploadedAt, 7).isValid).toBe(true);
  });

  test('an old screenshot is still refused', () => {
    const uploadedAt = new Date('2026-09-13T07:04:00Z');
    const old = new Date(uploadedAt.getTime() - 9 * 24 * 3600 * 1000);

    const res = validateTransactionDate(old, uploadedAt, 7);

    expect(res.isValid).toBe(false);
    expect(res.fraudType).toBe(FRAUD_TYPES.OLD_SCREENSHOT);
  });

  test('the reason reads in hours when it is hours, not "1 days"', () => {
    const uploadedAt = new Date('2026-09-13T07:04:00Z');
    const ahead = new Date(uploadedAt.getTime() + 26 * 3600 * 1000);

    const res = validateTransactionDate(ahead, uploadedAt, 7);

    expect(res.reason).not.toMatch(/\b1 days\b/);
  });
});

describe('parsing is idempotent', () => {
  // ocr-engine parses dateRaw and stores toISOString(); validateTransactionDate
  // then parses that again. Two passes must not shift the instant twice.
  test('re-parsing an ISO string with a zone is a no-op', () => {
    const once = parseKhmerDate('Sep 13, 2026 02:04 PM');
    const twice = parseKhmerDate(once.toISOString());
    expect(twice.toISOString()).toBe(once.toISOString());
  });

  test('re-parsing a Date object is a no-op', () => {
    const once = parseKhmerDate('Sep 13, 2026 02:04 PM');
    expect(parseKhmerDate(once).toISOString()).toBe(once.toISOString());
  });

  test('the full engine-then-validator path keeps the instant', () => {
    const fromEngine = parseKhmerDate('Sep 13, 2026 02:04 PM').toISOString();
    const res = validateTransactionDate(fromEngine, new Date('2026-09-13T07:05:00Z'), 7);
    expect(res.parsedDate.toISOString()).toBe('2026-09-13T07:04:00.000Z');
    expect(res.isValid).toBe(true);
  });
});
