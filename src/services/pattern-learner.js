'use strict';

const { getDb } = require('../db/mongo');

/**
 * Pattern Learner Service
 * Retrieves and applies learned patterns from scriptclient data
 */

/**
 * Get learned patterns for a specific bank or general patterns
 * @param {string} bankName - Bank name to get specific patterns for
 * @returns {Promise<Object>} - Learned patterns data
 */
async function getLearnedPatterns(bankName = null) {
  try {
    const db = getDb();

    // Get bank-specific patterns if bank is specified
    let bankPatterns = {};
    if (bankName) {
      const bankPatternsDoc = await db.collection('bank_patterns')
        .findOne({ bank_name: bankName });

      if (bankPatternsDoc) {
        bankPatterns = {
          bank_name: bankName,
          verified_count: bankPatternsDoc.verified_count || 0,
          rejected_count: bankPatternsDoc.rejected_count || 0,
          pending_count: bankPatternsDoc.pending_count || 0,
          confidence_verified: bankPatternsDoc.confidence_verified,
          confidence_rejected: bankPatternsDoc.confidence_rejected,
          last_seen: bankPatternsDoc.last_seen,
          success_rate: calculateSuccessRate(bankPatternsDoc)
        };
      }
    }

    // Get general patterns
    const recentPatterns = await db.collection('learning_patterns')
      .find({
        received_at: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Last 30 days
      })
      .sort({ received_at: -1 })
      .limit(100)
      .toArray();

    // Get quality patterns
    const qualityPatterns = await db.collection('quality_patterns')
      .findOne({ pattern_type: 'image_quality_analysis' });

    // Get confidence patterns
    const confidencePatterns = await db.collection('confidence_patterns')
      .find(bankName ? { bank: bankName } : {})
      .sort({ last_updated: -1 })
      .limit(50)
      .toArray();

    const patterns = {
      bank_specific: bankPatterns,
      recent_learnings: recentPatterns,
      quality_insights: extractQualityInsights(qualityPatterns),
      confidence_mappings: extractConfidenceMappings(confidencePatterns),
      patterns_count: recentPatterns.length,
      last_updated: new Date()
    };

    console.log(`📊 Retrieved learned patterns | Bank: ${bankName || 'general'} | Count: ${recentPatterns.length}`);

    return patterns;

  } catch (error) {
    console.error('Error getting learned patterns:', error);
    return {
      bank_specific: {},
      recent_learnings: [],
      quality_insights: {},
      confidence_mappings: [],
      patterns_count: 0,
      error: error.message
    };
  }
}

/**
 * Generate improved OCR prompt based on learned patterns
 * @param {string} basePrompt - Original OCR prompt
 * @param {Object} learnedPatterns - Patterns learned from scriptclient
 * @returns {Promise<string>} - Enhanced prompt
 */
async function getImprovedPrompt(basePrompt, learnedPatterns) {
  try {
    if (!learnedPatterns.patterns_count || learnedPatterns.patterns_count === 0) {
      console.log('No learned patterns available, using base prompt');
      return basePrompt;
    }

    let enhancedPrompt = basePrompt;

    // Add bank-specific improvements
    if (learnedPatterns.bank_specific && learnedPatterns.bank_specific.bank_name) {
      const bankEnhancement = generateBankSpecificEnhancement(learnedPatterns.bank_specific);
      enhancedPrompt = `${basePrompt}\n\n${bankEnhancement}`;
    }

    // Add quality insights
    if (learnedPatterns.quality_insights && Object.keys(learnedPatterns.quality_insights).length > 0) {
      const qualityEnhancement = generateQualityEnhancement(learnedPatterns.quality_insights);
      enhancedPrompt = `${enhancedPrompt}\n\n${qualityEnhancement}`;
    }

    // Add confidence adjustments
    if (learnedPatterns.confidence_mappings && learnedPatterns.confidence_mappings.length > 0) {
      const confidenceEnhancement = generateConfidenceEnhancement(learnedPatterns.confidence_mappings);
      enhancedPrompt = `${enhancedPrompt}\n\n${confidenceEnhancement}`;
    }

    // Add recent learning insights
    const recentInsights = generateRecentLearningInsights(learnedPatterns.recent_learnings);
    if (recentInsights) {
      enhancedPrompt = `${enhancedPrompt}\n\n${recentInsights}`;
    }

    console.log(`✨ Enhanced prompt generated with ${learnedPatterns.patterns_count} learned patterns`);

    return enhancedPrompt;

  } catch (error) {
    console.error('Error generating improved prompt:', error);
    return basePrompt; // Fall back to base prompt
  }
}

/**
 * Share OCR results back to scriptclient learning system
 * @param {Object} ocrResult - OCR analysis result
 * @param {Object} verificationResult - Verification result
 * @returns {Promise<Object>} - Sharing result
 */
async function shareOCRInsights(ocrResult, verificationResult) {
  try {
    const db = getDb();

    const insights = {
      timestamp: new Date(),
      ocr_confidence: ocrResult.confidence,
      bank_detected: ocrResult.bankName,
      verification_status: verificationResult.verification.status,
      extraction_success: {
        amount: !!ocrResult.amount,
        transaction_id: !!ocrResult.transactionId,
        recipient: !!ocrResult.toAccount,
        date: !!ocrResult.transactionDate
      },
      confidence_breakdown: {
        overall: ocrResult.confidence,
        bank_detection: ocrResult.bankName ? 'high' : 'low',
        amount_extraction: ocrResult.amount ? 'high' : 'low',
        date_extraction: ocrResult.transactionDate ? 'high' : 'low'
      },
      improvement_areas: identifyImprovementAreas(ocrResult, verificationResult)
    };

    // Store insights for sharing with scriptclient
    const result = await db.collection('ocr_sharing_data').insertOne(insights);

    console.log(`📤 OCR insights prepared for sharing | ID: ${result.insertedId} | Status: ${verificationResult.verification.status}`);

    return {
      success: true,
      insights_id: result.insertedId,
      insights: insights
    };

  } catch (error) {
    console.error('Error sharing OCR insights:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Helper functions for pattern analysis and enhancement generation
 */

function calculateSuccessRate(bankPatternsDoc) {
  const total = (bankPatternsDoc.verified_count || 0) +
                (bankPatternsDoc.rejected_count || 0) +
                (bankPatternsDoc.pending_count || 0);

  if (total === 0) return 0;

  return Math.round(((bankPatternsDoc.verified_count || 0) / total) * 100);
}

function extractQualityInsights(qualityPatterns) {
  if (!qualityPatterns) return {};

  return {
    verified_quality_indicators: qualityPatterns.verified_samples?.slice(-10) || [],
    rejected_quality_indicators: qualityPatterns.rejected_samples?.slice(-10) || [],
    common_quality_issues: identifyCommonQualityIssues(qualityPatterns),
    quality_recommendations: generateQualityRecommendations(qualityPatterns)
  };
}

function extractConfidenceMappings(confidencePatterns) {
  return confidencePatterns.map(pattern => ({
    confidence_range: pattern.confidence_range,
    bank: pattern.bank,
    verified_outcomes: pattern.outcome_verified || 0,
    rejected_outcomes: pattern.outcome_rejected || 0,
    pending_outcomes: pattern.outcome_pending || 0,
    success_rate: calculateOutcomeSuccessRate(pattern)
  }));
}

function generateBankSpecificEnhancement(bankPatterns) {
  const bankName = bankPatterns.bank_name;
  const successRate = bankPatterns.success_rate;

  return `LEARNED PATTERNS FOR ${bankName.toUpperCase()}:
- Success Rate: ${successRate}% (based on ${bankPatterns.verified_count} verified transactions)
- This bank has been processed ${bankPatterns.verified_count + bankPatterns.rejected_count + bankPatterns.pending_count} times
- Pay special attention to patterns that previously led to verification
- Common success indicators from previous ${bankName} transactions should be prioritized`;
}

function generateQualityEnhancement(qualityInsights) {
  const verifiedCount = qualityInsights.verified_quality_indicators?.length || 0;
  const rejectedCount = qualityInsights.rejected_quality_indicators?.length || 0;

  if (verifiedCount === 0 && rejectedCount === 0) return '';

  return `QUALITY INSIGHTS FROM LEARNING:
- ${verifiedCount} verified screenshots analyzed for quality patterns
- ${rejectedCount} rejected screenshots analyzed for common issues
- Focus on image clarity indicators that correlate with verification success
- Apply stricter quality thresholds based on learned rejection patterns`;
}

function generateConfidenceEnhancement(confidenceMappings) {
  if (!confidenceMappings.length) return '';

  const highConfidenceSuccess = confidenceMappings
    .filter(m => m.confidence_range === 'high')
    .reduce((sum, m) => sum + m.success_rate, 0) /
    Math.max(confidenceMappings.filter(m => m.confidence_range === 'high').length, 1);

  return `CONFIDENCE CALIBRATION FROM LEARNING:
- High confidence predictions have ${Math.round(highConfidenceSuccess)}% success rate
- Adjust confidence thresholds based on bank-specific performance
- Consider learned patterns when assigning confidence levels`;
}

function generateRecentLearningInsights(recentLearnings) {
  if (!recentLearnings.length) return '';

  const statusCounts = recentLearnings.reduce((acc, learning) => {
    acc[learning.status] = (acc[learning.status] || 0) + 1;
    return acc;
  }, {});

  const totalLearnings = recentLearnings.length;
  const verifiedRate = Math.round(((statusCounts.verified || 0) / totalLearnings) * 100);

  return `RECENT LEARNING INSIGHTS (${totalLearnings} samples):
- ${verifiedRate}% verification success rate in recent learning data
- Focus extraction on patterns that led to recent verifications
- Apply lessons from recent rejection patterns to improve accuracy`;
}

function identifyImprovementAreas(ocrResult, verificationResult) {
  const areas = [];

  if (verificationResult.verification.status === 'rejected') {
    if (!ocrResult.amount) areas.push('amount_extraction');
    if (!ocrResult.transactionId) areas.push('transaction_id_extraction');
    if (!ocrResult.bankName) areas.push('bank_detection');
    if (!ocrResult.toAccount) areas.push('recipient_extraction');
  }

  if (ocrResult.confidence === 'low' || ocrResult.confidence === 'medium') {
    areas.push('confidence_calibration');
  }

  return areas;
}

function identifyCommonQualityIssues(qualityPatterns) {
  // Analyze rejected samples to identify common quality issues
  const rejectedSamples = qualityPatterns.rejected_samples || [];

  return rejectedSamples.reduce((issues, sample) => {
    if (sample.quality_indicators?.blurry) issues.push('blur');
    if (sample.quality_indicators?.cropped) issues.push('cropping');
    if (sample.quality_indicators?.poor_lighting) issues.push('lighting');
    return issues;
  }, []);
}

function generateQualityRecommendations(qualityPatterns) {
  const verifiedSamples = qualityPatterns.verified_samples || [];
  const rejectedSamples = qualityPatterns.rejected_samples || [];

  return {
    min_resolution: 'Based on verified samples, maintain current resolution standards',
    lighting: verifiedSamples.length > rejectedSamples.length ? 'Current lighting tolerance is appropriate' : 'Consider stricter lighting requirements',
    focus: 'Maintain focus standards based on verified sample patterns'
  };
}

function calculateOutcomeSuccessRate(pattern) {
  const total = (pattern.outcome_verified || 0) + (pattern.outcome_rejected || 0) + (pattern.outcome_pending || 0);
  if (total === 0) return 0;
  return Math.round(((pattern.outcome_verified || 0) / total) * 100);
}

module.exports = {
  getLearnedPatterns,
  getImprovedPrompt,
  shareOCRInsights
};