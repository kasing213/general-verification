'use strict';

/**
 * Payment Data Parser
 * Extracts structured payment information from OCR text
 * Handles Cambodian bank statement formats
 */
class PaymentDataParser {
  constructor() {
    // Bank-specific patterns
    this.bankPatterns = {
      'ABA Bank': {
        transactionId: /(?:Trx\.?\s*ID|Transaction\s*ID)[\s:]*([A-Z0-9]+)/i,
        amount: /(?:CT|Transfer)[\s\S]*?(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(KHR|USD)/i,
        account: /(?:To\s*account|Account)[\s:]*([0-9\s\-]+)/i,
        recipientName: /(?:To|Beneficiary)[\s:]*([A-Z\s\.&]+)/i,
        date: /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
        reference: /(?:Ref|Reference)[\s:]*([A-Z0-9]+)/i
      },
      'ACLEDA': {
        transactionId: /(?:Transaction\s*ID|TXN\s*ID)[\s:]*([A-Z0-9]+)/i,
        amount: /(?:Amount|Total)[\s:]*(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(KHR|USD)/i,
        account: /(?:Account\s*No|To\s*Account)[\s:]*([0-9\s\-]+)/i,
        recipientName: /(?:Account\s*Name|Recipient)[\s:]*([A-Z\s\.&]+)/i,
        date: /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
        success: /(?:រួចរាល់|Completed|Success)/i
      },
      'Wing': {
        transactionId: /(?:Transaction\s*ID)[\s:]*([A-Z0-9]+)/i,
        amount: /(?:Amount)[\s:]*(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(KHR|USD)/i,
        account: /(?:To)[\s:]*([0-9\s\-]+)/i,
        recipientName: /(?:Name)[\s:]*([A-Z\s\.&]+)/i,
        date: /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/
      }
    };

    // Generic patterns for unknown banks
    this.genericPatterns = {
      amount: /(?:Amount|Total|CT|Transfer)[\s\S]*?(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(KHR|USD|៛|\$)/i,
      transactionId: /(?:Trx\.?\s*ID|Transaction\s*ID|TXN\s*ID|ID|Reference)[\s:]*([A-Z0-9]{6,})/i,
      account: /(?:To\s*account|Account\s*No|Account|To)[\s:]*([0-9\s\-]{6,})/i,
      recipientName: /(?:To|Recipient|Beneficiary|Account\s*Name|Name)[\s:]*([A-Z][A-Z\s\.&]{2,})/i,
      bankName: /(ABA\s*Bank|ACLEDA|Wing|Prince\s*Bank|Canadia|Sathapana)/i,
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
      return { ...this.bankPatterns[bankName], ...this.genericPatterns };
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
      const amountStr = match[1].replace(/,/g, '');
      const amount = parseFloat(amountStr);
      return Math.abs(amount); // Always return positive amount
    }
    return null;
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

      // Clean up common OCR artifacts
      return name
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s\.&]/g, '')
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
    const match = text.match(patterns.date);
    if (match) {
      return match[1].trim();
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

    // For ABA Bank, look for CT (Customer Transfer) pattern
    if (bankName === 'ABA Bank' && /CT.*-\d+/.test(text)) {
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

    if (extracted.amount !== null) score += 25;
    if (extracted.transactionId) score += 20;
    if (extracted.bankName) score += 15;
    if (extracted.toAccount) score += 15;
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