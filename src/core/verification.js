'use strict';

const { v4: uuidv4 } = require('uuid');
const { convertToKHR, verifyAmount } = require('../utils/currency');
const { validateTransactionDate, createFraudAlertRecord, determineSeverity } = require('./fraud-detector');
const { analyzePaymentScreenshot } = require('./ocr-engine');
const NameIntelligenceService = require('../services/name-intelligence');

// Initialize name intelligence service
const nameIntelligence = new NameIntelligenceService();

// User-facing messages for rejection reasons
const USER_MESSAGES = {
  NOT_BANK_STATEMENT: 'Please upload a bank transfer screenshot showing the payment confirmation.',
  BLURRY: 'The image quality is too low. Please upload a clearer screenshot.',
  AMOUNT_MISMATCH: 'The payment amount does not match the expected amount.',
  WRONG_RECIPIENT: 'The recipient name does not match. Please verify you paid to the correct account.',
  OLD_SCREENSHOT: 'This screenshot appears to be outdated. Please upload a recent payment screenshot.',
  DUPLICATE_TRANSACTION: 'This transaction has already been submitted.',
  REQUIRES_GPT_JUDGMENT: 'The recipient name could not be automatically verified. Awaiting manual review.',
};

/**
 * Normalize amount for comparison — handles OCR artifacts and format variations
 */
function normalizeAmount(amountStr) {
  if (typeof amountStr === 'number') return amountStr;
  if (!amountStr) return 0;

  let cleaned = String(amountStr)
    .replace(/\s/g, '')
    .replace(/O/g, '0')        // OCR: letter O → zero
    .replace(/o/g, '0')
    .replace(/l(?=\d)/g, '1')  // OCR: lowercase L before digit → one
    .replace(/[^\d.,\-]/g, '');

  // Handle EU format "28.000,50" vs US format "28,000.50"
  if (/,\d{1,2}$/.test(cleaned) && /\.\d{3}/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    cleaned = cleaned.replace(/,/g, '');
  }

  return parseFloat(cleaned) || 0;
}

/**
 * Check if medium-confidence result has all critical fields for auto-processing
 */
function hasAllCriticalFields(ocrResult) {
  return ocrResult.amount !== null &&
         ocrResult.currency &&
         (ocrResult.transactionId || ocrResult.toAccount);
}

/**
 * Normalize account number for comparison — strips spaces, dashes, dots
 */
function normalizeAccount(account) {
  if (!account) return '';
  return String(account).replace(/[\s\-\.]/g, '');
}

/**
 * Enhanced 4-Stage Verification Pipeline with Name Intelligence
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
 *   - Wrong recipient (intelligent name matching) → REJECT or GPT JUDGE
 *   - Old screenshot → REJECT + fraud alert
 *   - Duplicate Trx ID → REJECT + fraud alert
 *   - Amount mismatch → PENDING
 *   - All pass → Stage 4
 *
 * Stage 4: Name Intelligence
 *   - Exact match → VERIFIED
 *   - High confidence (85%+) → VERIFIED + audit log
 *   - Medium confidence (70-84%) → GPT JUDGE
 *   - Low confidence (<70%) → REJECT
 */

/**
 * Verifies recipient using intelligent name matching
 * @param {string} toAccount - Account from OCR
 * @param {string} recipientName - Name from OCR
 * @param {object} expected - Expected values { toAccount, recipientNames, allowedAliases }
 * @param {object} options - Additional options { tenantId, recordId }
 * @returns {Promise<object>} - { verified, skipped, reason, confidence, matchType, requiresGPT }
 */
async function verifyRecipient(toAccount, recipientName, expected, options = {}) {
  // If no expected values, skip verification
  if (!expected.toAccount && (!expected.recipientNames || expected.recipientNames.length === 0)) {
    return {
      verified: null,
      skipped: true,
      reason: 'No recipient verification required',
      confidence: null,
      matchType: 'skipped'
    };
  }

  // Step 1: Account number verification (exact match required)
  if (expected.toAccount && toAccount) {
    const accountResult = await verifyAccountNumber(toAccount, expected.toAccount);
    if (accountResult.verified) {
      return {
        verified: true,
        skipped: false,
        reason: accountResult.reason,
        confidence: 100,
        matchType: 'account_exact',
        requiresGPT: false
      };
    }
  }

  // Step 2: Name intelligence verification
  if (expected.recipientNames && recipientName) {
    const nameResult = await nameIntelligence.analyzeMatch(
      recipientName,
      expected.recipientNames,
      expected.allowedAliases || []
    );

    // Log non-exact matches for audit
    if (nameResult.matchType !== 'exact' && nameResult.confidence >= 70) {
      await logNameMatchAudit(recipientName, expected.recipientNames, nameResult, options);
    }

    // High confidence: Auto-approve
    if (nameResult.confidence >= nameIntelligence.config.strictThreshold) {
      return {
        verified: true,
        skipped: false,
        reason: nameResult.reason,
        confidence: nameResult.confidence,
        matchType: nameResult.matchType,
        requiresGPT: false,
        nameIntelligence: nameResult.details
      };
    }

    // Medium confidence: Requires GPT judgment
    if (nameResult.confidence >= nameIntelligence.config.gptThreshold) {
      return {
        verified: null, // Pending GPT decision
        skipped: false,
        reason: `Borderline match - GPT judgment required`,
        confidence: nameResult.confidence,
        matchType: nameResult.matchType,
        requiresGPT: true,
        nameIntelligence: nameResult.details
      };
    }

    // Low confidence: Reject
    return {
      verified: false,
      skipped: false,
      reason: `Name mismatch: ${nameResult.reason}`,
      confidence: nameResult.confidence,
      matchType: nameResult.matchType,
      requiresGPT: false,
      nameIntelligence: nameResult.details
    };
  }

  // No recipient info found
  if (!toAccount && !recipientName) {
    return {
      verified: false,
      skipped: false,
      reason: 'No recipient info found in screenshot',
      confidence: 0,
      matchType: 'no_data'
    };
  }

  // Fallback: No match
  return {
    verified: false,
    skipped: false,
    reason: `Recipient mismatch: got ${toAccount || 'N/A'} / ${recipientName || 'N/A'}`,
    confidence: 0,
    matchType: 'no_match'
  };
}

/**
 * Verify account number with exact matching
 * @param {string} extracted - Extracted account
 * @param {string} expected - Expected account
 * @returns {object} - Verification result
 */
async function verifyAccountNumber(extracted, expected) {
  if (!extracted || !expected) {
    return { verified: false, reason: 'Missing account information' };
  }

  // Normalize account numbers (remove spaces, dashes, dots)
  const normalizedExtracted = normalizeAccount(extracted);
  const normalizedExpected = normalizeAccount(expected);

  // Exact match required for account numbers
  if (normalizedExtracted === normalizedExpected) {
    return {
      verified: true,
      reason: `Account number matched: ${expected}`
    };
  }

  // Partial match check (in case account is embedded in longer string)
  if (normalizedExtracted.includes(normalizedExpected) ||
      normalizedExpected.includes(normalizedExtracted)) {
    return {
      verified: true,
      reason: `Account number partially matched: ${expected}`
    };
  }

  return {
    verified: false,
    reason: `Account mismatch: expected ${expected}, got ${extracted}`
  };
}

/**
 * Log name match audit for non-exact matches
 * @param {string} extracted - Extracted name
 * @param {Array} expected - Expected names
 * @param {object} matchResult - Name intelligence result
 * @param {object} options - Options with tenantId, recordId
 * @returns {Promise<void>}
 */
async function logNameMatchAudit(extracted, expected, matchResult, options) {
  try {
    const auditRecord = {
      timestamp: new Date(),
      recordId: options.recordId,
      tenantId: options.tenantId || 'default',
      extracted: extracted,
      expected: expected,
      matchType: matchResult.matchType,
      confidence: matchResult.confidence,
      reason: matchResult.reason,
      verificationResult: null, // Will be updated after final decision
      nameIntelligenceDetails: matchResult.details
    };

    // Store in audit collection
    const { getDb } = require('../db/mongo');
    const db = getDb();
    await db.collection('name_match_audit').insertOne(auditRecord);

    console.log(`📋 Name match audit logged | Record: ${options.recordId} | Confidence: ${matchResult.confidence}% | Type: ${matchResult.matchType}`);

  } catch (error) {
    console.error('Failed to log name match audit:', error);
  }
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

  // ====== PRE-CHECK: Duplicate Transaction ID ======
  // No length guard needed — payment-parser sanitization (pure digits ≤13 → null)
  // already filters out account/phone numbers before we get here.
  const extractedTrxId = ocrResult.transactionId ? ocrResult.transactionId.trim() : '';
  if (extractedTrxId.length > 0) {
    try {
      const { payments } = require('../db/mongo');
      const existingPayment = await payments.findByTransactionId(extractedTrxId);

      if (existingPayment && existingPayment.verificationStatus !== 'rejected') {
        result.verification.status = 'rejected';
        result.verification.rejectionReason = 'DUPLICATE_TRANSACTION';
        result.verification.paymentLabel = 'UNPAID';
        result.verification.userMessage = USER_MESSAGES.DUPLICATE_TRANSACTION;

        result.fraud = createFraudAlertRecord({
          fraudType: 'DUPLICATE_TRANSACTION',
          severity: 'CRITICAL',
          invoiceId: options.invoiceId,
          transactionId: extractedTrxId,
          amount: ocrResult.amount,
          currency: ocrResult.currency,
          bankName: ocrResult.bankName,
          confidence: ocrResult.confidence,
          verificationNotes: `Duplicate of payment ${existingPayment._id}`
        });

        console.log(`PRE-CHECK: DUPLICATE_TRANSACTION | Trx ID: ${extractedTrxId} | Existing: ${existingPayment._id} | Record ${recordId}`);
        return result;
      }
    } catch (err) {
      // DB not connected or query failed — skip duplicate check, proceed with verification
      console.warn(`PRE-CHECK: Duplicate check skipped (${err.message}) | Record ${recordId}`);
    }
  }

  // ====== STAGE 1: Is it a bank statement? ======
  if (ocrResult.isBankStatement === false) {
    result.verification.status = 'rejected';
    result.verification.rejectionReason = 'NOT_BANK_STATEMENT';
    result.verification.paymentLabel = 'UNPAID';
    result.verification.userMessage = USER_MESSAGES.NOT_BANK_STATEMENT;
    console.log(`Stage 1: NOT a bank statement | Record ${recordId}`);
    return result;
  }

  // ====== STAGE 2: Confidence check ======
  // Allow medium confidence if all critical fields are present
  if (ocrResult.confidence === 'low' ||
      (ocrResult.confidence === 'medium' && !hasAllCriticalFields(ocrResult))) {
    result.verification.status = 'pending';
    result.verification.rejectionReason = 'BLURRY';
    result.verification.paymentLabel = 'PENDING';
    result.verification.userMessage = USER_MESSAGES.BLURRY;
    const missing = [];
    if (!ocrResult.amount) missing.push('amount');
    if (!ocrResult.currency) missing.push('currency');
    if (!ocrResult.transactionId && !ocrResult.toAccount) missing.push('transactionId|toAccount');
    if (!ocrResult.bankName) missing.push('bankName');
    if (!ocrResult.recipientName) missing.push('recipientName');
    console.log(`Stage 2: PENDING (${ocrResult.confidence} confidence) | Record ${recordId} | Engine: ${ocrResult.ocrEngine || 'unknown'} | Missing: [${missing.join(', ') || 'none'}]`);
    console.log(`   Got → bank:${ocrResult.bankName || '—'} | amount:${ocrResult.amount || '—'} ${ocrResult.currency || ''} | trxId:${ocrResult.transactionId || '—'} | toAcc:${ocrResult.toAccount || '—'} | recipient:${ocrResult.recipientName || '—'} | date:${ocrResult.transactionDate || '—'}`);
    return result;
  }

  // Medium confidence with all critical fields — proceed with warning
  if (ocrResult.confidence === 'medium') {
    result.verification.warnings = result.verification.warnings || [];
    result.verification.warnings.push('Medium confidence - verify manually if suspicious');
    console.log(`Stage 2: Medium confidence but all critical fields present - proceeding | Record ${recordId}`);
  }

  // ====== STAGE 3: Security verification (HIGH confidence only) ======

  // 3a: Enhanced recipient verification with name intelligence
  const recipientCheck = await verifyRecipient(
    ocrResult.toAccount,
    ocrResult.recipientName,
    {
      toAccount: expected.toAccount,
      recipientNames: expected.recipientNames,
      allowedAliases: expectedPayment.allowedAliases || []
    },
    {
      tenantId: options.tenantId || 'default',
      recordId: recordId
    }
  );

  // Update validation results with enhanced data
  result.validation.toAccount.match = recipientCheck.verified;
  result.validation.toAccount.skipped = recipientCheck.skipped;
  result.validation.toAccount.confidence = recipientCheck.confidence;
  result.validation.toAccount.matchType = recipientCheck.matchType;

  result.validation.recipientNames.match = recipientCheck.verified;
  result.validation.recipientNames.skipped = recipientCheck.skipped;
  result.validation.recipientNames.confidence = recipientCheck.confidence;
  result.validation.recipientNames.matchType = recipientCheck.matchType;
  result.validation.recipientNames.nameIntelligence = recipientCheck.nameIntelligence;

  // Log recipient verification result
  if (recipientCheck.skipped) {
    console.log(`Stage 3a: Recipient check SKIPPED | Record ${recordId} | ${recipientCheck.reason}`);
  } else if (recipientCheck.verified === true) {
    console.log(`Stage 3a: Recipient MATCHED | Record ${recordId} | Type: ${recipientCheck.matchType} | Confidence: ${recipientCheck.confidence}% | ${recipientCheck.reason}`);
  } else if (recipientCheck.requiresGPT) {
    console.log(`Stage 3a: Recipient BORDERLINE - GPT judgment required | Record ${recordId} | Confidence: ${recipientCheck.confidence}% | ${recipientCheck.reason}`);
    // Mark for GPT judgment - will be handled after all other checks
    result.verification.requiresGPTJudgment = true;
    result.verification.gptJudgmentReason = 'NAME_VERIFICATION';
    result.verification.nameIntelligenceData = recipientCheck;
  }

  // Only reject if definitively failed (not requiring GPT judgment)
  if (!recipientCheck.skipped && recipientCheck.verified === false && !recipientCheck.requiresGPT) {
    result.verification.status = 'rejected';
    result.verification.rejectionReason = 'WRONG_RECIPIENT';
    result.verification.paymentLabel = 'UNPAID';
    result.verification.userMessage = USER_MESSAGES.WRONG_RECIPIENT;
    console.log(`Stage 3a: Wrong recipient | Record ${recordId} | Type: ${recipientCheck.matchType} | Confidence: ${recipientCheck.confidence}% | ${recipientCheck.reason}`);
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

  // 3d: Amount verification (normalize before converting)
  const normalizedOcrAmount = normalizeAmount(ocrResult.amount);
  const amountInKHR = convertToKHR(normalizedOcrAmount, ocrResult.currency);
  result.validation.amount.actual = amountInKHR;

  if (expected.amount) {
    const amountCheck = verifyAmount(expected.amount, amountInKHR, expected.tolerancePercent);
    result.validation.amount.match = amountCheck.match;

    if (!amountCheck.match) {
      result.verification.status = 'pending';
      result.verification.rejectionReason = 'AMOUNT_MISMATCH';
      result.verification.paymentLabel = 'PENDING';
      result.verification.userMessage = USER_MESSAGES.AMOUNT_MISMATCH;
      console.log(`Stage 3d: Amount mismatch | Record ${recordId} | Expected: ${expected.amount}, Got: ${amountInKHR}`);
      return result;
    }
  } else {
    // No expected amount - skip amount verification
    result.validation.amount.skipped = true;
  }

  // ====== STAGE 4: GPT JUDGMENT (if required) ======
  if (result.verification.requiresGPTJudgment) {
    console.log(`Stage 4: Invoking GPT judgment for borderline name match | Record ${recordId}`);

    // For now, mark as pending - full GPT judge implementation would go here
    result.verification.status = 'pending';
    result.verification.rejectionReason = 'REQUIRES_GPT_JUDGMENT';
    result.verification.paymentLabel = 'PENDING';
    result.verification.userMessage = USER_MESSAGES.REQUIRES_GPT_JUDGMENT;
    console.log(`Stage 4: Marked for manual review/GPT judgment | Record ${recordId} | Reason: ${result.verification.gptJudgmentReason}`);

    return result;
  }

  // ====== ALL CHECKS PASSED ======
  result.verification.status = 'verified';
  result.verification.rejectionReason = null;
  result.verification.paymentLabel = 'PAID';
  console.log(`VERIFIED | Record ${recordId} | Amount: ${amountInKHR} KHR | OCR Engine: ${ocrResult.ocrEngine || 'GPT-4o'}`);

  return result;
}

module.exports = {
  verifyPayment,
  verifyRecipient,
  normalizeAmount,
  normalizeAccount
};
