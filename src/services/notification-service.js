'use strict';

/**
 * Notification Service
 * Handles real-time notifications, email alerts, and SMS notifications
 */

const { notifications } = require('../db/mongo');

class NotificationService {
  constructor() {
    this.socketServer = null;
    this.emailEnabled = process.env.EMAIL_ENABLED === 'true';
    this.smsEnabled = process.env.SMS_ENABLED === 'true';
  }

  /**
   * Initialize WebSocket server reference
   * @param {object} io - Socket.io server instance
   */
  setSocketServer(io) {
    this.socketServer = io;
    console.log('🔌 Notification Service connected to WebSocket server');
  }

  /**
   * Send real-time notification via WebSocket
   * @param {string} merchantId - Target merchant ID
   * @param {object} notification - Notification data
   */
  async sendRealTimeNotification(merchantId, notification) {
    try {
      if (!this.socketServer) {
        console.log('⚠️  WebSocket server not initialized, skipping real-time notification');
        return;
      }

      // Send to specific merchant room
      const room = `merchant_${merchantId}`;
      this.socketServer.to(room).emit('notification', {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        data: notification.data,
        timestamp: notification.created_at
      });

      console.log(`📡 Real-time notification sent to ${room}:`, notification.title);

    } catch (error) {
      console.error('Error sending real-time notification:', error);
    }
  }

  /**
   * Send email notification
   * @param {string} merchantId - Merchant ID
   * @param {string} email - Merchant email
   * @param {object} notification - Notification data
   */
  async sendEmailNotification(merchantId, email, notification) {
    try {
      if (!this.emailEnabled) {
        console.log('📧 Email notifications disabled');
        return;
      }

      // In production, implement actual email sending (SendGrid, SES, etc.)
      console.log(`📧 Email notification sent to ${email}:`, notification.title);

      // Log the email notification
      await notifications.create({
        merchant_id: merchantId,
        type: 'email_sent',
        title: 'Email Notification Sent',
        message: `Email sent to ${email}: ${notification.title}`,
        data: {
          email: email,
          original_notification: notification
        }
      });

    } catch (error) {
      console.error('Error sending email notification:', error);
    }
  }

  /**
   * Send SMS notification
   * @param {string} merchantId - Merchant ID
   * @param {string} phone - Merchant phone
   * @param {object} notification - Notification data
   */
  async sendSMSNotification(merchantId, phone, notification) {
    try {
      if (!this.smsEnabled) {
        console.log('📱 SMS notifications disabled');
        return;
      }

      // In production, implement actual SMS sending (Twilio, AWS SNS, etc.)
      const smsText = `${notification.title}: ${notification.message}`;
      console.log(`📱 SMS notification sent to ${phone}:`, smsText);

      // Log the SMS notification
      await notifications.create({
        merchant_id: merchantId,
        type: 'sms_sent',
        title: 'SMS Notification Sent',
        message: `SMS sent to ${phone}: ${notification.title}`,
        data: {
          phone: phone,
          sms_text: smsText,
          original_notification: notification
        }
      });

    } catch (error) {
      console.error('Error sending SMS notification:', error);
    }
  }

  /**
   * Send comprehensive notification (real-time + email + SMS)
   * @param {string} merchantId - Merchant ID
   * @param {object} notificationData - Notification data
   * @param {object} merchantPreferences - Merchant notification preferences
   */
  async sendComprehensiveNotification(merchantId, notificationData, merchantPreferences = {}) {
    try {
      // Create database notification
      const notification = await notifications.create({
        merchant_id: merchantId,
        ...notificationData
      });

      // Send real-time notification (always)
      await this.sendRealTimeNotification(merchantId, notification);

      // Send email if enabled and merchant has email preferences
      if (merchantPreferences.email_enabled && merchantPreferences.email) {
        await this.sendEmailNotification(merchantId, merchantPreferences.email, notification);
      }

      // Send SMS if enabled and merchant has SMS preferences
      if (merchantPreferences.sms_enabled && merchantPreferences.phone) {
        await this.sendSMSNotification(merchantId, merchantPreferences.phone, notification);
      }

      return notification;

    } catch (error) {
      console.error('Error sending comprehensive notification:', error);
      throw error;
    }
  }

  /**
   * Send payment status change notification
   * @param {object} params - { merchantId, paymentId, oldStatus, newStatus, amount, currency }
   */
  async notifyPaymentStatusChange(params) {
    const { merchantId, paymentId, oldStatus, newStatus, amount, currency, reason } = params;

    const statusEmojis = {
      verified: '✅',
      pending: '⏳',
      rejected: '❌'
    };

    const notification = {
      type: 'payment_status_change',
      title: `${statusEmojis[newStatus]} Payment ${newStatus.toUpperCase()}`,
      message: `Payment ${paymentId} changed from ${oldStatus} to ${newStatus}`,
      data: {
        payment_id: paymentId,
        old_status: oldStatus,
        new_status: newStatus,
        amount: amount,
        currency: currency,
        reason: reason
      }
    };

    return this.sendRealTimeNotification(merchantId, notification);
  }

  /**
   * Send low confidence alert notification
   * @param {object} params - { merchantId, paymentId, confidence, amount, currency }
   */
  async notifyLowConfidencePayment(params) {
    const { merchantId, paymentId, confidence, amount, currency } = params;

    const notification = {
      type: 'low_confidence_alert',
      title: '⚠️ Low Confidence Payment',
      message: `Payment ${paymentId} has ${confidence} confidence and requires manual review`,
      data: {
        payment_id: paymentId,
        confidence: confidence,
        amount: amount,
        currency: currency,
        action_required: true
      }
    };

    return this.sendRealTimeNotification(merchantId, notification);
  }

  /**
   * Send fraud alert notification
   * @param {object} params - { merchantId, paymentId, alertType, severity }
   */
  async notifyFraudAlert(params) {
    const { merchantId, paymentId, alertType, severity } = params;

    const severityEmojis = {
      low: '🟡',
      medium: '🟠',
      high: '🔴'
    };

    const notification = {
      type: 'fraud_alert',
      title: `${severityEmojis[severity]} Fraud Alert`,
      message: `${alertType} detected for payment ${paymentId}`,
      data: {
        payment_id: paymentId,
        alert_type: alertType,
        severity: severity,
        action_required: true
      }
    };

    return this.sendRealTimeNotification(merchantId, notification);
  }

  /**
   * Get notification history for merchant
   * @param {string} merchantId - Merchant ID
   * @param {object} options - Query options
   * @returns {Promise<array>} - Notification history
   */
  async getNotificationHistory(merchantId, options = {}) {
    try {
      const { limit = 50, page = 1, type } = options;
      const skip = (page - 1) * limit;

      let filter = { merchant_id: merchantId };
      if (type) filter.type = type;

      return await notifications.findByMerchantId(merchantId, {
        limit,
        skip,
        sort: { created_at: -1 }
      });

    } catch (error) {
      console.error('Error getting notification history:', error);
      throw error;
    }
  }

  /**
   * Mark notification as read
   * @param {string} notificationId - Notification ID
   * @param {string} merchantId - Merchant ID (for access control)
   */
  async markNotificationAsRead(notificationId, merchantId) {
    try {
      // Verify notification belongs to merchant
      const { getDb } = require('../db/mongo');
      const db = getDb();

      const notification = await db.collection('notifications').findOne({
        id: notificationId,
        merchant_id: merchantId
      });

      if (!notification) {
        throw new Error('Notification not found or access denied');
      }

      await notifications.markAsRead(notificationId);

      // Send real-time update
      await this.sendRealTimeNotification(merchantId, {
        type: 'notification_read',
        data: { notification_id: notificationId }
      });

    } catch (error) {
      console.error('Error marking notification as read:', error);
      throw error;
    }
  }

  /**
   * Mark all notifications as read for merchant
   * @param {string} merchantId - Merchant ID
   */
  async markAllNotificationsAsRead(merchantId) {
    try {
      await notifications.markAllAsRead(merchantId);

      // Send real-time update
      await this.sendRealTimeNotification(merchantId, {
        type: 'all_notifications_read',
        data: { merchant_id: merchantId }
      });

    } catch (error) {
      console.error('Error marking all notifications as read:', error);
      throw error;
    }
  }

  /**
   * Get unread notification count
   * @param {string} merchantId - Merchant ID
   * @returns {Promise<number>} - Unread count
   */
  async getUnreadNotificationCount(merchantId) {
    try {
      const { getDb } = require('../db/mongo');
      const db = getDb();

      return await db.collection('notifications').countDocuments({
        merchant_id: merchantId,
        status: 'pending'
      });

    } catch (error) {
      console.error('Error getting unread notification count:', error);
      return 0;
    }
  }

  /**
   * Cleanup old notifications (called by cron job)
   * @param {number} daysOld - Days old to delete (default 30)
   */
  async cleanupOldNotifications(daysOld = 30) {
    try {
      const result = await notifications.deleteOld(daysOld);
      console.log(`🧹 Cleaned up ${result.deletedCount} old notifications`);
      return result;

    } catch (error) {
      console.error('Error cleaning up old notifications:', error);
      throw error;
    }
  }
}

module.exports = NotificationService;