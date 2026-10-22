const { canonicalBank, banksMatch } = require('../src/utils/bank-name');

describe('bank-name matching', () => {
  test('the staging case: shop saved "ABA " and the reader returned "ABA"', () => {
    expect(banksMatch('ABA ', 'ABA')).toBe(true);
  });

  test('every common way of writing ABA is ABA', () => {
    for (const read of ['ABA', 'ABA Bank', "ABA' BANK", 'aba bank', 'Advanced Bank of Asia', 'ABA Bank (National Bank of Canada Group)']) {
      expect(canonicalBank(read)).toBe('ABA');
      expect(banksMatch('ABA Bank', read)).toBe(true);
    }
  });

  test('different banks do not match', () => {
    expect(banksMatch('ABA', 'ACLEDA Bank')).toBe(false);
    expect(banksMatch('Wing', 'ABA')).toBe(false);
  });

  test('ABA is not found inside other words', () => {
    expect(canonicalBank('Sabay Bank')).toBe(null);
  });

  test('unknown banks fall back to a loose comparison', () => {
    expect(banksMatch('Foo Bank ', 'foo bank plc')).toBe(true);
    expect(banksMatch('Foo Bank', 'Bar Bank')).toBe(false);
  });

  test('empty sides never match', () => {
    expect(banksMatch('', 'ABA')).toBe(false);
    expect(banksMatch('ABA', null)).toBe(false);
  });
});
