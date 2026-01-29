#!/usr/bin/env node

'use strict';

require('dotenv').config();

const { MongoClient } = require('mongodb');

/**
 * Initialize MongoDB collections for learning system
 */

const LEARNING_COLLECTIONS = [
  {
    name: 'learning_patterns',
    description: 'Stores learning data received from scriptclient',
    indexes: [
      { key: { received_at: -1 }, background: true },
      { key: { tenant_id: 1 }, background: true },
      { key: { status: 1 }, background: true },
      { key: { 'training_data.bank': 1 }, background: true }
    ]
  },
  {
    name: 'bank_patterns',
    description: 'Bank-specific learning patterns and statistics',
    indexes: [
      { key: { bank_name: 1 }, unique: true },
      { key: { last_seen: -1 }, background: true },
      { key: { verified_count: -1 }, background: true }
    ]
  },
  {
    name: 'amount_patterns',
    description: 'Amount extraction patterns and formats',
    indexes: [
      { key: { format_type: 1, currency: 1 }, unique: true },
      { key: { last_updated: -1 }, background: true }
    ]
  },
  {
    name: 'date_patterns',
    description: 'Date format patterns and extraction success rates',
    indexes: [
      { key: { format_pattern: 1 }, unique: true },
      { key: { last_seen: -1 }, background: true }
    ]
  },
  {
    name: 'quality_patterns',
    description: 'Image quality patterns for success/failure analysis',
    indexes: [
      { key: { pattern_type: 1 }, unique: true },
      { key: { last_updated: -1 }, background: true }
    ]
  },
  {
    name: 'confidence_patterns',
    description: 'Confidence level mappings and outcome correlations',
    indexes: [
      { key: { confidence_range: 1, bank: 1 } },
      { key: { last_updated: -1 }, background: true }
    ]
  },
  {
    name: 'ocr_patterns',
    description: 'OCR pattern updates and model improvements',
    indexes: [
      { key: { timestamp: -1 }, background: true },
      { key: { tenant_id: 1 }, background: true },
      { key: { learning_source: 1 }, background: true }
    ]
  },
  {
    name: 'ocr_sharing_data',
    description: 'OCR insights shared back to scriptclient',
    indexes: [
      { key: { timestamp: -1 }, background: true },
      { key: { verification_status: 1 }, background: true },
      { key: { 'confidence_insights.overall_confidence': 1 } }
    ]
  },
  {
    name: 'learning_stats',
    description: 'Learning progress statistics and metrics',
    indexes: [
      { key: { type: 1 }, unique: true },
      { key: { updated_at: -1 }, background: true }
    ]
  }
];

async function initializeLearningCollections() {
  let client;

  try {
    console.log('🚀 Initializing Learning System Collections');
    console.log('═══════════════════════════════════════════════');

    // Connect to MongoDB
    client = new MongoClient(process.env.MONGO_URL);
    await client.connect();

    const db = client.db(process.env.DB_NAME || 'customerDB');

    console.log(`📊 Connected to database: ${db.databaseName}`);

    // Create collections and indexes
    for (const collection of LEARNING_COLLECTIONS) {
      console.log(`\n📁 Setting up collection: ${collection.name}`);
      console.log(`   Description: ${collection.description}`);

      try {
        // Create collection if it doesn't exist
        const collections = await db.listCollections({ name: collection.name }).toArray();

        if (collections.length === 0) {
          await db.createCollection(collection.name);
          console.log(`   ✅ Collection created: ${collection.name}`);
        } else {
          console.log(`   📋 Collection exists: ${collection.name}`);
        }

        // Create indexes
        const coll = db.collection(collection.name);

        for (let i = 0; i < collection.indexes.length; i++) {
          const indexSpec = collection.indexes[i];

          try {
            await coll.createIndex(indexSpec.key, {
              background: indexSpec.background || false,
              unique: indexSpec.unique || false,
              name: `learning_idx_${i + 1}`
            });

            console.log(`   📚 Index created: ${JSON.stringify(indexSpec.key)}`);

          } catch (indexError) {
            if (indexError.codeName === 'IndexOptionsConflict' || indexError.code === 85) {
              console.log(`   📚 Index exists: ${JSON.stringify(indexSpec.key)}`);
            } else {
              console.log(`   ⚠️  Index warning: ${indexError.message}`);
            }
          }
        }

      } catch (error) {
        console.error(`   ❌ Error setting up ${collection.name}:`, error.message);
      }
    }

    // Initialize default learning stats
    await initializeLearningStats(db);

    console.log('\n🎉 Learning System Initialization Complete');
    console.log('═══════════════════════════════════════════════');

    // Display summary
    await displayCollectionSummary(db);

  } catch (error) {
    console.error('❌ Learning system initialization failed:', error);
    process.exit(1);

  } finally {
    if (client) {
      await client.close();
    }
  }
}

async function initializeLearningStats(db) {
  try {
    console.log('\n📈 Initializing learning statistics...');

    const statsCollection = db.collection('learning_stats');

    const defaultStats = {
      type: 'overall',
      total_patterns_learned: 0,
      verified_learnings: 0,
      pending_learnings: 0,
      rejected_learnings: 0,
      created_at: new Date(),
      updated_at: new Date(),
      recent_patterns: []
    };

    await statsCollection.updateOne(
      { type: 'overall' },
      { $setOnInsert: defaultStats },
      { upsert: true }
    );

    console.log('   ✅ Learning statistics initialized');

  } catch (error) {
    console.error('   ❌ Error initializing learning stats:', error.message);
  }
}

async function displayCollectionSummary(db) {
  console.log('\n📊 COLLECTION SUMMARY');
  console.log('═══════════════════════');

  for (const collection of LEARNING_COLLECTIONS) {
    try {
      const coll = db.collection(collection.name);
      const count = await coll.countDocuments();
      const indexes = await coll.listIndexes().toArray();

      console.log(`${collection.name.padEnd(20)} | Documents: ${count.toString().padStart(4)} | Indexes: ${indexes.length}`);

    } catch (error) {
      console.log(`${collection.name.padEnd(20)} | Error: ${error.message}`);
    }
  }

  console.log('\n✨ Ready to receive learning data from scriptclient!');
  console.log('📡 API Endpoint: /api/v1/learning/receive');
  console.log('📊 Stats Endpoint: /api/v1/learning/stats');
}

// Auto-run if called directly
if (require.main === module) {
  initializeLearningCollections()
    .then(() => {
      console.log('🎯 Learning system ready for scriptclient integration');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Initialization failed:', error);
      process.exit(1);
    });
}

module.exports = {
  initializeLearningCollections,
  LEARNING_COLLECTIONS
};