'use strict';

/**
 * Bank-Specific Field Extractor
 *
 * Second-pass sharpener that runs over OCR text AFTER initial GPT-4o extraction.
 * Uses bank-specific anchored regex patterns to extract fields with high
 * positional confidence. Mirrors scriptclient's "Bank format extraction" pattern
 * (the source of its 0.90-confidence wins on ABA payments).
 *
 * Each rule returns { value, confidence } so callers can decide whether to
 * override a weaker initial extraction.
 */

const BANK_PATTERNS = {
  'ABA Bank': {
    transactionId: {
      patterns: [
        /Trx\.?\s*ID[\s:]*([A-Z0-9]{12,24})/i,
        /\b(100FT[0-9A-Z]{10,15})\b/,
        /\b(FT[0-9A-Z]{14,18})\b/,
      ],
      confidence: 0.95,
      validate: (v) => /^[A-Z0-9]{12,24}$/.test(v) && /[A-Z]/.test(v),
    },
    amount: {
      patterns: [
        /CT\s*[\-\s]*(-?[\d,]+(?:\.\d{1,2})?)\s*(KHR|USD)/i,
        /Original\s*amount[^\d-]*(-?[\d,]+(?:\.\d{1,2})?)\s*(KHR|USD)/i,
        /Amount[^\d-]*(-?[\d,]+(?:\.\d{1,2})?)\s*(KHR|USD)/i,
      ],
      confidence: 0.9,
    },
    toAccount: {
      patterns: [
        /To\s*account[\s:]*([0-9][\d\s\-]{7,14})/i,
        /Account[\s:]*([0-9][\d\s\-]{7,14})/i,
      ],
      confidence: 0.9,
      validate: (v) => v.replace(/\D/g, '').length === 9,
    },
    recipientName: {
      patterns: [
        /(?:To|Beneficiary)[\s:]+([A-Z][A-Z\s\.&]{4,40}(?:&\s*[A-Z][A-Z\s\.]{2,30})?)/,
      ],
      confidence: 0.85,
    },
  },

  'Wing': {
    transactionId: {
      patterns: [
        /Transaction\s*ID[\s:]*([A-Z0-9]{15,25})/i,
        /\b([A-Z0-9]{15,25})\b/,
      ],
      confidence: 0.85,
      validate: (v) => v.length >= 15 && /[A-Z]/.test(v),
    },
    toAccount: {
      patterns: [
        /To[\s:]+([0-9]{8,12})\b/,
        /Account[\s:]*([0-9]{8,12})\b/i,
        /\b(0[0-9]{7,11})\b/,
      ],
      confidence: 0.85,
      validate: (v) => /^\d{8,12}$/.test(v.replace(/\D/g, '')),
    },
    amount: {
      patterns: [
        /Amount[^\d-]*(-?[\d,]+(?:\.\d{1,2})?)\s*(KHR|USD)/i,
        /(-?[\d,]+(?:\.\d{1,2})?)\s*(KHR|USD)/i,
      ],
      confidence: 0.8,
    },
  },

  'ACLEDA': {
    transactionId: {
      patterns: [
        /TXN\s*ID[\s:]*([A-Z0-9]{12,20})/i,
        /Transaction\s*ID[\s:]*([A-Z0-9]{12,20})/i,
        /Reference\s*No\.?[\s:]*([A-Z0-9]{12,20})/i,
      ],
      confidence: 0.9,
      validate: (v) => v.length >= 12,
    },
    toAccount: {
      patterns: [
        /(?:Account\s*No|To\s*Account)[\s:]*([0-9][\d\s\-]{8,14})/i,
      ],
      confidence: 0.9,
      validate: (v) => {
        const d = v.replace(/\D/g, '');
        return d.length >= 10 && d.length <= 13;
      },
    },
    amount: {
      patterns: [
        /Amount[^\d-]*(-?[\d,]+(?:\.\d{1,2})?)\s*(KHR|USD)/i,
        /Total[^\d-]*(-?[\d,]+(?:\.\d{1,2})?)\s*(KHR|USD)/i,
      ],
      confidence: 0.85,
    },
  },

  'Canadia Bank': {
    transactionId: {
      patterns: [
        /(?:Reference|Transaction\s*ID|TXN)[\s:]*([A-Z0-9]{12,20})/i,
      ],
      confidence: 0.85,
    },
    toAccount: {
      patterns: [
        /(?:Account|To)[\s:]*([0-9][\d\s\-]{9,12})/i,
      ],
      confidence: 0.85,
      validate: (v) => {
        const d = v.replace(/\D/g, '');
        return d.length >= 10 && d.length <= 12;
      },
    },
  },

  'Prince Bank': {
    transactionId: {
      patterns: [
        /(?:Reference|Transaction|Trx)[\s:]*([A-Z0-9]{12,20})/i,
      ],
      confidence: 0.85,
    },
    toAccount: {
      patterns: [
        /(?:Account|To)[\s:]*([0-9][\d\s\-]{9,14})/i,
      ],
      confidence: 0.85,
    },
  },

  'Sathapana Bank': {
    transactionId: {
      patterns: [
        /(?:Reference|Transaction|Trx)[\s:]*([A-Z0-9]{12,20})/i,
      ],
      confidence: 0.85,
    },
    toAccount: {
      patterns: [
        /(?:Account|To)[\s:]*([0-9][\d\s\-]{9,14})/i,
      ],
      confidence: 0.85,
    },
  },
};

/**
 * Extract bank-specific fields from raw OCR text.
 * @param {string} text - Raw OCR text (from GPT-4o rawText, PaddleOCR, or Tesseract)
 * @param {string} bankName - Detected bank name (e.g. 'ABA Bank')
 * @returns {{ fields: object, applied: boolean, bank: string }}
 *   fields = { transactionId?: {value, currency?, confidence}, amount?: {...}, toAccount?: {...}, recipientName?: {...} }
 */
function extractBankFields(text, bankName) {
  if (!text || !bankName) return { fields: {}, applied: false, bank: bankName };
  const rules = BANK_PATTERNS[bankName];
  if (!rules) return { fields: {}, applied: false, bank: bankName };

  const fields = {};
  for (const [fieldName, rule] of Object.entries(rules)) {
    for (const pattern of rule.patterns) {
      const match = text.match(pattern);
      if (!match || !match[1]) continue;

      const value = match[1].trim();
      if (rule.validate && !rule.validate(value)) continue;

      const result = { value, confidence: rule.confidence };
      if (match[2]) result.currency = match[2];
      fields[fieldName] = result;
      break; // first matching pattern per field wins
    }
  }

  return {
    fields,
    applied: Object.keys(fields).length > 0,
    bank: bankName,
  };
}

/**
 * Apply extractor results onto an existing payment data object.
 * Override weak/missing fields with bank-extracted values when extractor confidence is high.
 * @param {object} paymentData - Existing extracted data (mutated)
 * @param {object} extractorResult - Output of extractBankFields()
 * @returns {string[]} - List of field names that were overridden
 */
function applyToPayment(paymentData, extractorResult) {
  const overridden = [];
  if (!extractorResult || !extractorResult.applied) return overridden;

  const { fields } = extractorResult;

  // transactionId: override if missing OR if extractor has high confidence and gpt's looks weak (pure digits)
  if (fields.transactionId) {
    const gptId = paymentData.transactionId;
    const extId = fields.transactionId.value;
    const gptIsWeak = !gptId || (/^\d+$/.test(gptId.replace(/[\s\-]/g, '')) && gptId.replace(/[\s\-]/g, '').length <= 13);
    if (gptIsWeak && fields.transactionId.confidence >= 0.85) {
      paymentData.transactionId = extId;
      overridden.push('transactionId');
    }
  }

  // amount: override only if missing (don't fight a parsed number)
  if (fields.amount && !paymentData.amount) {
    const cleaned = String(fields.amount.value).replace(/[,\s]/g, '');
    const parsed = parseFloat(cleaned);
    if (parsed > 0) {
      paymentData.amount = Math.abs(parsed);
      if (fields.amount.currency && !paymentData.currency) {
        paymentData.currency = fields.amount.currency;
      }
      overridden.push('amount');
    }
  }

  // toAccount: override if missing OR if extractor's normalized version is more specific
  if (fields.toAccount && !paymentData.toAccount) {
    paymentData.toAccount = fields.toAccount.value.replace(/[\s\-]/g, '');
    overridden.push('toAccount');
  }

  // recipientName: override only if missing
  if (fields.recipientName && !paymentData.recipientName) {
    paymentData.recipientName = fields.recipientName.value;
    overridden.push('recipientName');
  }

  return overridden;
}

module.exports = {
  extractBankFields,
  applyToPayment,
  BANK_PATTERNS,
};
