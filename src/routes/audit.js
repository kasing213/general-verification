'use strict';

const express = require('express');
const { merchantAuth, adminAuth, merchantAccessControl, authenticateMerchant } = require('../middleware/merchant-auth');
const AuditService = require('../services/audit-service');
const NotificationService = require('../services/notification-service');
const { payments, screenshots, auditLogs, notifications } = require('../db/mongo');

const router = express.Router();
const auditService = new AuditService();
const notificationService = new NotificationService();

/**
 * POST /api/v1/audit/login
 * Merchant login endpoint
 */
router.post('/login', async (req, res) => {
  try {
    const { merchant_id, api_key } = req.body;

    if (!merchant_id || !api_key) {
      return res.status(400).json({
        success: false,
        error: 'Missing credentials',
        message: 'merchant_id and api_key are required'
      });
    }

    const authResult = await authenticateMerchant({ merchant_id, api_key });

    // Set HTTP-only cookie for web interface
    res.cookie('merchant_token', authResult.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    res.json({
      success: true,
      token: authResult.token,
      merchant: authResult.merchant,
      expires_in: authResult.expires_in
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(401).json({
      success: false,
      error: 'Authentication failed',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/audit/logout
 * Merchant logout endpoint
 */
router.post('/logout', merchantAuth, (req, res) => {
  // Clear cookie
  res.clearCookie('merchant_token');

  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

/**
 * GET /api/v1/audit/me
 * Get current merchant info
 */
router.get('/me', merchantAuth, (req, res) => {
  res.json({
    success: true,
    merchant: req.merchant
  });
});

/**
 * GET /api/v1/audit/payments
 * Get payments for audit interface with filtering
 */
router.get('/payments', merchantAuth, merchantAccessControl, async (req, res) => {
  try {
    const merchantId = req.merchantId;
    const {
      status,
      date_from: dateFrom,
      date_to: dateTo,
      is_bank_statement: isBankStatement,
      confidence,
      page = 1,
      limit = 20
    } = req.query;

    const filters = {};
    if (status) filters.status = status;
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;
    if (isBankStatement !== undefined) filters.isBankStatement = isBankStatement === 'true';
    if (confidence) filters.confidence = confidence;

    const result = await auditService.getPaymentsForAudit(merchantId, filters, {
      page: parseInt(page),
      limit: parseInt(limit)
    });

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('Error getting payments for audit:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/audit/payment/:id
 * Get detailed payment info
 */
router.get('/payment/:id', merchantAuth, merchantAccessControl, async (req, res) => {
  try {
    const paymentId = req.params.id;
    const merchantId = req.merchantId;

    const payment = await payments.findById(paymentId);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found',
        message: `Payment ${paymentId} not found`
      });
    }

    // Check merchant access
    if (payment.merchant_id && payment.merchant_id !== merchantId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You can only access your own payments'
      });
    }

    // Get audit history
    const auditHistory = await auditService.getPaymentAuditHistory(paymentId, merchantId);

    // Get available status transitions
    const availableTransitions = auditService.getAvailableTransitions(payment.verificationStatus);

    res.json({
      success: true,
      payment: payment,
      audit_history: auditHistory,
      available_transitions: availableTransitions
    });

  } catch (error) {
    console.error('Error getting payment details:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * PATCH /api/v1/audit/payment/:id/status
 * Update payment status
 */
router.patch('/payment/:id/status', merchantAuth, merchantAccessControl, async (req, res) => {
  try {
    const paymentId = req.params.id;
    const merchantId = req.merchantId;
    const { new_status, reason, notes } = req.body;

    if (!new_status) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field',
        message: 'new_status is required'
      });
    }

    const result = await auditService.updatePaymentStatus(paymentId, new_status, merchantId, {
      reason,
      notes
    });

    res.json({
      success: true,
      message: 'Payment status updated successfully',
      ...result
    });

  } catch (error) {
    console.error('Error updating payment status:', error);

    if (error.message.includes('Access denied') || error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'Not found or access denied',
        message: error.message
      });
    }

    if (error.message.includes('Invalid') || error.message.includes('required')) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        message: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/audit/payment/:id/image
 * Get payment screenshot
 */
router.get('/payment/:id/image', merchantAuth, merchantAccessControl, async (req, res) => {
  try {
    const paymentId = req.params.id;
    const merchantId = req.merchantId;

    const payment = await payments.findById(paymentId);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found',
        message: `Payment ${paymentId} not found`
      });
    }

    // Check merchant access
    if (payment.merchant_id && payment.merchant_id !== merchantId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You can only access your own payments'
      });
    }

    if (!payment.screenshotId) {
      return res.status(404).json({
        success: false,
        error: 'Screenshot not found',
        message: 'No screenshot available for this payment'
      });
    }

    const imageBuffer = await screenshots.download(payment.screenshotId);

    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Disposition', `inline; filename="${paymentId}.jpg"`);
    res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.send(imageBuffer);

  } catch (error) {
    console.error('Error getting payment screenshot:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/audit/payment/:id/audit-logs
 * Get audit history for specific payment
 */
router.get('/payment/:id/audit-logs', merchantAuth, merchantAccessControl, async (req, res) => {
  try {
    const paymentId = req.params.id;
    const merchantId = req.merchantId;

    const auditHistory = await auditService.getPaymentAuditHistory(paymentId, merchantId);

    res.json({
      success: true,
      payment_id: paymentId,
      audit_logs: auditHistory
    });

  } catch (error) {
    console.error('Error getting audit logs:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/audit/statistics
 * Get payment statistics for dashboard
 */
router.get('/statistics', merchantAuth, merchantAccessControl, async (req, res) => {
  try {
    const merchantId = req.merchantId;
    const { timeframe = '7d' } = req.query;

    const stats = await auditService.getPaymentStatistics(merchantId, { timeframe });

    res.json({
      success: true,
      ...stats
    });

  } catch (error) {
    console.error('Error getting statistics:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/audit/notifications
 * Get notification history
 */
router.get('/notifications', merchantAuth, merchantAccessControl, async (req, res) => {
  try {
    const merchantId = req.merchantId;
    const { page = 1, limit = 50, type } = req.query;

    const notifs = await notificationService.getNotificationHistory(merchantId, {
      page: parseInt(page),
      limit: parseInt(limit),
      type
    });

    const unreadCount = await notificationService.getUnreadNotificationCount(merchantId);

    res.json({
      success: true,
      notifications: notifs,
      unread_count: unreadCount
    });

  } catch (error) {
    console.error('Error getting notifications:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * PATCH /api/v1/audit/notifications/:id/read
 * Mark notification as read
 */
router.patch('/notifications/:id/read', merchantAuth, merchantAccessControl, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const merchantId = req.merchantId;

    await notificationService.markNotificationAsRead(notificationId, merchantId);

    res.json({
      success: true,
      message: 'Notification marked as read'
    });

  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/audit/notifications/mark-all-read
 * Mark all notifications as read
 */
router.post('/notifications/mark-all-read', merchantAuth, merchantAccessControl, async (req, res) => {
  try {
    const merchantId = req.merchantId;

    await notificationService.markAllNotificationsAsRead(merchantId);

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });

  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * Admin-only endpoints
 */

/**
 * GET /api/v1/audit/admin/payments
 * Get all payments (admin only)
 */
router.get('/admin/payments', adminAuth, async (req, res) => {
  try {
    const {
      merchant_id: merchantId,
      status,
      page = 1,
      limit = 50
    } = req.query;

    const filters = {};
    if (status) filters.status = status;

    const { getDb } = require('../db/mongo');
    const db = getDb();

    const query = merchantId ? { merchant_id: merchantId, ...filters } : filters;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const paymentsData = await db.collection('payments')
      .find(query)
      .sort({ uploadedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalCount = await db.collection('payments').countDocuments(query);

    res.json({
      success: true,
      payments: paymentsData,
      pagination: {
        current_page: parseInt(page),
        per_page: parseInt(limit),
        total_count: totalCount,
        total_pages: Math.ceil(totalCount / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Error getting admin payments:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/audit/admin/audit-logs
 * Get all audit logs (admin only)
 */
router.get('/admin/audit-logs', adminAuth, async (req, res) => {
  try {
    const {
      merchant_id: merchantId,
      payment_id: paymentId,
      action,
      page = 1,
      limit = 100
    } = req.query;

    const filters = {};
    if (merchantId) filters.merchant_id = merchantId;
    if (paymentId) filters.payment_id = paymentId;
    if (action) filters.action = action;

    const logs = await auditLogs.list(filters, {
      page: parseInt(page),
      limit: parseInt(limit)
    });

    res.json({
      success: true,
      audit_logs: logs
    });

  } catch (error) {
    console.error('Error getting admin audit logs:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

module.exports = router;