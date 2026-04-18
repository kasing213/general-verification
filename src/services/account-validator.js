'use strict';

/**
 * Account Number Format Validator
 *
 * Per-bank length rules used to reject false-positive account extractions
 * (e.g., a 10-digit phone number extracted when the bank uses 9-digit accounts).
 * Synchronous — no I/O. Always available.
 */

const ACCOUNT_RULES = {
  'ABA Bank':       { minDigits: 9,  maxDigits: 9,  description: '9 digits' },
  'Wing':           { minDigits: 8,  maxDigits: 12, description: '8-12 digits (mobile or account)' },
  'ACLEDA':         { minDigits: 10, maxDigits: 13, description: '10-13 digits' },
  'Canadia Bank':   { minDigits: 10, maxDigits: 12, description: '10-12 digits' },
  'Prince Bank':    { minDigits: 10, maxDigits: 14, description: '10-14 digits' },
  'Sathapana Bank': { minDigits: 10, maxDigits: 14, description: '10-14 digits' },
};

function validateAccountFormat(account, bankName) {
  if (account === null || account === undefined || String(account).trim() === '') {
    return { valid: false, confidence: 0, reason: 'no account provided', normalized: '' };
  }

  const normalized = String(account).replace(/[\s\-\.\(\)]/g, '');
  const rule = ACCOUNT_RULES[bankName];

  if (!rule) {
    return { valid: true, confidence: 0.5, reason: 'unknown bank, no validation applied', normalized };
  }

  if (!/^\d+$/.test(normalized)) {
    return { valid: false, confidence: 0.2, reason: 'contains non-digit characters', normalized };
  }

  if (normalized.length >= rule.minDigits && normalized.length <= rule.maxDigits) {
    return {
      valid: true,
      confidence: 0.95,
      reason: `Matches ${bankName} format (${normalized.length} digits, expected ${rule.description})`,
      normalized,
    };
  }

  return {
    valid: false,
    confidence: 0.3,
    reason: `Length ${normalized.length} does not match ${bankName} (expected ${rule.description})`,
    normalized,
  };
}

function isAvailable() {
  return true;
}

module.exports = {
  validateAccountFormat,
  isAvailable,
  ACCOUNT_RULES,
};
