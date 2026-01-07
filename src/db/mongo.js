'use strict';

const { MongoClient } = require('mongodb');

// MongoDB connection
const MONGO_URL = process.env.MONGO_URL;
const DB_NAME = process.env.DB_NAME || 'ocrServiceDB';

let client = null;
let db = null;

// Collections
let invoicesCollection = null;
let paymentsCollection = null;
let fraudAlertsCollection = null;

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
    await paymentsCollection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
    await paymentsCollection.createIndex({ verificationStatus: 1 });
    await paymentsCollection.createIndex({ uploadedAt: -1 });

    // Fraud alerts indexes
    await fraudAlertsCollection.createIndex({ alertId: 1 }, { unique: true });
    await fraudAlertsCollection.createIndex({ payment_id: 1 });
    await fraudAlertsCollection.createIndex({ invoice_id: 1 });
    await fraudAlertsCollection.createIndex({ reviewStatus: 1 });
    await fraudAlertsCollection.createIndex({ detectedAt: -1 });

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

module.exports = {
  connect,
  disconnect,
  getDb,
  getCollections,
  invoices,
  payments,
  fraudAlerts
};
