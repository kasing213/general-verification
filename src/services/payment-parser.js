'use strict';

/**
 * Payment Data Parser
 * Extracts structured payment information from OCR text
 * Handles Cambodian bank statement formats
 */
class PaymentDataParser {
  constructor() {
    // Flexible amount pattern: handles "28,000", "28000", "28 000", OCR artifacts
    const AMOUNT_PATTERN = /(-?\d[\d,.\s]*\d(?:\.\d{1,2})?)\s*(KHR|USD|៛|\$)/i;

    // Bank-specific patterns
    this.bankPatterns = {
      'ABA Bank': {
        transactionId: /(?:Trx\.?\s*ID|Transaction\s*ID)[\s:]*([A-Z0-9]+)/i,
        amount: /(?:Original\s*amount|Amount|CT|Transf[ea]r)[\s\S]*?(-?\d[\d,.\s]*\d(?:\.\d{1,2})?)\s*(KHR|USD|៛|\$)/i,
        account: /(?:To\s*account|Account)[\s:]*([0-9\s\-]+)/i,
        recipientName: /(?:To|Beneficiary)[\s:]*([A-Za-z\u1780-\u17FF][A-Za-z\u1780-\u17FF\s\.&\-,']{1,})/i,
        date: /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
        reference: /(?:Ref|Reference)[\s:]*([A-Z0-9]+)/i
      },
      'ACLEDA': {
        transactionId: /(?:Transaction\s*ID|TXN\s*ID)[\s:]*([A-Z0-9]+)/i,
        amount: /(?:Amount|Total)[\s:]*(-?\d[\d,.\s]*\d(?:\.\d{1,2})?)\s*(KHR|USD|៛|\$)/i,
        account: /(?:Account\s*No|To\s*Account)[\s:]*([0-9\s\-]+)/i,
        recipientName: /(?:Account\s*Name|Recipient)[\s:]*([A-Za-z\u1780-\u17FF][A-Za-z\u1780-\u17FF\s\.&\-,']{1,})/i,
        date: /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
        success: /(?:រួចរាល់|Completed|Success)/i
      },
      'Wing': {
        transactionId: /(?:Transaction\s*ID)[\s:]*([A-Z0-9]+)/i,
        amount: /(?:Amount)[\s:]*(-?\d[\d,.\s]*\d(?:\.\d{1,2})?)\s*(KHR|USD|៛|\$)/i,
        account: /(?:To)[\s:]*([0-9\s\-]+)/i,
        recipientName: /(?:Name)[\s:]*([A-Za-z\u1780-\u17FF][A-Za-z\u1780-\u17FF\s\.&\-,']{1,})/i,
        date: /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/
      }
    };

    // Generic patterns for unknown banks (flexible for OCR artifacts)
    this.genericPatterns = {
      amount: /(?:Original\s*amount|Amount|Total|CT|Transf[ea]r)[\s\S]*?(-?\d[\d,.\s]*\d(?:\.\d{1,2})?)\s*(KHR|USD|៛|\$)/i,
      transactionId: /(?:Trx\.?\s*ID|Transaction\s*ID|TXN\s*ID|ID|Reference)[\s:]*([A-Z0-9]{6,})/i,
      account: /(?:To\s*account|Account\s*No|Account|To)[\s:]*([0-9\s\-]{6,})/i,
      recipientName: /(?:To|Recipient|Beneficiary|Account\s*Name|Name)[\s:]*([A-Za-z\u1780-\u17FF][A-Za-z\u1780-\u17FF\s\.&\-,']{1,})/i,
      bankName: /(ABA\s*(?:Bank)?|ACLEDA|Wing|Prince\s*Bank|Canadia|Sathapana|KHQR|Bakong)/i,
      date: /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
      reference: /(?:Ref|Reference|Remark)[\s:]*([A-Z0-9]+)/i
    };

    // Currency mappings
    this.currencyMap = {
      'KHR': 'KHR',
      'USD': 'USD',
      '៛': 'KHR',
      '$': 'USD'
    };
  }

  /**
   * Parse payment data from OCR text
   * @param {string} ocrText - Raw OCR text
   * @param {string} bankName - Optional bank name hint
   * @returns {object} - Parsed payment data
   */
  parsePaymentData(ocrText, bankName = null) {
    if (!ocrText || typeof ocrText !== 'string') {
      return this.createEmptyResult();
    }

    const cleanText = this.preprocessText(ocrText);
    const detectedBank = bankName || this.detectBank(cleanText);
    const patterns = this.getBankPatterns(detectedBank);

    // Extract basic fields first
    const bankNameField = detectedBank;
    const amountField = this.extractAmount(cleanText, patterns);
    const currencyField = this.extractCurrency(cleanText, patterns);
    const transactionIdField = this.extractField(cleanText, patterns.transactionId);
    const toAccountField = this.extractAccount(cleanText, patterns);
    const recipientNameField = this.extractRecipientName(cleanText, patterns);
    const transactionDateField = this.extractDate(cleanText, patterns);
    const referenceNumberField = this.extractField(cleanText, patterns.reference || this.genericPatterns.reference);
    const isPaidField = this.detectPaymentStatus(cleanText, detectedBank);

    // Create extracted object
    const extracted = {
      bankName: bankNameField,
      amount: amountField,
      currency: currencyField,
      transactionId: transactionIdField,
      toAccount: toAccountField,
      recipientName: recipientNameField,
      transactionDate: transactionDateField,
      referenceNumber: referenceNumberField,
      isBankStatement: true,
      isPaid: isPaidField
    };

    // Calculate confidence after object is created
    extracted.confidence = this.calculateConfidence(cleanText, extracted);

    // Validate required fields
    extracted.isBankStatement = this.validateBankStatement(extracted);
    extracted.confidence = this.adjustConfidence(extracted);

    return extracted;
  }

  /**
   * Preprocess OCR text for better parsing
   * @param {string} text - Raw OCR text
   * @returns {string} - Cleaned text
   */
  preprocessText(text) {
    return text
      .replace(/\s+/g, ' ')           // Normalize whitespace
      .replace(/[^\w\s\.\-,:\$៛]/g, ' ')  // Remove special chars except currency
      .replace(/(\d)\s+(\d)/g, '$1$2') // Join split numbers
      .trim();
  }

  /**
   * Detect bank from OCR text
   * @param {string} text - OCR text
   * @returns {string} - Bank name
   */
  detectBank(text) {
    const bankMatch = text.match(this.genericPatterns.bankName);
    if (bankMatch) {
      const detected = bankMatch[1].replace(/\s+/g, ' ').trim();

      // Normalize bank names
      if (detected.includes('ABA')) return 'ABA Bank';
      if (detected.includes('ACLEDA')) return 'ACLEDA';
      if (detected.includes('Wing')) return 'Wing';
      if (detected.includes('Prince')) return 'Prince Bank';
      if (detected.includes('Canadia')) return 'Canadia Bank';
      if (detected.includes('Sathapana')) return 'Sathapana Bank';

      return detected;
    }
    return null;
  }

  /**
   * Get patterns for specific bank
   * @param {string} bankName - Bank name
   * @returns {object} - Regex patterns
   */
  getBankPatterns(bankName) {
    if (bankName && this.bankPatterns[bankName]) {
      return { ...this.genericPatterns, ...this.bankPatterns[bankName] };
    }
    return this.genericPatterns;
  }

  /**
   * Extract amount from text
   * @param {string} text - OCR text
   * @param {object} patterns - Regex patterns
   * @returns {number} - Amount as positive number
   */
  extractAmount(text, patterns) {
    const match = text.match(patterns.amount);
    if (match) {
      const amount = this.normalizeAmount(match[1]);
      if (amount > 0) return amount;
    }

    // Fallback: match standalone amount + currency (no prefix keyword required)
    const fallback = text.match(/(-?\d[\d,.\s]*\d(?:\.\d{1,2})?)\s*(KHR|USD|៛|\$)/i);
    if (fallback) {
      const amount = this.normalizeAmount(fallback[1]);
      if (amount > 0) return amount;
    }

    return null;
  }

  /**
   * Normalize amount string — handles OCR artifacts, format variations
   * "28,000" → 28000, "28.000,50" → 28000.50, "28OOO" → 28000
   */
  normalizeAmount(amountStr) {
    if (typeof amountStr === 'number') return Math.abs(amountStr);

    let cleaned = String(amountStr)
      .replace(/\s/g, '')             // remove spaces
      .replace(/O/g, '0')             // OCR: letter O → zero
      .replace(/o/g, '0')
      .replace(/l(?=\d)/g, '1')       // OCR: lowercase L before digit → one
      .replace(/[^\d.,\-]/g, '');     // keep only digits, dots, commas, minus

    // Handle EU format "28.000,50" vs US format "28,000.50"
    if (/,\d{1,2}$/.test(cleaned) && /\.\d{3}/.test(cleaned)) {
      // EU format: dots are thousands, comma is decimal
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // US/Cambodia format: commas are thousands
      cleaned = cleaned.replace(/,/g, '');
    }

    return Math.abs(parseFloat(cleaned)) || 0;
  }

  /**
   * Extract currency from text
   * @param {string} text - OCR text
   * @param {object} patterns - Regex patterns
   * @returns {string} - Currency code
   */
  extractCurrency(text, patterns) {
    const match = text.match(patterns.amount);
    if (match && match[2]) {
      const currency = match[2].trim();
      return this.currencyMap[currency] || currency;
    }

    // Try standalone amount + currency fallback
    const fallback = text.match(/(-?\d[\d,.\s]*\d(?:\.\d{1,2})?)\s*(KHR|USD|៛|\$)/i);
    if (fallback && fallback[2]) {
      const currency = fallback[2].trim();
      return this.currencyMap[currency] || currency;
    }

    // Look for standalone currency symbols
    if (text.includes('KHR') || text.includes('៛')) return 'KHR';
    if (text.includes('USD') || text.includes('$')) return 'USD';

    return 'KHR'; // Default to KHR for Cambodia
  }

  /**
   * Extract account number
   * @param {string} text - OCR text
   * @param {object} patterns - Regex patterns
   * @returns {string} - Account number
   */
  extractAccount(text, patterns) {
    const match = text.match(patterns.account);
    if (match) {
      return match[1].trim().replace(/\s+/g, ' ');
    }
    return null;
  }

  /**
   * Extract recipient name
   * @param {string} text - OCR text
   * @param {object} patterns - Regex patterns
   * @returns {string} - Recipient name
   */
  extractRecipientName(text, patterns) {
    const match = text.match(patterns.recipientName);
    if (match) {
      const name = match[1].trim();

      // Clean up common OCR artifacts — preserve Khmer script
      return name
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s\.&\u1780-\u17FF\u19E0-\u19FF\-,']/g, '')
        .trim();
    }
    return null;
  }

  /**
   * Extract date from text
   * @param {string} text - OCR text
   * @param {object} patterns - Regex patterns
   * @returns {string} - Date string
   */
  extractDate(text, patterns) {
    // Try standard DD/MM/YYYY regex first
    const match = text.match(patterns.date);
    if (match) {
      return match[1].trim();
    }

    // Fallback 1: scan for Khmer or English month names in OCR text
    const monthDate = this.extractMonthNameDate(text);
    if (monthDate) return monthDate;

    // Fallback 2: Khmer-digit slash dates (no month name, just digits with separators)
    const { extractNumbers } = require('../core/khmer-date');
    const slashPattern = /([\d\u17E0-\u17E9]{1,4}[\/\-][\d\u17E0-\u17E9]{1,2}[\/\-][\d\u17E0-\u17E9]{2,4})/;
    const slashMatch = text.match(slashPattern);
    if (slashMatch && extractNumbers(slashMatch[1]).length >= 3) {
      return slashMatch[1].trim();
    }

    return null;
  }

  /**
   * Extract date by finding a month name (Khmer or English) in OCR text.
   * Returns a context substring that parseKhmerDate() can handle.
   * @param {string} text - Full OCR text
   * @returns {string|null} - Date substring or null
   */
  extractMonthNameDate(text) {
    const { findMonth, extractNumbers } = require('../core/khmer-date');

    // Scan raw text for month name (Khmer or English) — no conversion needed
    const monthResult = findMonth(text);
    if (!monthResult) return null;

    // Extract ~30 char context window around the month match
    const start = Math.max(0, monthResult.index - 15);
    const end = Math.min(text.length, monthResult.index + monthResult.match.length + 15);
    const context = text.substring(start, end).trim();

    // Must have at least one number nearby (Arabic or Khmer digits)
    if (extractNumbers(context).length > 0) {
      return context;
    }

    return null;
  }

  /**
   * Extract generic field
   * @param {string} text - OCR text
   * @param {RegExp} pattern - Regex pattern
   * @returns {string} - Extracted field
   */
  extractField(text, pattern) {
    if (!pattern) return null;

    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  /**
   * Detect if payment is completed
   * @param {string} text - OCR text
   * @param {string} bankName - Bank name
   * @returns {boolean} - Payment status
   */
  detectPaymentStatus(text, bankName) {
    const successPatterns = [
      /Success/i,
      /Completed/i,
      /រួចរាល់/i,
      /ជោគជ័យ/i,
      /✓/,
      /checkmark/i
    ];

    // For ABA Bank, look for CT (Customer Transfer) or Trx. ID pattern
    if (bankName === 'ABA Bank' && (/CT.*-?\d+/.test(text) || /Trx\.?\s*ID/i.test(text))) {
      return true;
    }

    return successPatterns.some(pattern => pattern.test(text));
  }

  /**
   * Validate if text looks like a bank statement
   * @param {object} extracted - Extracted data
   * @returns {boolean} - Is bank statement
   */
  validateBankStatement(extracted) {
    // Must have at least amount and some identifier
    const hasAmount = extracted.amount !== null;
    const hasIdentifier = extracted.transactionId || extracted.toAccount || extracted.recipientName;
    const hasBankIndicator = extracted.bankName !== null;

    return hasAmount && hasIdentifier && hasBankIndicator;
  }

  /**
   * Calculate extraction confidence
   * @param {string} text - Original text
   * @param {object} extracted - Extracted data
   * @returns {string} - Confidence level
   */
  calculateConfidence(text, extracted) {
    let score = 0;

    // Amount: validate it's a real number, not OCR garbage
    if (extracted.amount !== null && extracted.amount > 0) {
      score += 25;
    } else if (extracted.amount !== null) {
      score += 5; // present but suspicious
    }

    // Transaction ID: must be alphanumeric, 5+ chars
    if (extracted.transactionId && /^[A-Za-z0-9\-]{5,}$/.test(extracted.transactionId)) {
      score += 20;
    } else if (extracted.transactionId) {
      score += 5;
    }

    if (extracted.bankName) score += 15;

    // Account: must have digits
    if (extracted.toAccount && /\d{4,}/.test(extracted.toAccount.replace(/[\s\-]/g, ''))) {
      score += 15;
    } else if (extracted.toAccount) {
      score += 5;
    }

    if (extracted.recipientName) score += 15;
    if (extracted.transactionDate) score += 10;

    if (score >= 85) return 'high';
    if (score >= 65) return 'medium';
    return 'low';
  }

  /**
   * Adjust confidence based on validation
   * @param {object} extracted - Extracted data
   * @returns {string} - Adjusted confidence
   */
  adjustConfidence(extracted) {
    const originalConfidence = extracted.confidence;

    // Lower confidence if missing critical fields
    if (!extracted.isBankStatement) return 'low';
    if (!extracted.isPaid) return 'low';
    if (!extracted.amount || !extracted.bankName) return 'low';

    return originalConfidence;
  }

  /**
   * Create empty result structure
   * @returns {object} - Empty payment data
   */
  createEmptyResult() {
    return {
      isBankStatement: false,
      isPaid: false,
      amount: null,
      currency: null,
      transactionId: null,
      transactionDate: null,
      fromAccount: null,
      toAccount: null,
      recipientName: null,
      bankName: null,
      referenceNumber: null,
      remark: null,
      confidence: 'low'
    };
  }
}

module.exports = PaymentDataParser;