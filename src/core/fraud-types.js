'use strict';

/**
 * Fraud type / rejection reason constants shared across the OCR verification pipeline.
 * Values are persisted to MongoDB — do NOT change the string values.
 */
const FRAUD_TYPES = Object.freeze({
  // Date-related
  MISSING_DATE:          'MISSING_DATE',
  INVALID_DATE:          'INVALID_DATE',
  FUTURE_DATE:           'FUTURE_DATE',
  OLD_SCREENSHOT:        'OLD_SCREENSHOT',

  // Transaction-related
  DUPLICATE_TRANSACTION: 'DUPLICATE_TRANSACTION',
  USED_TRANSACTION_ID:   'USED_TRANSACTION_ID',

  // Recipient / image quality
  WRONG_RECIPIENT:       'WRONG_RECIPIENT',
  NOT_BANK_STATEMENT:    'NOT_BANK_STATEMENT',
  BLURRY:                'BLURRY',

  // Pending-review reasons (not strictly fraud, stored in same field)
  AMOUNT_MISMATCH:          'AMOUNT_MISMATCH',
  REQUIRES_GPT_JUDGMENT:    'REQUIRES_GPT_JUDGMENT',
  RECIPIENT_UNVERIFIABLE:   'RECIPIENT_UNVERIFIABLE',
});

module.exports = { FRAUD_TYPES };
