'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { apiKeyAuth } = require('../middleware/auth');
const { invoices, payments } = require('../db/mongo');

const router = express.Router();

/**
 * POST /api/v1/invoices
 * Create new invoice
 */
router.post('/', apiKeyAuth, async (req, res) => {
  try {
    const { customer_id, expectedPayment, expires_at, metadata } = req.body;

    // Validate required fields
    if (!expectedPayment || !expectedPayment.amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'expectedPayment.amount is required'
      });
    }

    // Generate invoice ID
    const invoiceId = req.body._id || `INV-${new Date().getFullYear()}-${uuidv4().slice(0, 8).toUpperCase()}`;

    const invoice = {
      _id: invoiceId,
      customer_id: customer_id || null,

      // Expected payment (null = skip that verification)
      expectedPayment: {
        amount: expectedPayment.amount,
        currency: expectedPayment.currency || 'KHR',
        bank: expectedPayment.bank || null,
        toAccount: expectedPayment.toAccount || null,
        recipientNames: expectedPayment.recipientNames || null,
        tolerancePercent: expectedPayment.tolerancePercent || 5
      },

      // Status
      status: 'pending',
      created_at: new Date(),
      expires_at: expires_at ? new Date(expires_at) : null,
      verified_at: null,
      payment_id: null,

      // Optional metadata
      metadata: metadata || {}
    };

    await invoices.create(invoice);

    res.status(201).json({
      success: true,
      message: 'Invoice created',
      invoice
    });

  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/invoices/:id
 * Get invoice by ID
 */
router.get('/:id', apiKeyAuth, async (req, res) => {
  try {
    const invoice = await invoices.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Invoice ${req.params.id} not found`
      });
    }

    // Get associated payments
    const invoicePayments = await payments.findByInvoiceId(req.params.id);

    res.json({
      success: true,
      invoice,
      payments: invoicePayments
    });

  } catch (error) {
    console.error('Error fetching invoice:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * PUT /api/v1/invoices/:id
 * Update invoice
 */
router.put('/:id', apiKeyAuth, async (req, res) => {
  try {
    const invoice = await invoices.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Invoice ${req.params.id} not found`
      });
    }

    // Only allow updating certain fields
    const allowedUpdates = ['customer_id', 'expectedPayment', 'expires_at', 'status', 'metadata'];
    const updates = {};

    for (const key of allowedUpdates) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    // Handle expectedPayment merge
    if (updates.expectedPayment) {
      updates.expectedPayment = {
        ...invoice.expectedPayment,
        ...updates.expectedPayment
      };
    }

    await invoices.update(req.params.id, updates);

    const updatedInvoice = await invoices.findById(req.params.id);

    res.json({
      success: true,
      message: 'Invoice updated',
      invoice: updatedInvoice
    });

  } catch (error) {
    console.error('Error updating invoice:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/invoices
 * List invoices with filters
 */
router.get('/', apiKeyAuth, async (req, res) => {
  try {
    const { status, customer_id, limit = 100, skip = 0 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (customer_id) filter.customer_id = customer_id;

    const invoiceList = await invoices.list(filter, {
      limit: parseInt(limit),
      skip: parseInt(skip)
    });

    res.json({
      success: true,
      count: invoiceList.length,
      invoices: invoiceList
    });

  } catch (error) {
    console.error('Error listing invoices:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * DELETE /api/v1/invoices/:id
 * Delete invoice (soft delete - set status to cancelled)
 */
router.delete('/:id', apiKeyAuth, async (req, res) => {
  try {
    const invoice = await invoices.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Invoice ${req.params.id} not found`
      });
    }

    // Soft delete - set status to cancelled
    await invoices.update(req.params.id, {
      status: 'cancelled',
      cancelled_at: new Date()
    });

    res.json({
      success: true,
      message: `Invoice ${req.params.id} cancelled`
    });

  } catch (error) {
    console.error('Error deleting invoice:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

module.exports = router;
