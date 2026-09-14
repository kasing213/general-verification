'use strict';

const { v4: uuidv4 } = require('uuid');
const { convertToKHR, verifyAmount } = require('../utils/currency');
const { validateTransactionDate, createFraudAlertRecord, determineSeverity } = require('./fraud-detector');
const { analyzePaymentScreenshot } = require('./ocr-engine');
const NameIntelligenceService = require('../services/name-intelligence');
const { FRAUD_TYPES } = require('./fraud-types');

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
  RECIPIENT_UNVERIFIABLE: 'Your payment was received and is awaiting manual confirmation by the merchant.',
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
         ocrResult.amount !== undefined &&
         ocrResult.currency &&
         ocrResult.recipientName &&
         ocrResult.transactionDate;
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
 *   - confidence = low → PENDING + "send clearer image"
 *   - confidence = medium with receiver/date/amount/currency → Stage 3
 *   - confidence = high → Stage 3
 *
 * Stage 3: Security Verification
 *   - Receiver name is primary; account number is optional supporting evidence
 *   - Wrong receiver (intelligent name matching) → REJECT or GPT JUDGE
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
 * @returns {Promise<object>} - Receiver verdict plus independent account evidence
 */
async function verifyRecipient(toAccount, recipientName, expected, options = {}) {
  // Account-number evidence is useful, but it never decides recipient identity.
  // Many Cambodian receipts omit the destination account while still showing
  // the receiver.  Conversely, an account match must not hide a wrong receiver.
  let accountResult = null;
  if (expected.toAccount && toAccount) {
    accountResult = await verifyAccountNumber(toAccount, expected.toAccount);
  }

  const accountEvidence = {
    accountVerified: accountResult ? accountResult.verified : null,
    accountSkipped: !expected.toAccount || !toAccount,
    accountConfidence: accountResult ? accountResult.confidence : null,
    accountMatchType: accountResult ? accountResult.matchType : 'skipped',
    accountReason: accountResult ? accountResult.reason : (
      !expected.toAccount ? 'No expected account configured' : 'Account number not shown in screenshot'
    )
  };

  // The expected receiver name is the primary identity anchor.  Without it,
  // an account number alone is supporting evidence, not enough to auto-verify.
  if (!expected.recipientNames || expected.recipientNames.length === 0) {
    return {
      verified: null,
      skipped: true,
      reason: 'No expected receiver name configured',
      confidence: null,
      matchType: 'skipped',
      ...accountEvidence
    };
  }

  // A receipt with no receiver cannot be auto-approved, even if its account
  // number matches.  Hold it for the merchant instead of rejecting it.
  if (!recipientName) {
    return {
      verified: null,
      skipped: false,
      unverifiable: true,
      reason: 'Receiver name not found in screenshot',
      confidence: null,
      matchType: 'receiver_missing',
      requiresGPT: false,
      ...accountEvidence
    };
  }

  // Receiver-name intelligence controls the identity verdict.
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
        nameIntelligence: nameResult.details,
        ...accountEvidence
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
        nameIntelligence: nameResult.details,
        ...accountEvidence
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
      nameIntelligence: nameResult.details,
      ...accountEvidence
    };
  }
}

/**
 * Verify account number with exact matching
 * @param {string} extracted - Extracted account
 * @param {string} expected - Expected account
 * @returns {object} - Verification result
 */
async function verifyAccountNumber(extracted, expected) {
  if (!extracted || !expected) {
    return {
      verified: false,
      confidence: 0,
      matchType: 'account_missing',
      reason: 'Missing account information'
    };
  }

  // Normalize account numbers (remove spaces, dashes, dots)
  const normalizedExtracted = normalizeAccount(extracted);
  const normalizedExpected = normalizeAccount(expected);

  // Exact match required for account numbers
  if (normalizedExtracted === normalizedExpected) {
    return {
      verified: true,
      confidence: 100,
      matchType: 'account_exact',
      reason: `Account number matched: ${expected}`
    };
  }

  // Partial match check (in case account is embedded in longer string)
  if (normalizedExtracted.includes(normalizedExpected) ||
      normalizedExpected.includes(normalizedExtracted)) {
    return {
      verified: true,
      confidence: 90,
      matchType: 'account_partial',
      reason: `Account number partially matched: ${expected}`
    };
  }

  return {
    verified: false,
    confidence: 0,
    matchType: 'account_mismatch',
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
      amountText: ocrResult.amountText || null,
      currencySymbol: ocrResult.currencySymbol || null,
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
        // Whose payment did we collide with? The unique index on
        // transactionId is GLOBAL, not per-tenant, so a hit can point at
        // another merchant's payment entirely. The two cases mean opposite
        // things and are handled differently on purpose.
        const thisMerchant = options.merchantId ? String(options.merchantId) : null;
        const thatMerchant = existingPayment.merchant_id
          ? String(existingPayment.merchant_id) : null;
        const sameMerchant = Boolean(thisMerchant && thatMerchant && thisMerchant === thatMerchant);

        // A duplicate is no longer an auto-rejection. The merchant decides,
        // because the innocent explanations (customer resent the screenshot,
        // one transfer covering two invoices) are at least as common as the
        // guilty one, and refusing the customer outright with no human in the
        // loop was costing real sales.
        result.verification.status = 'pending';
        result.verification.paymentLabel = 'PENDING';
        result.verification.rejectionReason = sameMerchant
          ? FRAUD_TYPES.DUPLICATE_TRANSACTION
          : FRAUD_TYPES.DUPLICATE_TRANSACTION_OTHER_ACCOUNT;
        result.verification.userMessage = USER_MESSAGES.DUPLICATE_TRANSACTION;

        // Details are attached ONLY for our own merchant. Handing back another
        // tenant's invoice number or amount would leak it into this
        // merchant's Telegram and dashboard.
        result.verification.duplicateOf = sameMerchant
          ? {
              scope: 'same_merchant',
              record_id: String(existingPayment._id),
              invoice_number: existingPayment.invoice_id || null,
              amount: existingPayment.amount || null,
              currency: existingPayment.currency || null,
              transaction_date: existingPayment.transactionDate || null,
              submitted_at: existingPayment.uploadedAt || null
            }
          : { scope: 'other_merchant' };

        // Still recorded as a fraud alert either way - the audit trail must
        // not get thinner just because the verdict got kinder. Severity now
        // reflects which of the two cases it actually is.
        result.fraud = createFraudAlertRecord({
          fraudType: result.verification.rejectionReason,
          severity: sameMerchant ? 'MEDIUM' : 'CRITICAL',
          invoiceId: options.invoiceId,
          transactionId: extractedTrxId,
          amount: ocrResult.amount,
          currency: ocrResult.currency,
          bankName: ocrResult.bankName,
          confidence: ocrResult.confidence,
          // The original's id identifies ANOTHER tenant's payment when this is
          // a cross-merchant hit, and `fraud` is returned in the API response -
          // so it stays out of the note in that case. An investigator can still
          // find the original by transactionId, which is on this alert already.
          verificationNotes: sameMerchant
            ? `Duplicate of payment ${existingPayment._id} (same merchant) - held for merchant review`
            : 'Duplicate of a payment on another account - held for merchant review'
        });

        console.log(
          `PRE-CHECK duplicate=1 scope=${sameMerchant ? 'same_merchant' : 'other_merchant'} ` +
          `verdict=pending trx=${extractedTrxId} existing=${existingPayment._id} record=${recordId}`
        );
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
    result.verification.rejectionReason = FRAUD_TYPES.NOT_BANK_STATEMENT;
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
    result.verification.rejectionReason = FRAUD_TYPES.BLURRY;
    result.verification.paymentLabel = 'PENDING';
    result.verification.userMessage = USER_MESSAGES.BLURRY;
    const missing = [];
    if (!ocrResult.amount) missing.push('amount');
    if (!ocrResult.currency) missing.push('currency');
    if (!ocrResult.bankName) missing.push('bankName');
    if (!ocrResult.recipientName) missing.push('recipientName');
    if (!ocrResult.transactionDate) missing.push('transactionDate');
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

  // ====== STAGE 3: Security verification ======

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
  result.validation.toAccount.match = recipientCheck.accountVerified;
  result.validation.toAccount.skipped = recipientCheck.accountSkipped;
  result.validation.toAccount.confidence = recipientCheck.accountConfidence;
  result.validation.toAccount.matchType = recipientCheck.accountMatchType;
  result.validation.toAccount.reason = recipientCheck.accountReason;

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
    result.verification.rejectionReason = FRAUD_TYPES.WRONG_RECIPIENT;
    result.verification.paymentLabel = 'UNPAID';
    result.verification.userMessage = USER_MESSAGES.WRONG_RECIPIENT;
    console.log(`Stage 3a: Wrong recipient | Record ${recordId} | Type: ${recipientCheck.matchType} | Confidence: ${recipientCheck.confidence}% | ${recipientCheck.reason}`);
    return result;
  }

  // Track whether receiver identity could be checked. This is true when the
  // invoice supplied no expected receiver or the receipt did not show one.
  // Account, amount and date alone must not auto-approve the payment.
  const recipientUnverifiable = recipientCheck.skipped === true ||
    recipientCheck.unverifiable === true;

  // 3b: Date validation (old screenshot check)
  {
    const dateValidation = validateTransactionDate(ocrResult.transactionDate, uploadedAt, maxAgeDays);
    result.validation.dateValidation = dateValidation;
    result.validation.isOldScreenshot = !dateValidation.isValid && dateValidation.fraudType === FRAUD_TYPES.OLD_SCREENSHOT;

    if (!dateValidation.isValid) {
      // OLD_SCREENSHOT is the only date failure that still refuses outright:
      // "older than the window" is the signature of a reused receipt, and the
      // 7-day limit exists precisely to catch it.
      //
      // The other three are NOT evidence of anything. A future date is almost
      // always a wrong clock on the customer's phone; an unparsed date is
      // usually a Khmer format the parser does not know; a missing date is a
      // cropped screenshot. Refusing a paying customer for those, with no
      // human ever told, was ending real sales over a phone setting. They go
      // to the merchant instead.
      const refuseOutright = dateValidation.fraudType === FRAUD_TYPES.OLD_SCREENSHOT;

      result.verification.status = refuseOutright ? 'rejected' : 'pending';
      result.verification.rejectionReason = dateValidation.fraudType;
      result.verification.paymentLabel = refuseOutright ? 'UNPAID' : 'PENDING';

      // Create fraud alert
      result.fraud = createFraudAlertRecord({
        fraudType: dateValidation.fraudType,
        severity: refuseOutright
          ? determineSeverity(dateValidation.fraudType, { ageDays: dateValidation.ageDays })
          : 'LOW',
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

      console.log(
        `Stage 3b date=fail reason=${dateValidation.fraudType} ` +
        `verdict=${result.verification.status} record=${recordId} detail=${dateValidation.reason}`
      );
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
  //
  // BOTH sides convert to KHR before comparing. Only the extracted side used
  // to be converted, while `expected.amount` was passed straight from the
  // invoice in the invoice's own currency, so a $2.50 invoice was compared as
  // 2.5 against 10000 and EVERY USD invoice failed the amount check no matter
  // what the customer paid. KHR invoices happened to work, which is how it
  // went unnoticed. verifyAmount's own docstring says both sides are KHR.
  const normalizedOcrAmount = normalizeAmount(ocrResult.amount);

  // An extractor that could not see a currency symbol should say so rather
  // than guess. When it does, bill in the invoice's currency: that is the
  // merchant's own account currency and the one being charged.
  const currencyAssumed = !ocrResult.currency;
  const paidCurrency = ocrResult.currency || expected.currency || 'KHR';

  const amountInKHR = convertToKHR(normalizedOcrAmount, paidCurrency);
  const expectedInKHR = convertToKHR(expected.amount, expected.currency);

  // Report both sides AS READ, with their units. "invoice 2.5, screenshot
  // 40000000" told the merchant nothing; showing "2.5 USD" against
  // "10000 USD" is what makes a misread currency visible at a glance.
  result.validation.amount.actual = normalizedOcrAmount;
  result.validation.amount.actualCurrency = paidCurrency;
  result.validation.amount.expectedCurrency = expected.currency || 'KHR';
  result.validation.amount.actualKHR = amountInKHR;
  result.validation.amount.expectedKHR = expectedInKHR;
  if (currencyAssumed) result.validation.amount.currencyAssumed = true;

  if (expected.amount) {
    const amountCheck = verifyAmount(expectedInKHR, amountInKHR, expected.tolerancePercent);
    result.validation.amount.match = amountCheck.match;

    // The number is right but the currency label may not be: the same digits
    // match once reinterpreted in the other currency. Never auto-accepted -
    // 10,000 KHR against a $10,000 invoice must not clear - but the merchant
    // reviewing this is told what we noticed.
    if (!amountCheck.match && ocrResult.currency) {
      const flipped = paidCurrency.toUpperCase() === 'USD' ? 'KHR' : 'USD';
      if (verifyAmount(expectedInKHR, convertToKHR(normalizedOcrAmount, flipped),
                       expected.tolerancePercent).match) {
        result.validation.amount.currencySuspect = true;
        result.validation.amount.currencyIfFlipped = flipped;
      }
    }

    if (!amountCheck.match) {
      result.verification.status = 'pending';
      result.verification.rejectionReason = FRAUD_TYPES.AMOUNT_MISMATCH;
      result.verification.paymentLabel = 'PENDING';
      result.verification.userMessage = USER_MESSAGES.AMOUNT_MISMATCH;
      console.log(
        `Stage 3d amount=fail record=${recordId} ` +
        `expected=${expected.amount} ${expected.currency || 'KHR'} (${expectedInKHR} KHR) ` +
        `read=${normalizedOcrAmount} ${paidCurrency}${currencyAssumed ? ' (assumed)' : ''} (${amountInKHR} KHR)` +
        (result.validation.amount.currencySuspect
          ? ` currency_suspect=would_match_as_${result.validation.amount.currencyIfFlipped}` : '')
      );
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
    result.verification.rejectionReason = FRAUD_TYPES.REQUIRES_GPT_JUDGMENT;
    result.verification.paymentLabel = 'PENDING';
    result.verification.userMessage = USER_MESSAGES.REQUIRES_GPT_JUDGMENT;
    console.log(`Stage 4: Marked for manual review/GPT judgment | Record ${recordId} | Reason: ${result.verification.gptJudgmentReason}`);

    return result;
  }

  // ====== ALL CHECKS PASSED ======
  // If receiver identity could not be verified, do NOT auto-approve on the
  // supporting checks alone; route to manual merchant review.
  if (recipientUnverifiable) {
    result.verification.status = 'pending';
    result.verification.rejectionReason = FRAUD_TYPES.RECIPIENT_UNVERIFIABLE;
    result.verification.paymentLabel = 'PENDING';
    result.verification.userMessage = USER_MESSAGES.RECIPIENT_UNVERIFIABLE;
    console.log(`MANUAL REVIEW (recipient unverifiable) | Record ${recordId} | Amount: ${amountInKHR} KHR`);
    return result;
  }

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
