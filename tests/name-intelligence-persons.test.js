'use strict';

// Receiver-name matching for initials and joint accounts. Live case
// (staging, 2026-10-19): the merchant typed "CHAN K. & THEOURN T.", ABA
// printed "CHAN KASING AND THOEURN THEARY", and the matcher scored 0% ->
// a real payment was rejected as WRONG_RECIPIENT.

const NameIntelligenceService = require('../src/services/name-intelligence');

const names = new NameIntelligenceService();
const STRICT = names.config.strictThreshold; // auto-verify at or above
const REVIEW = names.config.gptThreshold;    // merchant review at or above

async function score(extracted, expected) {
  return (await names.analyzeMatch(extracted, [expected], [])).confidence;
}

describe('initials and joint accounts', () => {
  test('initials stand in for full given names', async () => {
    expect(await score('CHAN KASING AND THOEURN THEARY', 'CHAN K. & THOEURN T.')).toBeGreaterThanOrEqual(STRICT);
    expect(await score('CHAN K. & THOEURN T.', 'CHAN KASING AND THOEURN THEARY')).toBeGreaterThanOrEqual(STRICT);
  });

  test('"&", "AND", "+" and "/" all join two account holders', async () => {
    for (const joined of ['CHAN KASING & THOEURN THEARY', 'CHAN KASING + THOEURN THEARY', 'CHAN KASING / THOEURN THEARY']) {
      expect(await score('CHAN KASING AND THOEURN THEARY', joined)).toBeGreaterThanOrEqual(STRICT);
    }
  });

  test('a one-letter spelling slip goes to merchant review, never a reject', async () => {
    // The live case: THEOURN (typed) vs THOEURN (bank).
    const s = await score('CHAN KASING AND THOEURN THEARY', 'CHAN K. & THEOURN T.');
    expect(s).toBeGreaterThanOrEqual(REVIEW);
    expect(s).toBeLessThan(STRICT);
  });

  test('family and given name in either order', async () => {
    expect(await score('KASING CHAN', 'CHAN KASING')).toBeGreaterThanOrEqual(STRICT);
  });

  test('the merchant alone, on a joint-account receipt, goes to review', async () => {
    const s = await score('CHAN KASING AND THOEURN THEARY', 'CHAN KASING');
    expect(s).toBeGreaterThanOrEqual(REVIEW);
    expect(s).toBeLessThan(STRICT);
  });
});

describe('still refused', () => {
  test('a different person with the same family name', async () => {
    expect(await score('CHAN SOPHEAP', 'CHAN K.')).toBeLessThan(REVIEW);
    expect(await score('CHAN SOPHEAP', 'CHAN KASING')).toBeLessThan(REVIEW);
  });

  test('initials alone are not enough', async () => {
    expect(await score('C. K.', 'CHAN KASING')).toBeLessThan(REVIEW);
  });

  test('a joint account missing the expected second holder', async () => {
    expect(await score('CHAN KASING', 'CHAN K. & THOEURN T.')).toBeLessThan(REVIEW);
  });

  test('an unrelated receiver', async () => {
    expect(await score('SOM PUTHEARY', 'CHAN K. & THOEURN T.')).toBeLessThan(REVIEW);
  });

  test('short family names that differ by one letter are different people', async () => {
    expect(await score('CHAM KASING', 'CHAN KASING')).toBeLessThan(STRICT);
  });
});
