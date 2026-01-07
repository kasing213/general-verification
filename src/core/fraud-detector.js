'use strict';

const { v4: uuidv4 } = require('uuid');
const { parseKhmerDate } = require('./khmer-date');

/**
 * Validates transaction date and checks for screenshot age fraud
 * @param {string} transactionDateStr - Transaction date from OCR
 * @param {Date} uploadedAt - When screenshot was uploaded
 * @param {number} maxAgeDays - Maximum allowed age in days
 * @returns {object} - { isValid, fraudType, ageDays, parsedDate, reason }
 */
function validateTransactionDate(transactionDateStr, uploadedAt, maxAgeDays = 7) {
  const result = {
    isValid: true,
    fraudType: null,
    ageDays: null,
    parsedDate: null,
    reason: null
  };

  // Check 1: Missing transaction date
  if (!transactionDateStr || transactionDateStr === 'null' || transactionDateStr === 'undefined') {
    result.isValid = false;
    result.fraudType = 'MISSING_DATE';
    result.reason = 'Transaction date not found in screenshot';
    return result;
  }

  // Check 2: Parse transaction date (supports both English and Khmer formats)
  let transactionDate;
  try {
    transactionDate = parseKhmerDate(transactionDateStr);

    if (!transactionDate || isNaN(transactionDate.getTime())) {
      result.isValid = false;
      result.fraudType = 'INVALID_DATE';
      result.reason = `Invalid date format: ${transactionDateStr}`;
      return result;
    }

    result.parsedDate = transactionDate;
    console.log(`Parsed date: "${transactionDateStr}" -> ${transactionDate.toISOString()}`);
  } catch (error) {
    result.isValid = false;
    result.fraudType = 'INVALID_DATE';
    result.reason = `Failed to parse date: ${transactionDateStr}`;
    return result;
  }

  // Check 3: Future date detection
  if (transactionDate > uploadedAt) {
    const futureDays = Math.ceil((transactionDate - uploadedAt) / (1000 * 60 * 60 * 24));
    result.isValid = false;
    result.fraudType = 'FUTURE_DATE';
    result.ageDays = -futureDays;
    result.reason = `Transaction date is ${futureDays} days in the future`;
    return result;
  }

  // Check 4: Old screenshot detection
  const ageDays = (uploadedAt - transactionDate) / (1000 * 60 * 60 * 24);
  result.ageDays = Math.floor(ageDays);

  if (ageDays > maxAgeDays) {
    result.isValid = false;
    result.fraudType = 'OLD_SCREENSHOT';
    result.reason = `Screenshot is ${Math.floor(ageDays)} days old (max allowed: ${maxAgeDays} days)`;
    return result;
  }

  return result;
}

/**
 * Creates fraud alert record object
 * @param {object} fraudData - Fraud detection data
 * @returns {object} - Fraud alert record
 */
function createFraudAlertRecord(fraudData) {
  const alertId = `FA-${new Date().toISOString().split('T')[0].replace(/-/g, '')}-${Date.now().toString().slice(-6)}`;

  return {
    _id: uuidv4(),
    alertId: alertId,

    // Fraud details
    fraudType: fraudData.fraudType,
    detectedAt: new Date(),
    severity: fraudData.severity || 'MEDIUM',

    // Payment reference
    paymentId: fraudData.paymentId || null,
    invoiceId: fraudData.invoiceId || null,
    customerId: fraudData.customerId || null,

    // Evidence
    transactionDate: fraudData.transactionDate,
    uploadedAt: fraudData.uploadedAt,
    screenshotAgeDays: fraudData.screenshotAgeDays,
    maxAllowedAgeDays: fraudData.maxAllowedAgeDays || 7,

    transactionId: fraudData.transactionId || null,
    referenceNumber: fraudData.referenceNumber || null,
    amount: fraudData.amount || null,
    currency: fraudData.currency || null,
    bankName: fraudData.bankName || null,

    screenshotPath: fraudData.screenshotPath,

    // Review status
    reviewStatus: 'PENDING',
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,

    // Additional context
    verificationNotes: fraudData.verificationNotes,
    confidence: fraudData.confidence,

    // Resolution
    actionTaken: fraudData.actionTaken || 'HELD_FOR_REVIEW',
    resolutionDate: null
  };
}

/**
 * Determines severity based on fraud type
 * @param {string} fraudType - Type of fraud detected
 * @param {object} context - Additional context (ageDays, etc.)
 * @returns {string} - 'LOW', 'MEDIUM', 'HIGH', or 'CRITICAL'
 */
function determineSeverity(fraudType, context = {}) {
  switch (fraudType) {
    case 'DUPLICATE_TRANSACTION':
      return 'CRITICAL';
    case 'OLD_SCREENSHOT':
      return context.ageDays > 30 ? 'HIGH' : 'MEDIUM';
    case 'FUTURE_DATE':
      return 'HIGH';
    case 'INVALID_DATE':
      return 'MEDIUM';
    case 'MISSING_DATE':
      return 'LOW';
    case 'WRONG_RECIPIENT':
      return 'HIGH';
    default:
      return 'MEDIUM';
  }
}

module.exports = {
  validateTransactionDate,
  createFraudAlertRecord,
  determineSeverity
};
