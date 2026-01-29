'use strict';

const { getDb } = require('../db/mongo');

/**
 * Pattern Updater Service
 * Updates OCR patterns based on learning data from scriptclient
 */

/**
 * Update pattern recognition model with new learning data
 * @param {Object} learningData - Data received from scriptclient
 * @returns {Object} - Summary of model updates
 */
async function updatePatternModel(learningData) {
  try {
    const db = getDb();
    const patternsCollection = db.collection('ocr_patterns');

    console.log(`🔄 Updating pattern model | Status: ${learningData.status}`);

    const updates = {
      bank_patterns: await updateBankPatterns(learningData),
      amount_patterns: await updateAmountPatterns(learningData),
      date_patterns: await updateDatePatterns(learningData),
      quality_patterns: await updateQualityPatterns(learningData),
      confidence_patterns: await updateConfidencePatterns(learningData)
    };

    // Store pattern updates with timestamp
    const patternUpdate = {
      timestamp: new Date(),
      tenant_id: learningData.tenant_id,
      source_status: learningData.status,
      updates: updates,
      learning_source: 'scriptclient'
    };

    const result = await patternsCollection.insertOne(patternUpdate);
    console.log(`💾 Pattern update stored | ID: ${result.insertedId}`);

    return {
      success: true,
      update_id: result.insertedId,
      patterns_updated: Object.keys(updates).filter(key => updates[key].updated).length,
      summary: updates
    };

  } catch (error) {
    console.error('Error updating pattern model:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Update bank detection patterns
 */
async function updateBankPatterns(learningData) {
  try {
    const db = getDb();
    const bankPatternsCollection = db.collection('bank_patterns');

    const bankName = learningData.patterns_to_learn?.bank_formats;
    if (!bankName) {
      return { updated: false, reason: 'No bank data provided' };
    }

    const update = {
      $inc: {
        [`${learningData.status}_count`]: 1,
        total_occurrences: 1
      },
      $set: {
        last_seen: new Date(),
        [`confidence_${learningData.status}`]: learningData.patterns_to_learn.confidence_patterns
      },
      $push: {
        learning_history: {
          timestamp: new Date(),
          status: learningData.status,
          tenant_id: learningData.tenant_id,
          confidence: learningData.patterns_to_learn.confidence_patterns
        }
      }
    };

    await bankPatternsCollection.updateOne(
      { bank_name: bankName },
      update,
      { upsert: true }
    );

    console.log(`🏦 Updated bank pattern | Bank: ${bankName} | Status: ${learningData.status}`);

    return {
      updated: true,
      bank: bankName,
      status: learningData.status,
      confidence: learningData.patterns_to_learn.confidence_patterns
    };

  } catch (error) {
    console.error('Error updating bank patterns:', error);
    return { updated: false, error: error.message };
  }
}

/**
 * Update amount extraction patterns
 */
async function updateAmountPatterns(learningData) {
  try {
    const db = getDb();
    const amountPatternsCollection = db.collection('amount_patterns');

    const amountData = learningData.patterns_to_learn?.amount_formats;
    if (!amountData) {
      return { updated: false, reason: 'No amount data provided' };
    }

    // Extract amount format patterns
    const formatPattern = extractAmountFormat(amountData);

    const update = {
      $inc: {
        [`success_${learningData.status}_count`]: 1
      },
      $set: {
        last_updated: new Date(),
        format_pattern: formatPattern
      },
      $addToSet: {
        successful_formats: learningData.status === 'verified' ? formatPattern : null
      }
    };

    await amountPatternsCollection.updateOne(
      {
        format_type: formatPattern.type,
        currency: formatPattern.currency
      },
      update,
      { upsert: true }
    );

    console.log(`💰 Updated amount pattern | Format: ${formatPattern.type} | Status: ${learningData.status}`);

    return {
      updated: true,
      format: formatPattern,
      status: learningData.status
    };

  } catch (error) {
    console.error('Error updating amount patterns:', error);
    return { updated: false, error: error.message };
  }
}

/**
 * Update date extraction patterns
 */
async function updateDatePatterns(learningData) {
  try {
    const db = getDb();
    const datePatternsCollection = db.collection('date_patterns');

    const dateData = learningData.patterns_to_learn?.date_formats;
    if (!dateData) {
      return { updated: false, reason: 'No date data provided' };
    }

    const dateFormat = extractDateFormat(dateData);

    const update = {
      $inc: {
        [`${learningData.status}_occurrences`]: 1
      },
      $set: {
        last_seen: new Date(),
        reliability_score: learningData.status === 'verified' ?
          { $inc: { reliable_count: 1 } } :
          { $inc: { unreliable_count: 1 } }
      },
      $push: {
        examples: {
          $each: [{
            raw_date: dateData,
            format: dateFormat,
            status: learningData.status,
            timestamp: new Date()
          }],
          $slice: -100 // Keep last 100 examples
        }
      }
    };

    await datePatternsCollection.updateOne(
      { format_pattern: dateFormat },
      update,
      { upsert: true }
    );

    console.log(`📅 Updated date pattern | Format: ${dateFormat} | Status: ${learningData.status}`);

    return {
      updated: true,
      format: dateFormat,
      status: learningData.status
    };

  } catch (error) {
    console.error('Error updating date patterns:', error);
    return { updated: false, error: error.message };
  }
}

/**
 * Update image quality patterns
 */
async function updateQualityPatterns(learningData) {
  try {
    const db = getDb();
    const qualityPatternsCollection = db.collection('quality_patterns');

    const qualityData = learningData.patterns_to_learn?.quality_requirements;
    if (!qualityData) {
      return { updated: false, reason: 'No quality data provided' };
    }

    const qualityMetrics = {
      status: learningData.status,
      quality_indicators: qualityData,
      timestamp: new Date()
    };

    // Group by status to understand quality thresholds
    const update = {
      $push: {
        [`${learningData.status}_samples`]: {
          $each: [qualityMetrics],
          $slice: -50 // Keep last 50 samples per status
        }
      },
      $inc: {
        [`total_${learningData.status}`]: 1
      },
      $set: {
        last_updated: new Date()
      }
    };

    await qualityPatternsCollection.updateOne(
      { pattern_type: 'image_quality_analysis' },
      update,
      { upsert: true }
    );

    console.log(`🖼️ Updated quality pattern | Status: ${learningData.status}`);

    return {
      updated: true,
      quality_metrics: qualityMetrics,
      status: learningData.status
    };

  } catch (error) {
    console.error('Error updating quality patterns:', error);
    return { updated: false, error: error.message };
  }
}

/**
 * Update confidence scoring patterns
 */
async function updateConfidencePatterns(learningData) {
  try {
    const db = getDb();
    const confidencePatternsCollection = db.collection('confidence_patterns');

    const confidenceLevel = learningData.patterns_to_learn?.confidence_patterns;
    if (!confidenceLevel) {
      return { updated: false, reason: 'No confidence data provided' };
    }

    // Learn confidence thresholds for different outcomes
    const confidenceMapping = {
      confidence_level: confidenceLevel,
      actual_outcome: learningData.status,
      bank: learningData.patterns_to_learn?.bank_formats,
      timestamp: new Date()
    };

    const update = {
      $push: {
        confidence_mappings: {
          $each: [confidenceMapping],
          $slice: -200 // Keep last 200 mappings
        }
      },
      $inc: {
        total_samples: 1,
        [`outcome_${learningData.status}`]: 1
      },
      $set: {
        last_updated: new Date()
      }
    };

    await confidencePatternsCollection.updateOne(
      {
        confidence_range: getConfidenceRange(confidenceLevel),
        bank: learningData.patterns_to_learn?.bank_formats
      },
      update,
      { upsert: true }
    );

    console.log(`📊 Updated confidence pattern | Level: ${confidenceLevel} | Outcome: ${learningData.status}`);

    return {
      updated: true,
      confidence_level: confidenceLevel,
      outcome: learningData.status,
      bank: learningData.patterns_to_learn?.bank_formats
    };

  } catch (error) {
    console.error('Error updating confidence patterns:', error);
    return { updated: false, error: error.message };
  }
}

/**
 * Generate improved prompts based on learning data
 * @param {Object} learningData - Learning data from scriptclient
 * @returns {Object} - Improved prompts and suggestions
 */
async function generateImprovedPrompts(learningData) {
  try {
    const db = getDb();

    // Get historical patterns for this bank/status combination
    const historicalPatterns = await db.collection('bank_patterns')
      .findOne({ bank_name: learningData.patterns_to_learn?.bank_formats });

    const improvedPrompts = {
      bank_specific_prompt: generateBankSpecificPrompt(learningData, historicalPatterns),
      confidence_adjustments: generateConfidenceAdjustments(learningData),
      extraction_hints: generateExtractionHints(learningData),
      quality_requirements: generateQualityRequirements(learningData)
    };

    console.log(`💡 Generated improved prompts for ${learningData.patterns_to_learn?.bank_formats || 'unknown bank'}`);

    return improvedPrompts;

  } catch (error) {
    console.error('Error generating improved prompts:', error);
    return {
      error: error.message,
      fallback_prompts: getDefaultPrompts()
    };
  }
}

/**
 * Helper functions for pattern extraction and analysis
 */

function extractAmountFormat(amountData) {
  // Extract currency, format, and separator patterns
  return {
    type: 'currency_amount',
    currency: amountData?.currency || 'unknown',
    separator: detectSeparator(amountData),
    position: detectCurrencyPosition(amountData)
  };
}

function extractDateFormat(dateData) {
  // Extract date format patterns
  if (!dateData) return 'unknown';

  // Simple pattern detection
  if (dateData.includes('/')) return 'MM/DD/YYYY';
  if (dateData.includes('-')) return 'YYYY-MM-DD';
  if (dateData.includes('.')) return 'DD.MM.YYYY';

  return 'unknown_format';
}

function getConfidenceRange(confidence) {
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.7) return 'medium';
  return 'low';
}

function detectSeparator(amountData) {
  if (amountData?.toString().includes(',')) return 'comma';
  if (amountData?.toString().includes('.')) return 'period';
  return 'none';
}

function detectCurrencyPosition(amountData) {
  const str = amountData?.toString() || '';
  if (str.match(/^[A-Z]{3}/)) return 'prefix';
  if (str.match(/[A-Z]{3}$/)) return 'suffix';
  return 'unknown';
}

function generateBankSpecificPrompt(learningData, historicalPatterns) {
  const bank = learningData.patterns_to_learn?.bank_formats;

  if (!bank) return 'Use standard bank detection prompts';

  return `Enhanced prompt for ${bank}: Focus on specific patterns learned from ${historicalPatterns?.verified_count || 0} verified transactions.`;
}

function generateConfidenceAdjustments(learningData) {
  return {
    status: learningData.status,
    suggested_threshold: learningData.status === 'verified' ? 'maintain_current' : 'increase_scrutiny',
    reasoning: `Based on ${learningData.status} outcome from scriptclient analysis`
  };
}

function generateExtractionHints(learningData) {
  return {
    focus_areas: [
      learningData.patterns_to_learn?.amount_formats ? 'amount_extraction' : null,
      learningData.patterns_to_learn?.date_formats ? 'date_extraction' : null,
      learningData.patterns_to_learn?.transaction_ids ? 'transaction_id' : null
    ].filter(Boolean),
    success_indicators: learningData.success_patterns || {}
  };
}

function generateQualityRequirements(learningData) {
  return {
    minimum_quality: learningData.status === 'rejected' ? 'increase' : 'maintain',
    focus_areas: learningData.patterns_to_learn?.quality_requirements || {},
    recommendations: learningData.rejection_analysis || {}
  };
}

function getDefaultPrompts() {
  return {
    bank_specific_prompt: 'Use standard bank detection',
    confidence_adjustments: { suggested_threshold: 'default' },
    extraction_hints: { focus_areas: ['amount', 'date', 'recipient'] },
    quality_requirements: { minimum_quality: 'standard' }
  };
}

module.exports = {
  updatePatternModel,
  generateImprovedPrompts
};