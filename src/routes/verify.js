'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const apiKeyAuth = require('../middleware/auth');
const { verifyPayment } = require('../core/verification');
const { invoices, payments, fraudAlerts, screenshots } = require('../db/mongo');
const config = require('../config/schema');

const router = express.Router();

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
        recipientNames: expectedPaymentParam?.recipientNames ?? invoice.expectedPayment?.recipientNames ?? null,
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
        recipientNames: expectedPaymentParam.recipientNames || null,
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
    const result = await verifyPayment(imageBuffer, expectedPayment, {
      invoiceId,
      customerId
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

      // Metadata
      uploadedAt: new Date(),
      processedAt: new Date()
    };

    await payments.create(paymentRecord);

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

    // Return result
    res.json(result);

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

    const imageBuffer = await screenshots.download(payment.screenshotId);

    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Disposition', `inline; filename="${req.params.id}.jpg"`);
    res.send(imageBuffer);

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
