'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { apiKeyAuth } = require('../middleware/auth');
const { verifyPayment, duplicateTransactionVerdict, USER_MESSAGES } = require('../core/verification');
const { FRAUD_TYPES } = require('../core/fraud-types');
const { invoices, payments, fraudAlerts, screenshots } = require('../db/mongo');
const imageDedupe = require('../services/image-dedupe');
const config = require('../config/schema');

const router = express.Router();

// Helper functions for response transformation
function confidenceToNumber(confidence) {
  const map = {
    high: 0.9,
    medium: 0.7,
    low: 0.3,      // Changed from 0.5 to 0.3 for better distinction
    failed: 0.1,   // For OCR failures
    error: 0.0     // For system errors
  };
  return map[confidence] || 0.1;  // Default to 0.1 instead of 0.5
}

function formatAmount(amount, currency) {
  if (!amount) return "N/A";
  if (currency === 'KHR') {
    return amount.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(isoDate) {
  if (!isoDate) return "N/A";
  // Handle both Date objects and ISO strings
  const dateStr = isoDate instanceof Date ? isoDate.toISOString() : String(isoDate);
  return dateStr.split('T')[0];
}

// Normalize recipientName (string) and recipientNames (array) to array format
function normalizeRecipientNames(params) {
  if (!params) return null;
  // Accept both recipientName (string) and recipientNames (array)
  if (params.recipientNames) {
    return Array.isArray(params.recipientNames) ? params.recipientNames : [params.recipientNames];
  }
  if (params.recipientName) {
    return [params.recipientName];
  }
  return null;
}

// Configure multer for memory storage (for GridFS upload)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.upload.maxFileSize
  },
  fileFilter: (req, file, cb) => {
    if (config.upload.allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${config.upload.allowedMimeTypes.join(', ')}`));
    }
  }
});

/**
 * Build the API response for a verification result. Also stored on the
 * payment record (`responseSnapshot`) so a resend of the same image can be
 * answered with exactly what the first send was told.
 */
function buildResponse(result, expectedPayment, screenshotId) {
  // Build verification warnings for skipped checks
  const verification_warnings = [];
  if (result.validation.toAccount.skipped) {
    verification_warnings.push("Expected Account not set - account verification skipped");
  }
  if (result.validation.recipientNames.skipped) {
    verification_warnings.push("Recipient Name not set - recipient verification skipped");
  }
  if (result.validation.amount.skipped) {
    verification_warnings.push("Expected Amount not set - amount verification skipped");
  }

  // Set by the duplicate pre-check and by the E11000 path below. record_id is
  // only present when the original is this merchant's own payment.
  const duplicateOf = result.verification.duplicateOf || null;

  // Transform response to match main backend expected format
  return {
    success: result.success,
    record_id: result.recordId,
    // NOTE: this number is the READ QUALITY of the screenshot (the vision
    // model's high/medium/low legibility grade), NOT a probability that the
    // payment is genuine. The verdict comes from the boolean gates in
    // core/verification.js. Consumers rendered it as "Confidence: 90%" next
    // to "Manual Review Required" and looked broken to merchants, so the
    // scale it came from is now stated explicitly alongside it.
    confidence: confidenceToNumber(result.verification.confidence),
    confidence_basis: 'read_quality',
    read_quality: result.verification.confidence || 'low',
    // Duplicate flags, the same on every response. duplicateReason is
    // SAME_TRANSACTION here; a resend of the same image is SAME_IMAGE
    // (asImageDuplicate). duplicateOf is the original's record id, or null
    // when it is unknown or belongs to another merchant.
    duplicate: Boolean(duplicateOf),
    duplicateOf: (duplicateOf && duplicateOf.record_id) || null,
    duplicateReason: duplicateOf ? 'SAME_TRANSACTION' : null,
    extracted_data: {
      amount: formatAmount(result.payment.amount, result.payment.currency),
      currency: result.payment.currency || "",
      amount_text: result.payment.amountText || null,
      currency_symbol: result.payment.currencySymbol || null,
      date: formatDate(result.payment.transactionDate),
      reference: result.payment.referenceNumber || result.payment.transactionId || "N/A",
      account: result.payment.toAccount || "N/A",
      bank: result.payment.bankName || "N/A",
      recipient_name: result.payment.recipientName || "N/A"
    },
    rawText: result.payment.ocrText || "",
    ocrEngine: result.payment.ocrEngine || "unknown",
    verification: {
      status: result.verification.status,
      message: result.verification.status === 'verified'
        ? 'Payment verified successfully'
        : result.verification.rejectionReason || 'Manual review required',
      rejectionReason: result.verification.rejectionReason,
      // core/verification.js sets a plain-language USER_MESSAGES string on
      // every non-verified path, and this transform used to drop it. The
      // only explanation that reached the customer was `message`, which
      // falls back to the raw enum ("RECIPIENT_UNVERIFIABLE"). Forward it.
      userMessage: result.verification.userMessage || null,
      warnings_detail: result.verification.warnings || null,
      // The original payment this one duplicates, so the merchant can be
      // shown WHAT it duplicates instead of just being told that it does.
      // Already reduced to {scope:'other_merchant'} by core/verification.js
      // when the original belongs to a different tenant.
      duplicateOf,
      duplicate: Boolean(duplicateOf),
      // The original's verdict when this is a duplicate of our own merchant's
      // payment ('verified' / 'pending' / 'rejected'), else null.
      originalStatus: result.verification.originalStatus || null,
      // Expected values from invoice (for comparison display)
      expected: {
        amount: result.validation.amount.expected,
        currency: expectedPayment.currency || 'KHR',
        account: result.validation.toAccount.expected || "N/A",
        recipient_name: Array.isArray(result.validation.recipientNames.expected)
          ? result.validation.recipientNames.expected[0]
          : result.validation.recipientNames.expected || "N/A",
        due_date: expectedPayment.dueDate || null
      },
      // Match results
      matched: {
        amount: result.validation.amount.match,
        currency: true,
        account: result.validation.toAccount.match,
        recipient_name: result.validation.recipientNames.match,
        date: !result.validation.isOldScreenshot
      },
      date_warning: result.validation.dateValidation?.reason || null,
      warnings: verification_warnings.length > 0 ? verification_warnings : null
    },
    // Keep original fields for backward compatibility
    recordId: result.recordId,
    invoiceId: result.invoiceId,
    screenshotId: screenshotId,
    payment: result.payment,
    validation: result.validation,
    fraud: result.fraud
  };
}

/**
 * The response a resend of the same image gets: the original's, flagged.
 *
 * Same verdict as the first send, with one exception: a verified original is
 * never answered "verified" a second time, since a caller that credits on
 * "verified" would credit one transfer twice. It gets what the duplicate
 * pre-check gives a verified original - held as DUPLICATE_TRANSACTION, with
 * originalStatus 'verified' so the caller can tell the customer it is done.
 */
function asImageDuplicate(response, originalId, submittedAt = null) {
  const verification = {
    ...response.verification,
    duplicate: true,
    originalStatus: response.verification.status
  };

  if (verification.status === 'verified') {
    const payment = response.payment || {};
    Object.assign(verification, {
      status: 'pending',
      message: FRAUD_TYPES.DUPLICATE_TRANSACTION,
      rejectionReason: FRAUD_TYPES.DUPLICATE_TRANSACTION,
      userMessage: USER_MESSAGES.DUPLICATE_TRANSACTION,
      // The image key is scoped to the merchant, so this is always our own.
      duplicateOf: {
        scope: 'same_merchant',
        record_id: originalId,
        invoice_number: response.invoiceId || null,
        amount: payment.amount || null,
        currency: payment.currency || null,
        transaction_date: payment.transactionDate || null,
        submitted_at: submittedAt
      }
    });
  }

  return {
    ...response,
    duplicate: true,
    duplicateOf: originalId,
    duplicateReason: 'SAME_IMAGE',
    verification
  };
}

/**
 * The stored result of the first send of this image within the window, or
 * null. A failed lookup is not fatal - the image is simply read again.
 */
async function findStoredResult(imageKey) {
  const windowMs = imageDedupe.windowMs();
  if (!windowMs) return null;

  try {
    const stored = await payments.findRecentByImageKey(imageKey, new Date(Date.now() - windowMs));
    if (stored && stored.responseSnapshot) {
      return {
        response: stored.responseSnapshot,
        originalId: String(stored._id),
        submittedAt: stored.uploadedAt || null
      };
    }
  } catch (err) {
    console.warn(`IMAGE-DEDUPE lookup skipped (${err.message})`);
  }
  return null;
}

/**
 * Read the image, judge it, store it, and build the response. Runs at most
 * once per image key at a time (see the POST handler).
 */
async function runVerification({
  imageBuffer, filename, expectedPayment, invoiceId, customerId, merchantId, imageHash, imageKey
}) {
  const result = await verifyPayment(imageBuffer, expectedPayment, {
    invoiceId,
    customerId,
    merchantId
  });

  // Upload screenshot to GridFS
  const screenshotId = await screenshots.upload(imageBuffer, filename, {
    paymentId: result.recordId,
    invoiceId,
    customerId,
    verificationStatus: result.verification.status,
    transactionId: result.payment.transactionId || null
  });

  result.screenshotId = screenshotId;

  // Save payment record to database
  const paymentRecord = {
    _id: result.recordId,
    invoice_id: invoiceId,
    customer_id: customerId,
    merchant_id: merchantId,

    // OCR data
    amount: result.payment.amount,
    currency: result.payment.currency,
    // Only include transactionId if it exists (sparse index requires field to be absent, not null)
    ...(result.payment.transactionId && { transactionId: result.payment.transactionId }),
    transactionDate: result.payment.transactionDate,
    fromAccount: result.payment.fromAccount,
    toAccount: result.payment.toAccount,
    recipientName: result.payment.recipientName,
    bankName: result.payment.bankName,
    referenceNumber: result.payment.referenceNumber,
    remark: result.payment.remark,
    isBankStatement: result.payment.isBankStatement,

    // Verification
    verificationStatus: result.verification.status,
    paymentLabel: result.verification.paymentLabel,
    confidence: result.verification.confidence,
    rejectionReason: result.verification.rejectionReason,
    userMessage: result.verification.userMessage || null,

    // Expected values
    expectedAmount: expectedPayment.amount,
    expectedCurrency: expectedPayment.currency,
    expectedAccount: expectedPayment.toAccount,
    expectedNames: expectedPayment.recipientNames,

    // Validation results
    amountMatch: result.validation.amount.match,
    recipientMatch: result.validation.toAccount.match || result.validation.recipientNames.match,

    // GridFS reference
    screenshotId: screenshotId,

    // Read-once: sha256 of the image bytes, the same hash scoped to this
    // merchant + expected payment, and the response this send got.
    imageHash,
    imageKey,

    // Metadata
    uploadedAt: new Date(),
    processedAt: new Date()
  };

  let response = buildResponse(result, expectedPayment, screenshotId);
  paymentRecord.responseSnapshot = response;

  try {
    await payments.create(paymentRecord);
  } catch (err) {
    // Handle MongoDB E11000 duplicate key error on transactionId unique sparse index.
    // Reached when the pre-check did not see the original: it skips rejected
    // originals, and two sends of the same transaction can run at once.
    if (err.code === 11000 && err.keyPattern && err.keyPattern.transactionId) {
      // Answer with the ORIGINAL's verdict, not a fresh one - the caller has
      // usually already told the customer the first answer. This used to log
      // scope=unknown and answer "pending" without looking at the original,
      // so a receipt rejected on the first send came back "merchant is
      // confirming" on the second. One indexed lookup tells us whose it is.
      let original = null;
      try {
        original = await payments.findByTransactionId(paymentRecord.transactionId);
      } catch (lookupErr) {
        console.warn(`E11000: original lookup failed (${lookupErr.message}) | Record ${result.recordId}`);
      }

      const dup = duplicateTransactionVerdict(original, merchantId);
      Object.assign(result.verification, dup.verification);
      console.log(
        `E11000 duplicate=1 scope=${dup.scope} verdict=${result.verification.status} ` +
        `record=${result.recordId} trx=${paymentRecord.transactionId} ` +
        `existing=${original ? original._id : 'none'}`
      );

      // Still save with transactionId removed so the record is preserved for audit
      delete paymentRecord.transactionId;
      paymentRecord.verificationStatus = result.verification.status;
      paymentRecord.paymentLabel = result.verification.paymentLabel;
      paymentRecord.rejectionReason = result.verification.rejectionReason;
      paymentRecord.userMessage = result.verification.userMessage || null;
      response = buildResponse(result, expectedPayment, screenshotId);
      paymentRecord.responseSnapshot = response;
      try {
        await payments.create(paymentRecord);
      } catch (reinsertErr) {
        console.error(`E11000: Failed to re-insert audit record | Record ${result.recordId}:`, reinsertErr.message);
      }
    } else {
      throw err;
    }
  }

  // Save fraud alert if detected
  if (result.fraud) {
    result.fraud.paymentId = result.recordId;
    result.fraud.screenshotId = screenshotId;
    await fraudAlerts.create(result.fraud);
  }

  // Update invoice status if verified
  if (invoiceId && result.verification.status === 'verified') {
    await invoices.update(invoiceId, {
      status: 'verified',
      verified_at: new Date(),
      payment_id: result.recordId
    });
  }

  return response;
}

/**
 * POST /api/v1/verify
 * Verify payment screenshot
 *
 * Two modes:
 * - Mode A: Inline parameters (expectedPayment in body)
 * - Mode B: Invoice lookup (invoice_id in body)
 */
router.post('/', apiKeyAuth, upload.single('image'), async (req, res) => {
  try {
    // Validate image upload
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Missing image',
        message: 'Image file is required. Use "image" field in multipart/form-data.'
      });
    }

    const imageBuffer = req.file.buffer;
    const filename = `${uuidv4()}.jpg`;
    let expectedPayment = null;
    let invoiceId = null;
    let customerId = null;

    // Parse request body
    const invoiceIdParam = req.body.invoice_id || req.body.invoiceId;
    let expectedPaymentParam = req.body.expectedPayment || req.body.expected_payment;

    // Parse expectedPayment if it's a string (from form-data)
    if (typeof expectedPaymentParam === 'string') {
      try {
        expectedPaymentParam = JSON.parse(expectedPaymentParam);
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: 'Invalid expectedPayment',
          message: 'expectedPayment must be valid JSON'
        });
      }
    }

    // Mode B: Invoice lookup
    if (invoiceIdParam) {
      invoiceId = invoiceIdParam;
      const invoice = await invoices.findById(invoiceId);

      if (!invoice) {
        return res.status(404).json({
          success: false,
          error: 'Invoice not found',
          message: `Invoice ${invoiceId} does not exist`
        });
      }

      customerId = invoice.customer_id;

      // Use invoice's expectedPayment, but allow override from request
      expectedPayment = {
        amount: expectedPaymentParam?.amount ?? invoice.expectedPayment?.amount,
        currency: expectedPaymentParam?.currency ?? invoice.expectedPayment?.currency ?? 'KHR',
        bank: expectedPaymentParam?.bank ?? invoice.expectedPayment?.bank ?? null,
        toAccount: expectedPaymentParam?.toAccount ?? invoice.expectedPayment?.toAccount ?? null,
        recipientNames: normalizeRecipientNames(expectedPaymentParam) ?? invoice.expectedPayment?.recipientNames ?? null,
        tolerancePercent: expectedPaymentParam?.tolerancePercent ?? invoice.expectedPayment?.tolerancePercent ?? 5
      };
    }
    // Mode A: Inline parameters
    else if (expectedPaymentParam) {
      expectedPayment = {
        amount: expectedPaymentParam.amount,
        currency: expectedPaymentParam.currency || 'KHR',
        bank: expectedPaymentParam.bank || null,
        toAccount: expectedPaymentParam.toAccount || null,
        recipientNames: normalizeRecipientNames(expectedPaymentParam),
        tolerancePercent: expectedPaymentParam.tolerancePercent || 5
      };
      customerId = req.body.customerId || req.body.customer_id || null;
    }
    // No parameters - basic verification only
    else {
      expectedPayment = {
        amount: null,
        currency: 'KHR',
        bank: null,
        toAccount: null,
        recipientNames: null,
        tolerancePercent: 5
      };
    }

    // Validate required amount if provided
    if (expectedPayment.amount !== null && expectedPayment.amount !== undefined) {
      if (typeof expectedPayment.amount !== 'number' || expectedPayment.amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid amount',
          message: 'expectedPayment.amount must be a positive number'
        });
      }
    }

    // Run verification pipeline (pass buffer directly)
    // Hoisted above verifyPayment: the duplicate pre-check needs to know WHOSE
    // payment it collided with, because the unique index on transactionId is
    // global and a hit can point at another merchant entirely.
    //
    // Callers that do not send merchant_id fall back to customerId, which is
    // what every historical row stored here. Those rows will not match a real
    // tenant id, so they fall through to the "other merchant" branch - the
    // detail-free one. Wrong but safe: it never leaks, it only under-shares.
    const merchantId = req.body.merchant_id || customerId || 'default';

    // Read each image once. The same bytes for the same merchant and expected
    // payment are answered from the first run instead of being read again:
    // one receipt resent three times used to cost three full Claude scans and
    // come back with two different verdicts. A send that arrives while the
    // first is still running waits for it (runOnce); a later one gets the
    // stored result (findStoredResult). See services/image-dedupe.js.
    const imageHash = imageDedupe.hashImage(imageBuffer);
    const imageKey = imageDedupe.imageKey(imageHash, { merchantId, invoiceId, expectedPayment });

    const { value, joined } = await imageDedupe.runOnce(imageKey, async () => {
      const stored = await findStoredResult(imageKey);
      if (stored) return stored;
      const response = await runVerification({
        imageBuffer, filename, expectedPayment, invoiceId, customerId, merchantId, imageHash, imageKey
      });
      return { response, originalId: null, submittedAt: null };
    });

    if (value.originalId || joined) {
      const originalId = value.originalId || value.response.record_id;
      console.log(
        `IMAGE-DEDUPE duplicate=1 source=${value.originalId ? 'stored' : 'in_flight'} ` +
        `original=${originalId} verdict=${value.response.verification.status} ` +
        `hash=${imageHash.slice(0, 12)}`
      );
      return res.json(asImageDuplicate(value.response, originalId, value.submittedAt));
    }

    res.json(value.response);

  } catch (error) {
    console.error('Verification error:', error);

    res.status(500).json({
      success: false,
      error: 'Verification failed',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/verify/:id
 * Get verification result by ID
 */
router.get('/:id', apiKeyAuth, async (req, res) => {
  try {
    const payment = await payments.findById(req.params.id);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Payment record ${req.params.id} not found`
      });
    }

    res.json({
      success: true,
      recordId: payment._id,
      invoiceId: payment.invoice_id,
      screenshotId: payment.screenshotId,
      verification: {
        status: payment.verificationStatus,
        paymentLabel: payment.paymentLabel,
        confidence: payment.confidence,
        rejectionReason: payment.rejectionReason
      },
      payment: {
        amount: payment.amount,
        currency: payment.currency,
        transactionId: payment.transactionId,
        transactionDate: payment.transactionDate,
        fromAccount: payment.fromAccount,
        toAccount: payment.toAccount,
        recipientName: payment.recipientName,
        bankName: payment.bankName
      },
      uploadedAt: payment.uploadedAt
    });

  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/verify/:id/image
 * Get screenshot image by payment ID
 */
router.get('/:id/image', apiKeyAuth, async (req, res) => {
  try {
    const payment = await payments.findById(req.params.id);

    if (!payment || !payment.screenshotId) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: 'Screenshot not found'
      });
    }

    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Disposition', `inline; filename="${req.params.id}.jpg"`);

    const stream = screenshots.getDownloadStream(payment.screenshotId);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(404).json({
          success: false,
          error: 'Not found',
          message: 'Screenshot file could not be retrieved'
        });
      }
    });
    stream.pipe(res);

  } catch (error) {
    console.error('Error fetching screenshot:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

module.exports = router;
