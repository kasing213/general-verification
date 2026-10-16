'use strict';

/**
 * The amount agent used to return only a normalized currency label. On a
 * Canadia/KHQR receipt whose header says `៛10,000` and whose lower detail row
 * says `Debit Amount 2.47 USD`, the model returned `{amount:10000,currency:
 * "USD"}`. Once the adjacent symbol was discarded, downstream verification
 * had no evidence with which to correct that contradiction.
 */

const { _internals } = require('../src/services/claude-ocr');

const normalize = (value) => _internals.normalizeAmountResult?.(value);

describe('the selected amount keeps its adjacent currency evidence', () => {
  test('the real Canadia shape uses the riel symbol over a conflicting USD label', () => {
    expect(normalize({
      amount: 10000,
      currency: 'USD',
      amountText: '៛10,000',
      currencySymbol: '៛'
    })).toEqual({
      amount: 10000,
      currency: 'KHR',
      amountText: '៛10,000',
      currencySymbol: '៛'
    });
  });

  test('a dollar symbol stays USD', () => {
    expect(normalize({
      amount: 2.5,
      currency: 'KHR',
      amountText: '$2.50',
      currencySymbol: '$'
    })).toEqual({
      amount: 2.5,
      currency: 'USD',
      amountText: '$2.50',
      currencySymbol: '$'
    });
  });

  test('a dedicated adjacent symbol wins over mixed explanatory text', () => {
    expect(normalize({
      amount: 2.5,
      currency: 'KHR',
      amountText: '$2.50 (10,000៛ equivalent)',
      currencySymbol: '$'
    })).toEqual({
      amount: 2.5,
      currency: 'USD',
      amountText: '$2.50 (10,000៛ equivalent)',
      currencySymbol: '$'
    });
  });

  test('Khmer currency words are retained as evidence', () => {
    expect(normalize({
      amount: 10000,
      currency: 'USD',
      amountText: '10,000 រៀល',
      currencySymbol: 'រៀល'
    })).toEqual({
      amount: 10000,
      currency: 'KHR',
      amountText: '10,000 រៀល',
      currencySymbol: 'រៀល'
    });
  });

  test('preserves the exact copied symbol while using trimmed evidence', () => {
    expect(normalize({
      amount: 10000,
      currency: 'USD',
      amountText: ' ៛10,000 ',
      currencySymbol: ' ៛ '
    })).toEqual({
      amount: 10000,
      currency: 'KHR',
      amountText: ' ៛10,000 ',
      currencySymbol: ' ៛ '
    });
  });

  test('legacy agent output still falls back to its normalized currency', () => {
    expect(normalize({ amount: 4000, currency: 'KHR' })).toEqual({
      amount: 4000,
      currency: 'KHR',
      amountText: null,
      currencySymbol: null
    });
  });
});
