'use strict';

const { v4: uuidv4 } = require('uuid');
const { payments, auditLogs, notifications } = require('../db/mongo');
const NotificationService = require('./notification-service');

/**
 * Audit Service
 * Handles payment status changes with full audit trail and notifications
 */
class AuditService {
  constructor() {
    this.notificationService = new NotificationService();
    this.validStatuses = ['verified', 'pending', 'rejected'];
    this.validTransitions = {
      'verified': ['pending', 'rejected'],
      'pending': ['verified', 'rejected'],
      'rejected': ['verified', 'pending']
    };
  }

  /**
   * Update payment status with full audit trail
   * @param {string} paymentId - Payment ID
   * @param {string} newStatus - New status (verified, pending, rejected)
   * @param {string} merchantId - Merchant ID making the change
   * @param {object} options - Additional options
   * @returns {Promise<object>} - Result object
   */
  async updatePaymentStatus(paymentId, newStatus, merchantId, options = {}) {
    try {
      const { reason, confidence, notes } = options;

      // Validate status
      if (!this.validStatuses.includes(newStatus)) {
        throw new Error(`Invalid status: ${newStatus}. Valid statuses: ${this.validStatuses.join(', ')}`);
      }

      // Get current payment
      const payment = await payments.findById(paymentId);
      if (!payment) {
        throw new Error(`Payment not found: ${paymentId}`);
      }

      // Check merchant access
      if (payment.merchant_id && payment.merchant_id !== merchantId) {
        throw new Error(`Access denied: Payment belongs to different merchant`);
      }

      const oldStatus = payment.verificationStatus;

      // Validate transition
      if (oldStatus === newStatus) {
        throw new Error(`Payment is already ${newStatus}`);
      }

      if (!this.validTransitions[oldStatus]?.includes(newStatus)) {
        throw new Error(`Invalid status transition: ${oldStatus} → ${newStatus}`);
      }

      // Special handling for low confidence rejections
      if (newStatus === 'rejected' && payment.isBankStatement !== false && payment.confidence === 'low') {
        if (!reason) {
          throw new Error('Reason is required when rejecting low confidence bank statements');
        }
      }

      // Update payment status
      await payments.updateStatus(paymentId, newStatus, merchantId, reason);

      // Create audit log
      const auditLog = {
        payment_id: paymentId,
        merchant_id: merchantId,
        action: 'status_change',
        old_status: oldStatus,
        new_status: newStatus,
        reason: reason || null,
        confidence: confidence || payment.confidence,
        notes: notes || null,
        metadata: {
          amount: payment.amount,
          currency: payment.currency,
          transaction_id: payment.transactionId,
          is_bank_statement: payment.isBankStatement
        }
      };

      await auditLogs.create(auditLog);

      // Create notification
      const notification = {
        merchant_id: merchantId,
        payment_id: paymentId,
        type: 'status_change',
        title: `Payment Status Updated`,
        message: `Payment ${paymentId} status changed from ${oldStatus} to ${newStatus}`,
        data: {
          payment_id: paymentId,
          old_status: oldStatus,
          new_status: newStatus,
          reason: reason,
          amount: payment.amount,
          currency: payment.currency
        }
      };

      await notifications.create(notification);

      // Send real-time notification
      await this.notificationService.sendRealTimeNotification(merchantId, notification);

      // Update invoice status if payment is verified
      if (newStatus === 'verified' && payment.invoice_id) {
        const { invoices } = require('../db/mongo');
        await invoices.update(payment.invoice_id, {
          status: 'verified',
          verified_at: new Date(),
          payment_id: paymentId
        });
      }

      return {
        success: true,
        payment_id: paymentId,
        old_status: oldStatus,
        new_status: newStatus,
        audit_log_id: auditLog.id,
        notification_id: notification.id
      };

    } catch (error) {
      console.error('Error updating payment status:', error);
      throw error;
    }
  }

  /**
   * Get audit history for a payment
   * @param {string} paymentId - Payment ID
   * @param {string} merchantId - Merchant ID (for access control)
   * @returns {Promise<array>} - Audit history
   */
  async getPaymentAuditHistory(paymentId, merchantId = null) {
    try {
      // Verify payment exists and merchant access
      const payment = await payments.findById(paymentId);
      if (!payment) {
        throw new Error(`Payment not found: ${paymentId}`);
      }

      if (merchantId && payment.merchant_id && payment.merchant_id !== merchantId) {
        throw new Error(`Access denied: Payment belongs to different merchant`);
      }

      const logs = await auditLogs.findByPaymentId(paymentId);
      return logs;

    } catch (error) {
      console.error('Error getting audit history:', error);
      throw error;
    }
  }

  /**
   * Get payments for audit interface
   * @param {string} merchantId - Merchant ID
   * @param {object} filters - Filter options
   * @param {object} options - Query options
   * @returns {Promise<object>} - Payments with metadata
   */
  async getPaymentsForAudit(merchantId, filters = {}, options = {}) {
    try {
      const { status, dateFrom, dateTo, isBankStatement, confidence } = filters;
      const { page = 1, limit = 20 } = options;

      const skip = (page - 1) * limit;
      const query = { merchant_id: merchantId };

      // Apply filters
      if (status) query.verificationStatus = status;
      if (isBankStatement !== undefined) query.isBankStatement = isBankStatement;
      if (confidence) query.confidence = confidence;

      if (dateFrom || dateTo) {
        query.uploadedAt = {};
        if (dateFrom) query.uploadedAt.$gte = new Date(dateFrom);
        if (dateTo) query.uploadedAt.$lte = new Date(dateTo);
      }

      const paymentsData = await payments.findByMerchantId(merchantId, query, {
        limit,
        skip,
        sort: { uploadedAt: -1 }
      });

      // Get total count for pagination
      const { getDb } = require('../db/mongo');
      const db = getDb();
      const totalCount = await db.collection('payments').countDocuments(query);

      return {
        payments: paymentsData,
        pagination: {
          current_page: page,
          per_page: limit,
          total_count: totalCount,
          total_pages: Math.ceil(totalCount / limit)
        },
        filters_applied: filters
      };

    } catch (error) {
      console.error('Error getting payments for audit:', error);
      throw error;
    }
  }

  /**
   * Get payment statistics for dashboard
   * @param {string} merchantId - Merchant ID
   * @param {object} options - Options (timeframe, etc.)
   * @returns {Promise<object>} - Statistics
   */
  async getPaymentStatistics(merchantId, options = {}) {
    try {
      const { timeframe = '7d' } = options;

      // Calculate date range
      const now = new Date();
      let startDate;
      switch (timeframe) {
        case '24h':
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case '7d':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }

      const { getDb } = require('../db/mongo');
      const db = getDb();

      const pipeline = [
        {
          $match: {
            merchant_id: merchantId,
            uploadedAt: { $gte: startDate }
          }
        },
        {
          $group: {
            _id: '$verificationStatus',
            count: { $sum: 1 },
            total_amount: { $sum: '$amount' }
          }
        }
      ];

      const results = await db.collection('payments').aggregate(pipeline).toArray();

      const stats = {
        total: 0,
        verified: 0,
        pending: 0,
        rejected: 0,
        total_amount: 0,
        low_confidence_count: 0
      };

      results.forEach(result => {
        stats[result._id] = result.count;
        stats.total += result.count;
        stats.total_amount += result.total_amount || 0;
      });

      // Get low confidence count
      const lowConfidenceCount = await db.collection('payments').countDocuments({
        merchant_id: merchantId,
        confidence: 'low',
        uploadedAt: { $gte: startDate }
      });

      stats.low_confidence_count = lowConfidenceCount;

      return {
        timeframe,
        start_date: startDate,
        end_date: now,
        statistics: stats
      };

    } catch (error) {
      console.error('Error getting payment statistics:', error);
      throw error;
    }
  }

  /**
   * Validate status transition
   * @param {string} currentStatus - Current status
   * @param {string} newStatus - New status
   * @returns {boolean} - Is valid transition
   */
  isValidStatusTransition(currentStatus, newStatus) {
    return this.validTransitions[currentStatus]?.includes(newStatus) || false;
  }

  /**
   * Get available status transitions for current status
   * @param {string} currentStatus - Current status
   * @returns {array} - Available transitions
   */
  getAvailableTransitions(currentStatus) {
    return this.validTransitions[currentStatus] || [];
  }
}

module.exports = AuditService;