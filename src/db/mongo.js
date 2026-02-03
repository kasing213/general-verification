'use strict';

const { MongoClient, GridFSBucket } = require('mongodb');
const { v4: uuidv4 } = require('uuid');

// MongoDB connection
const MONGO_URL = process.env.MONGO_URL;
const DB_NAME = process.env.DB_NAME || 'ocrServiceDB';

let client = null;
let db = null;

// Collections
let invoicesCollection = null;
let paymentsCollection = null;
let fraudAlertsCollection = null;
let auditLogsCollection = null;
let notificationsCollection = null;

// GridFS bucket for image storage
let screenshotsBucket = null;

/**
 * Connect to MongoDB
 * @returns {Promise<object>} - Database instance
 */
async function connect() {
  if (db) return db;

  if (!MONGO_URL) {
    throw new Error('MONGO_URL environment variable is required');
  }

  console.log('Connecting to MongoDB...');

  client = new MongoClient(MONGO_URL, {
    tls: true,
    tlsAllowInvalidCertificates: true
  });

  await client.connect();
  db = client.db(DB_NAME);

  // Initialize collections
  invoicesCollection = db.collection('invoices');
  paymentsCollection = db.collection('payments');
  fraudAlertsCollection = db.collection('fraudAlerts');
  auditLogsCollection = db.collection('auditLogs');
  notificationsCollection = db.collection('notifications');

  // Initialize GridFS bucket for screenshots
  screenshotsBucket = new GridFSBucket(db, { bucketName: 'screenshots' });
  console.log('GridFS bucket initialized: screenshots');

  // Create indexes
  await createIndexes();

  console.log(`Connected to MongoDB: ${DB_NAME}`);
  return db;
}

/**
 * Create database indexes
 */
async function createIndexes() {
  try {
    // Invoices indexes
    await invoicesCollection.createIndex({ customer_id: 1 });
    await invoicesCollection.createIndex({ status: 1 });
    await invoicesCollection.createIndex({ created_at: -1 });

    // Payments indexes
    await paymentsCollection.createIndex({ invoice_id: 1 });
    await paymentsCollection.createIndex({ customer_id: 1 });
    await paymentsCollection.createIndex({ merchant_id: 1 });
    await paymentsCollection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
    await paymentsCollection.createIndex({ verificationStatus: 1 });
    await paymentsCollection.createIndex({ uploadedAt: -1 });

    // Fraud alerts indexes
    await fraudAlertsCollection.createIndex({ alertId: 1 }, { unique: true });
    await fraudAlertsCollection.createIndex({ payment_id: 1 });
    await fraudAlertsCollection.createIndex({ invoice_id: 1 });
    await fraudAlertsCollection.createIndex({ reviewStatus: 1 });
    await fraudAlertsCollection.createIndex({ detectedAt: -1 });

    // Audit logs indexes
    await auditLogsCollection.createIndex({ payment_id: 1 });
    await auditLogsCollection.createIndex({ merchant_id: 1 });
    await auditLogsCollection.createIndex({ timestamp: -1 });
    await auditLogsCollection.createIndex({ action: 1 });

    // Notifications indexes
    await notificationsCollection.createIndex({ merchant_id: 1 });
    await notificationsCollection.createIndex({ payment_id: 1 });
    await notificationsCollection.createIndex({ status: 1 });
    await notificationsCollection.createIndex({ created_at: -1 });

    console.log('Database indexes created');
  } catch (error) {
    console.error('Error creating indexes:', error.message);
  }
}

/**
 * Disconnect from MongoDB
 */
async function disconnect() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('Disconnected from MongoDB');
  }
}

/**
 * Get database instance
 * @returns {object} - Database instance
 */
function getDb() {
  if (!db) {
    throw new Error('Database not connected. Call connect() first.');
  }
  return db;
}

/**
 * Get collections
 */
function getCollections() {
  return {
    invoices: invoicesCollection,
    payments: paymentsCollection,
    fraudAlerts: fraudAlertsCollection
  };
}

// Invoice operations
const invoices = {
  async findById(id) {
    return invoicesCollection.findOne({ _id: id });
  },

  async findByCustomerId(customerId) {
    return invoicesCollection.find({ customer_id: customerId }).toArray();
  },

  async create(invoice) {
    const result = await invoicesCollection.insertOne({
      ...invoice,
      created_at: new Date(),
      status: invoice.status || 'pending'
    });
    return result;
  },

  async update(id, updates) {
    return invoicesCollection.updateOne(
      { _id: id },
      { $set: { ...updates, updated_at: new Date() } }
    );
  },

  async list(filter = {}, options = {}) {
    const { limit = 100, skip = 0, sort = { created_at: -1 } } = options;
    return invoicesCollection.find(filter).sort(sort).skip(skip).limit(limit).toArray();
  }
};

// Payment operations
const payments = {
  async findById(id) {
    return paymentsCollection.findOne({ _id: id });
  },

  async findByTransactionId(transactionId) {
    return paymentsCollection.findOne({ transactionId });
  },

  async findByInvoiceId(invoiceId) {
    return paymentsCollection.find({ invoice_id: invoiceId }).toArray();
  },

  async create(payment) {
    const result = await paymentsCollection.insertOne({
      ...payment,
      uploadedAt: new Date()
    });
    return result;
  },

  async update(id, updates) {
    return paymentsCollection.updateOne(
      { _id: id },
      { $set: { ...updates, updatedAt: new Date() } }
    );
  },

  async findByMerchantId(merchantId, filter = {}, options = {}) {
    const { limit = 100, skip = 0, sort = { uploadedAt: -1 } } = options;
    const query = { merchant_id: merchantId, ...filter };
    return paymentsCollection.find(query).sort(sort).skip(skip).limit(limit).toArray();
  },

  async updateStatus(id, newStatus, merchantId, reason = null) {
    return paymentsCollection.updateOne(
      { _id: id },
      {
        $set: {
          verificationStatus: newStatus,
          updatedAt: new Date(),
          lastUpdatedBy: merchantId,
          statusChangeReason: reason
        }
      }
    );
  }
};

// Fraud alert operations
const fraudAlerts = {
  async findById(id) {
    return fraudAlertsCollection.findOne({ _id: id });
  },

  async findByAlertId(alertId) {
    return fraudAlertsCollection.findOne({ alertId });
  },

  async create(alert) {
    const result = await fraudAlertsCollection.insertOne(alert);
    return result;
  },

  async updateReviewStatus(alertId, status, reviewedBy, notes) {
    return fraudAlertsCollection.updateOne(
      { alertId },
      {
        $set: {
          reviewStatus: status,
          reviewedBy,
          reviewedAt: new Date(),
          reviewNotes: notes
        }
      }
    );
  },

  async list(filter = {}, options = {}) {
    const { limit = 100, skip = 0, sort = { detectedAt: -1 } } = options;
    return fraudAlertsCollection.find(filter).sort(sort).skip(skip).limit(limit).toArray();
  }
};

// GridFS operations for screenshots
const screenshots = {
  /**
   * Upload image to GridFS
   * @param {Buffer} buffer - Image buffer
   * @param {string} filename - Filename
   * @param {object} metadata - Additional metadata
   * @returns {Promise<string>} - GridFS file ID
   */
  async upload(buffer, filename, metadata = {}) {
    return new Promise((resolve, reject) => {
      const uploadStream = screenshotsBucket.openUploadStream(filename, {
        metadata: {
          ...metadata,
          uploadedAt: new Date(),
          contentType: 'image/jpeg'
        }
      });

      uploadStream.on('finish', () => {
        console.log(`GridFS: Uploaded ${filename} (${uploadStream.id})`);
        resolve(uploadStream.id.toString());
      });

      uploadStream.on('error', reject);
      uploadStream.end(buffer);
    });
  },

  /**
   * Download image from GridFS
   * @param {string} fileId - GridFS file ID
   * @returns {Promise<Buffer>} - Image buffer
   */
  async download(fileId) {
    return new Promise((resolve, reject) => {
      const { ObjectId } = require('mongodb');
      const chunks = [];
      const downloadStream = screenshotsBucket.openDownloadStream(new ObjectId(fileId));

      downloadStream.on('data', chunk => chunks.push(chunk));
      downloadStream.on('end', () => resolve(Buffer.concat(chunks)));
      downloadStream.on('error', reject);
    });
  },

  /**
   * Get file info from GridFS
   * @param {string} fileId - GridFS file ID
   * @returns {Promise<object>} - File metadata
   */
  async getInfo(fileId) {
    const { ObjectId } = require('mongodb');
    const files = await db.collection('screenshots.files').findOne({ _id: new ObjectId(fileId) });
    return files;
  },

  /**
   * Delete file from GridFS
   * @param {string} fileId - GridFS file ID
   */
  async delete(fileId) {
    const { ObjectId } = require('mongodb');
    await screenshotsBucket.delete(new ObjectId(fileId));
    console.log(`GridFS: Deleted ${fileId}`);
  },

  /**
   * List files by metadata
   * @param {object} filter - Metadata filter
   * @returns {Promise<array>} - List of files
   */
  async list(filter = {}, options = {}) {
    const { limit = 100, skip = 0 } = options;
    const query = {};

    // Convert filter to metadata query
    for (const [key, value] of Object.entries(filter)) {
      query[`metadata.${key}`] = value;
    }

    return db.collection('screenshots.files')
      .find(query)
      .sort({ uploadDate: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
  }
};

// Audit logs operations
const auditLogs = {
  async create(log) {
    const auditLog = {
      ...log,
      timestamp: new Date(),
      id: uuidv4()
    };
    const result = await auditLogsCollection.insertOne(auditLog);
    return result;
  },

  async findByPaymentId(paymentId) {
    return auditLogsCollection.find({ payment_id: paymentId }).sort({ timestamp: -1 }).toArray();
  },

  async findByMerchantId(merchantId, options = {}) {
    const { limit = 100, skip = 0, sort = { timestamp: -1 } } = options;
    return auditLogsCollection.find({ merchant_id: merchantId }).sort(sort).skip(skip).limit(limit).toArray();
  },

  async list(filter = {}, options = {}) {
    const { limit = 100, skip = 0, sort = { timestamp: -1 } } = options;
    return auditLogsCollection.find(filter).sort(sort).skip(skip).limit(limit).toArray();
  }
};

// Notifications operations
const notifications = {
  async create(notification) {
    const notif = {
      ...notification,
      created_at: new Date(),
      id: uuidv4(),
      status: notification.status || 'pending'
    };
    const result = await notificationsCollection.insertOne(notif);
    return result;
  },

  async findByMerchantId(merchantId, options = {}) {
    const { limit = 50, skip = 0, sort = { created_at: -1 } } = options;
    return notificationsCollection.find({ merchant_id: merchantId }).sort(sort).skip(skip).limit(limit).toArray();
  },

  async markAsRead(id) {
    return notificationsCollection.updateOne(
      { id },
      { $set: { status: 'read', read_at: new Date() } }
    );
  },

  async markAllAsRead(merchantId) {
    return notificationsCollection.updateMany(
      { merchant_id: merchantId, status: 'pending' },
      { $set: { status: 'read', read_at: new Date() } }
    );
  },

  async deleteOld(daysOld = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    return notificationsCollection.deleteMany({ created_at: { $lt: cutoffDate } });
  }
};

module.exports = {
  connect,
  disconnect,
  getDb,
  getCollections,
  invoices,
  payments,
  fraudAlerts,
  screenshots,
  auditLogs,
  notifications
};
