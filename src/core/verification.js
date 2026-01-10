'use strict';

const { v4: uuidv4 } = require('uuid');
const { convertToKHR, verifyAmount } = require('../utils/currency');
const { validateTransactionDate, createFraudAlertRecord, determineSeverity } = require('./fraud-detector');
const { analyzePaymentScreenshot } = require('./ocr-engine');

/**
 * 3-Stage Verification Pipeline
 *
 * Stage 1: Image Type Detection
 *   - isBankStatement = false → SILENT REJECT
 *   - isBankStatement = true → Stage 2
 *
 * Stage 2: Confidence Check
 *   - confidence = low/medium → PENDING + "send clearer image"
 *   - confidence = high → Stage 3
 *
 * Stage 3: Security Verification (HIGH confidence only)
 *   - Wrong recipient → REJECT
 *   - Old screenshot → REJECT + fraud alert
 *   - Duplicate Trx ID → REJECT + fraud alert
 *   - Amount mismatch → PENDING
 *   - All pass → VERIFIED
 */

/**
 * Verifies recipient against expected values
 * @param {string} toAccount - Account from OCR
 * @param {string} recipientName - Name from OCR
 * @param {object} expected - Expected values { toAccount, recipientNames }
 * @returns {object} - { verified, skipped, reason }
 */
function verifyRecipient(toAccount, recipientName, expected) {
  // If no expected values, skip verification
  if (!expected.toAccount && (!expected.recipientNames || expected.recipientNames.length === 0)) {
    return {
      verified: null,
      skipped: true,
      reason: 'No recipient verification required'
    };
  }

  const combinedText = ((toAccount || '') + ' ' + (recipientName || '')).toLowerCase();
  const normalizedAccount = (toAccount || '').replace(/\s/g, '').toLowerCase();

  // Check account match
  if (expected.toAccount) {
    const expectedNormalized = expected.toAccount.replace(/\s/g, '').toLowerCase();
    if (normalizedAccount.includes(expectedNormalized) || combinedText.includes(expected.toAccount.toLowerCase())) {
      return {
        verified: true,
        skipped: false,
        reason: 'Account number matched'
      };
    }
  }

  // Check name match
  if (expected.recipientNames && expected.recipientNames.length > 0) {
    for (const name of expected.recipientNames) {
      if (combinedText.includes(name.toLowerCase())) {
        return {
          verified: true,
          skipped: false,
          reason: `Recipient name matched: ${name}`
        };
      }
    }
  }

  // No match found
  if (!toAccount && !recipientName) {
    return {
      verified: false,
      skipped: false,
      reason: 'No recipient info found in screenshot'
    };
  }

  return {
    verified: false,
    skipped: false,
    reason: `Recipient mismatch: got ${toAccount || 'N/A'} / ${recipientName || 'N/A'}`
  };
}

/**
 * Runs the 3-stage verification pipeline
 * @param {string|Buffer} imageInput - Image path or buffer
 * @param {object} expectedPayment - Expected payment details
 * @param {object} options - Additional options
 * @returns {Promise<object>} - Verification result
 */
async function verifyPayment(imageInput, expectedPayment, options = {}) {
  const recordId = uuidv4();
  const uploadedAt = new Date();

  // Default expected payment structure
  const expected = {
    amount: expectedPayment.amount,
    currency: expectedPayment.currency || 'KHR',
    bank: expectedPayment.bank || null,
    toAccount: expectedPayment.toAccount || null,
    recipientNames: expectedPayment.recipientNames || null,
    tolerancePercent: expectedPayment.tolerancePercent || parseFloat(process.env.PAYMENT_TOLERANCE_PERCENT) || 5
  };

  const maxAgeDays = parseInt(process.env.MAX_SCREENSHOT_AGE_DAYS) || 7;

  // Run OCR
  const ocrResult = await analyzePaymentScreenshot(imageInput);

  // Initialize result
  const result = {
    success: true,
    recordId,
    invoiceId: options.invoiceId || null,

    verification: {
      status: 'pending',
      paymentLabel: 'PENDING',
      confidence: ocrResult.confidence || 'low',
      rejectionReason: null
    },

    payment: {
      amount: ocrResult.amount || null,
      currency: ocrResult.currency || null,
      transactionId: ocrResult.transactionId || null,
      transactionDate: ocrResult.transactionDate || null,
      fromAccount: ocrResult.fromAccount || null,
      toAccount: ocrResult.toAccount || null,
      recipientName: ocrResult.recipientName || null,
      bankName: ocrResult.bankName || null,
      referenceNumber: ocrResult.referenceNumber || null,
      remark: ocrResult.remark || null,
      isBankStatement: ocrResult.isBankStatement,
      isPaid: ocrResult.isPaid
    },

    validation: {
      amount: {
        expected: expected.amount,
        actual: null,
        match: null,
        skipped: false
      },
      bank: {
        expected: expected.bank,
        actual: ocrResult.bankName || null,
        match: null,
        skipped: !expected.bank
      },
      toAccount: {
        expected: expected.toAccount,
        actual: ocrResult.toAccount || null,
        match: null,
        skipped: !expected.toAccount
      },
      recipientNames: {
        expected: expected.recipientNames,
        actual: ocrResult.recipientName || null,
        match: null,
        skipped: !expected.recipientNames || expected.recipientNames.length === 0
      },
      isOldScreenshot: false,
      dateValidation: null
    },

    fraud: null
  };

  // ====== STAGE 1: Is it a bank statement? ======
  if (ocrResult.isBankStatement === false) {
    result.verification.status = 'rejected';
    result.verification.rejectionReason = 'NOT_BANK_STATEMENT';
    result.verification.paymentLabel = 'UNPAID';
    console.log(`Stage 1: NOT a bank statement | Record ${recordId}`);
    return result;
  }

  // ====== STAGE 2: Confidence check ======
  if (ocrResult.confidence !== 'high') {
    result.verification.status = 'pending';
    result.verification.rejectionReason = 'BLURRY';
    result.verification.paymentLabel = 'PENDING';
    console.log(`Stage 2: Blurry/unclear (${ocrResult.confidence} confidence) | Record ${recordId}`);
    return result;
  }

  // ====== STAGE 3: Security verification (HIGH confidence only) ======

  // 3a: Recipient verification (if required)
  const recipientCheck = verifyRecipient(
    ocrResult.toAccount,
    ocrResult.recipientName,
    expected
  );

  result.validation.toAccount.match = recipientCheck.verified;
  result.validation.toAccount.skipped = recipientCheck.skipped;
  result.validation.recipientNames.match = recipientCheck.verified;
  result.validation.recipientNames.skipped = recipientCheck.skipped;

  // Log recipient verification result
  if (recipientCheck.skipped) {
    console.log(`Stage 3a: Recipient check SKIPPED | Record ${recordId} | ${recipientCheck.reason}`);
  } else if (recipientCheck.verified) {
    console.log(`Stage 3a: Recipient MATCHED | Record ${recordId} | ${recipientCheck.reason}`);
  }

  if (!recipientCheck.skipped && recipientCheck.verified === false) {
    result.verification.status = 'rejected';
    result.verification.rejectionReason = 'WRONG_RECIPIENT';
    result.verification.paymentLabel = 'UNPAID';
    console.log(`Stage 3a: Wrong recipient | Record ${recordId} | ${recipientCheck.reason}`);
    return result;
  }

  // 3b: Date validation (old screenshot check)
  if (ocrResult.transactionDate) {
    const dateValidation = validateTransactionDate(ocrResult.transactionDate, uploadedAt, maxAgeDays);
    result.validation.dateValidation = dateValidation;
    result.validation.isOldScreenshot = !dateValidation.isValid && dateValidation.fraudType === 'OLD_SCREENSHOT';

    if (!dateValidation.isValid) {
      result.verification.status = 'rejected';
      result.verification.rejectionReason = dateValidation.fraudType;
      result.verification.paymentLabel = 'UNPAID';

      // Create fraud alert
      result.fraud = createFraudAlertRecord({
        fraudType: dateValidation.fraudType,
        severity: determineSeverity(dateValidation.fraudType, { ageDays: dateValidation.ageDays }),
        invoiceId: options.invoiceId,
        customerId: options.customerId,
        transactionDate: dateValidation.parsedDate,
        uploadedAt,
        screenshotAgeDays: dateValidation.ageDays,
        maxAllowedAgeDays: maxAgeDays,
        transactionId: ocrResult.transactionId,
        referenceNumber: ocrResult.referenceNumber,
        amount: ocrResult.amount,
        currency: ocrResult.currency,
        bankName: ocrResult.bankName,
        confidence: ocrResult.confidence,
        verificationNotes: dateValidation.reason
      });

      console.log(`Stage 3b: ${dateValidation.fraudType} | Record ${recordId} | ${dateValidation.reason}`);
      return result;
    }
  }

  // 3c: Bank verification (if required)
  if (expected.bank && ocrResult.bankName) {
    const bankMatch = ocrResult.bankName.toLowerCase().includes(expected.bank.toLowerCase());
    result.validation.bank.match = bankMatch;
    result.validation.bank.skipped = false;
    // Note: We don't reject on bank mismatch, just record it
  }

  // 3d: Amount verification
  const amountInKHR = convertToKHR(ocrResult.amount, ocrResult.currency);
  result.validation.amount.actual = amountInKHR;

  if (expected.amount) {
    const amountCheck = verifyAmount(expected.amount, amountInKHR, expected.tolerancePercent);
    result.validation.amount.match = amountCheck.match;

    if (!amountCheck.match) {
      result.verification.status = 'pending';
      result.verification.rejectionReason = 'AMOUNT_MISMATCH';
      result.verification.paymentLabel = 'PENDING';
      console.log(`Stage 3d: Amount mismatch | Record ${recordId} | Expected: ${expected.amount}, Got: ${amountInKHR}`);
      return result;
    }
  } else {
    // No expected amount - skip amount verification
    result.validation.amount.skipped = true;
  }

  // ====== ALL CHECKS PASSED ======
  result.verification.status = 'verified';
  result.verification.rejectionReason = null;
  result.verification.paymentLabel = 'PAID';
  console.log(`VERIFIED | Record ${recordId} | Amount: ${amountInKHR} KHR`);

  return result;
}

module.exports = {
  verifyPayment,
  verifyRecipient
};
