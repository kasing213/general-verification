'use strict';

/**
 * Currency Conversion Utilities
 */

// Default USD to KHR rate (can be overridden via env)
const USD_TO_KHR_RATE = parseFloat(process.env.USD_TO_KHR_RATE) || 4000;

/**
 * Converts amount to KHR
 * @param {number} amount - Amount to convert
 * @param {string} currency - Source currency ('KHR', 'USD', '$')
 * @returns {number} - Amount in KHR
 */
function convertToKHR(amount, currency) {
  if (!amount || isNaN(amount)) return 0;

  const normalizedCurrency = (currency || 'KHR').toUpperCase().trim();

  switch (normalizedCurrency) {
    case 'USD':
    case '$':
      return Math.round(amount * USD_TO_KHR_RATE);
    case 'KHR':
    case 'R':
    default:
      return Math.round(amount);
  }
}

/**
 * Formats currency amount with proper separators
 * @param {number} amount - Amount to format
 * @param {string} currency - Currency code
 * @returns {string} - Formatted amount string
 */
function formatCurrency(amount, currency = 'KHR') {
  if (!amount || isNaN(amount)) return '0';

  const formatted = amount.toLocaleString('en-US');

  if (currency === 'USD' || currency === '$') {
    return `$${formatted}`;
  }

  return `${formatted} KHR`;
}

/**
 * Verifies if payment amount matches expected amount within tolerance
 * @param {number} expectedAmount - Expected amount in KHR
 * @param {number} actualAmount - Actual paid amount in KHR
 * @param {number} tolerancePercent - Tolerance percentage (default 5%)
 * @returns {object} - { match, difference, percentDiff }
 */
function verifyAmount(expectedAmount, actualAmount, tolerancePercent = 5) {
  if (!expectedAmount || !actualAmount) {
    return {
      match: false,
      difference: null,
      percentDiff: null,
      reason: 'Missing amount value'
    };
  }

  const difference = actualAmount - expectedAmount;
  const percentDiff = (difference / expectedAmount) * 100;
  const toleranceAmount = (expectedAmount * tolerancePercent) / 100;
  const minAcceptable = expectedAmount - toleranceAmount;
  const maxAcceptable = expectedAmount + toleranceAmount;

  const match = actualAmount >= minAcceptable && actualAmount <= maxAcceptable;

  return {
    match,
    difference: Math.round(difference),
    percentDiff: Math.round(percentDiff * 100) / 100,
    minAcceptable: Math.round(minAcceptable),
    maxAcceptable: Math.round(maxAcceptable),
    reason: match ? null : `Amount ${actualAmount} outside tolerance range [${Math.round(minAcceptable)}, ${Math.round(maxAcceptable)}]`
  };
}

module.exports = {
  convertToKHR,
  formatCurrency,
  verifyAmount,
  USD_TO_KHR_RATE
};
