'use strict';

const express = require('express');
const { learningApiAuth, internalServiceAuth } = require('../middleware/auth');
const { getDb } = require('../db/mongo');
const { updatePatternModel, generateImprovedPrompts } = require('../services/pattern-updater');

const router = express.Router();

/**
 * POST /api/v1/learning/receive
 * Receive learning data from scriptclient
 * Body: { screenshot_data, analysis, tenant_id }
 */
router.post('/receive', learningApiAuth, async (req, res) => {
  try {
    const { screenshot_data, analysis, tenant_id } = req.body;

    if (!analysis || !screenshot_data) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: analysis and screenshot_data'
      });
    }

    console.log(`📚 Learning data received from scriptclient | Tenant: ${tenant_id} | Status: ${analysis.status}`);

    // Store learning data (excluding fixed recipient names for general service)
    const learningData = {
      ...analysis,
      received_at: new Date(),
      tenant_id,

      // Skip fixed recipient validation for general service
      recipient_learning: false,

      // Focus on these learnable patterns
      patterns_to_learn: {
        bank_formats: analysis.training_data?.bank,
        amount_formats: analysis.training_data?.extraction_success?.amount,
        date_formats: analysis.training_data?.extraction_success?.date,
        transaction_ids: analysis.training_data?.extraction_success?.transactionId,
        quality_requirements: analysis.reasons?.image_quality,
        confidence_patterns: analysis.training_data?.confidence_level
      },

      // Reason analysis for improvement
      rejection_analysis: analysis.reasons,
      success_patterns: analysis.patterns
    };

    // Save to learning patterns collection
    const db = getDb();
    const learningCollection = db.collection('learning_patterns');
    const insertResult = await learningCollection.insertOne(learningData);

    console.log(`💾 Learning data stored | ID: ${insertResult.insertedId}`);

    // Update pattern recognition model
    const modelUpdate = await updatePatternModel(learningData);

    // Generate improved prompts for scriptclient
    const improvedPrompts = generateImprovedPrompts(learningData);

    // Track learning statistics
    await updateLearningStats(analysis.status, tenant_id, learningData.patterns_to_learn);

    res.json({
      success: true,
      learning_id: insertResult.insertedId,
      learned_patterns: learningData.patterns_to_learn,
      model_updates: modelUpdate,
      improved_prompts: improvedPrompts,
      message: `Learned from ${analysis.status} screenshot analysis`
    });

  } catch (error) {
    console.error('Learning endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/v1/learning/share
 * Share OCR improvements back to scriptclient
 * Body: { patterns, confidence_updates, prompt_improvements }
 */
router.post('/share', learningApiAuth, async (req, res) => {
  try {
    const { verification_result, confidence_breakdown, extraction_patterns } = req.body;

    if (!verification_result) {
      return res.status(400).json({
        success: false,
        error: 'Missing verification_result'
      });
    }

    const sharingData = {
      timestamp: new Date(),
      verification_status: verification_result.verification.status,
      confidence_insights: {
        overall_confidence: verification_result.ocr.confidence,
        field_confidence: confidence_breakdown,
        success_indicators: extraction_patterns?.success_indicators,
        failure_indicators: extraction_patterns?.failure_indicators
      },
      bank_learnings: {
        detected_bank: verification_result.ocr.bank,
        format_patterns: extraction_patterns?.bank_specific,
        reliability_score: confidence_breakdown?.bank_detection
      }
    };

    // Store sharing data
    const db = getDb();
    const sharingCollection = db.collection('ocr_sharing_data');
    const insertResult = await sharingCollection.insertOne(sharingData);

    console.log(`📤 Shared OCR insights | ID: ${insertResult.insertedId} | Status: ${verification_result.verification.status}`);

    res.json({
      success: true,
      sharing_id: insertResult.insertedId,
      insights_shared: sharingData.confidence_insights,
      bank_learnings: sharingData.bank_learnings
    });

  } catch (error) {
    console.error('Sharing endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/learning/stats
 * Get learning progress statistics
 */
router.get('/stats', learningApiAuth, async (req, res) => {
  try {
    const db = getDb();

    // Get learning statistics
    const learningStats = await db.collection('learning_stats').findOne(
      { type: 'overall' },
      { sort: { updated_at: -1 } }
    );

    // Get recent learning activities
    const recentLearning = await db.collection('learning_patterns')
      .find({})
      .sort({ received_at: -1 })
      .limit(10)
      .toArray();

    // Calculate accuracy improvements
    const accuracyStats = await calculateAccuracyImprovements();

    res.json({
      success: true,
      learning_statistics: learningStats || {
        total_patterns_learned: 0,
        verified_learnings: 0,
        pending_learnings: 0,
        rejected_learnings: 0
      },
      recent_activity: recentLearning,
      accuracy_improvements: accuracyStats,
      last_updated: new Date()
    });

  } catch (error) {
    console.error('Stats endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Update learning statistics
 */
async function updateLearningStats(status, tenantId, patternsLearned) {
  try {
    const db = getDb();
    const statsCollection = db.collection('learning_stats');

    const update = {
      $inc: {
        total_patterns_learned: 1,
        [`${status}_learnings`]: 1,
        [`tenant_${tenantId}_count`]: 1
      },
      $set: {
        updated_at: new Date(),
        last_tenant: tenantId,
        last_status: status
      },
      $push: {
        recent_patterns: {
          $each: [patternsLearned],
          $slice: -50 // Keep last 50 patterns
        }
      }
    };

    await statsCollection.updateOne(
      { type: 'overall' },
      update,
      { upsert: true }
    );

    console.log(`📈 Learning stats updated | Status: ${status} | Tenant: ${tenantId}`);

  } catch (error) {
    console.error('Error updating learning stats:', error);
  }
}

/**
 * Calculate accuracy improvements from learning data
 */
async function calculateAccuracyImprovements() {
  try {
    const db = getDb();

    // Get learning data from last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const pipeline = [
      {
        $match: {
          received_at: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          avg_confidence: { $avg: '$training_data.confidence_level' }
        }
      }
    ];

    const improvements = await db.collection('learning_patterns')
      .aggregate(pipeline)
      .toArray();

    return {
      period: '30_days',
      status_breakdown: improvements,
      total_learnings: improvements.reduce((sum, item) => sum + item.count, 0)
    };

  } catch (error) {
    console.error('Error calculating accuracy improvements:', error);
    return { error: error.message };
  }
}

module.exports = router;