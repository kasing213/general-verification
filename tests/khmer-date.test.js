'use strict';

/**
 * Unit tests for src/core/khmer-date.js
 *
 * This parser is fraud-critical: OLD_SCREENSHOT (>7 day) detection and the
 * transaction-date validation in verification.js depend on it correctly reading
 * the date off a bank screenshot. A regression here silently lets stale
 * screenshots through (or rejects valid ones). The module is pure (no DB /
 * network), so it is fully unit-testable.
 *
 * Assertions below reflect the actual behavior read from the source, including
 * the Khmer-numeral digit path and the month-lookup / DD-MM-YYYY fallbacks.
 */

const {
  parseKhmerDate,
  extractNumbers,
} = require('../src/core/khmer-date');

// Khmer numerals ០-៩ are U+17E0..U+17E9
const KH_2025 = '២០២៥'; // ២០២៥
const KH_18 = '១៨';               // ១៨
const KH_APRIL = 'មេសា'; // មេសា

describe('extractNumbers', () => {
  test('returns empty array for empty / digitless input', () => {
    expect(extractNumbers('')).toEqual([]);
    expect(extractNumbers(null)).toEqual([]);
    expect(extractNumbers('no digits here')).toEqual([]);
  });

  test('reads Arabic digit groups', () => {
    expect(extractNumbers('18 April 2025')).toEqual([18, 2025]);
    expect(extractNumbers('123-456')).toEqual([123, 456]);
  });

  test('reads Khmer numerals directly without a conversion step', () => {
    expect(extractNumbers(KH_2025)).toEqual([2025]);
  });

  test('reads mixed Arabic + Khmer numerals in order', () => {
    expect(extractNumbers(`${KH_18} ${KH_2025}`)).toEqual([18, 2025]);
  });
});

describe('parseKhmerDate', () => {
  test('returns null for empty / digitless unparseable input', () => {
    expect(parseKhmerDate('')).toBeNull();
    expect(parseKhmerDate(null)).toBeNull();
    expect(parseKhmerDate('xyz qrs tuv')).toBeNull();
  });

  test('KNOWN QUIRK: step-1 lenient new Date() parses junk-with-digits into a garbage date', () => {
    // Documents a real weakness, not desired behavior: "garbage 999" should be
    // null but the lenient `new Date(dateStr)` first pass coerces it to year 999.
    // Flagged for the review — pin it so a future hardening fix flips this test.
    const d = parseKhmerDate('garbage 999');
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBeLessThan(1900);
  });

  test('parses an ISO date string', () => {
    const d = parseKhmerDate('2025-03-18');
    expect(d).toBeInstanceOf(Date);
    expect(d.getUTCFullYear()).toBe(2025);
    expect(d.getUTCMonth()).toBe(2); // March (0-indexed)
    expect(d.getUTCDate()).toBe(18);
  });

  test('parses an English "DD Month YYYY" string', () => {
    const d = parseKhmerDate('18 April 2025');
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(3); // April
    expect(d.getDate()).toBe(18);
  });

  test('parses a Khmer-script date with Khmer numerals', () => {
    const d = parseKhmerDate(`${KH_18} ${KH_APRIL} ${KH_2025}`);
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(3); // មេសា = April
    expect(d.getDate()).toBe(18);
  });

  test('parses a DD/MM/YYYY string via the separator fallback', () => {
    const d = parseKhmerDate('18/04/2025');
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(3); // 04 = April, day/month not swapped
    expect(d.getDate()).toBe(18);
  });
});
