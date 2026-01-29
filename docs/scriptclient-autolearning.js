#!/usr/bin/env node

/**
 * Scriptclient Autolearning System
 *
 * This template should be integrated into your scriptclient application.
 * It analyzes WHY payments are verified/pending/rejected and shares
 * that knowledge with OCR-service for bidirectional learning.
 *
 * INSTALLATION INSTRUCTIONS:
 * 1. Copy this file to your scriptclient project
 * 2. Install dependencies: npm install axios
 * 3. Configure OCR_SERVICE_URL and API key
 * 4. Call analyzeScreenshot() after each payment verification
 * 5. Set up periodic sync with syncLearningData()
 */

'use strict';

const axios = require('axios');

class ScriptclientAutoLearning {
  constructor(config = {}) {
    this.config = {
      ocrServiceUrl: config.ocrServiceUrl || process.env.OCR_SERVICE_URL || 'http://localhost:3000',
      apiKey: config.apiKey || process.env.OCR_API_KEY,
      enableSync: config.enableSync !== false,
      syncInterval: config.syncInterval || 30 * 60 * 1000, // 30 minutes
      batchSize: config.batchSize || 10,
      ...config
    };

    this.learningQueue = [];
    this.patterns = {
      rejection_reasons: {},
      success_patterns: {},
      pending_patterns: {}
    };

    if (this.config.enableSync) {
      this.startPeriodicSync();
    }

    console.log('🤖 Scriptclient AutoLearning initialized');
    console.log(`📡 OCR Service: ${this.config.ocrServiceUrl}`);
  }

  /**
   * Main analysis function - call this after each payment verification
   * @param {Object} screenshot - Screenshot data from PostgreSQL
   * @param {string} status - 'verified', 'pending', or 'rejected'
   * @param {Object} ocrResult - OCR analysis result (if available)
   * @param {Object} verificationDetails - Detailed verification result
   */
  async analyzeScreenshot(screenshot, status, ocrResult = null, verificationDetails = {}) {
    try {
      console.log(`🔍 Analyzing screenshot | ID: ${screenshot.id} | Status: ${status}`);

      const analysis = {
        screenshot_id: screenshot.id,
        tenant_id: screenshot.tenant_id,
        status: status,
        timestamp: new Date(),

        // Deep analysis of WHY this status occurred
        reasons: this.detectReasons(screenshot, status, ocrResult, verificationDetails),
        patterns: this.extractPatterns(screenshot, status, ocrResult),

        // Training data to share with OCR (excluding fixed recipient names)
        training_data: {
          bank: ocrResult?.bank || this.detectBankFromScreenshot(screenshot),
          confidence_level: ocrResult?.confidence || this.estimateConfidence(screenshot, status),
          extraction_success: this.analyzeExtractionSuccess(ocrResult, verificationDetails),
          failure_points: this.identifyFailurePoints(ocrResult, status, verificationDetails)
        },

        // Screenshot metadata (do not include actual image data for privacy)
        screenshot_metadata: {
          upload_date: screenshot.created_at,
          file_size: screenshot.file_size,
          dimensions: screenshot.dimensions,
          quality_score: this.assessImageQuality(screenshot)
        }
      };

      // Store in learning queue
      this.learningQueue.push(analysis);

      // Update local patterns
      this.updateLocalPatterns(analysis);

      // If immediate sync is enabled, send to OCR service
      if (this.config.enableSync && this.learningQueue.length >= this.config.batchSize) {
        await this.syncLearningData();
      }

      console.log(`💾 Analysis queued | Queue size: ${this.learningQueue.length}`);

      return analysis;

    } catch (error) {
      console.error('Error in analyzeScreenshot:', error);
      return null;
    }
  }

  /**
   * Detect WHY a screenshot received its verification status
   */
  detectReasons(screenshot, status, ocrResult, verificationDetails) {
    const reasons = {
      primary_reason: null,
      contributing_factors: [],
      confidence_factors: {},
      quality_issues: [],
      extraction_issues: []
    };

    switch (status) {
      case 'rejected':
        reasons.primary_reason = this.detectRejectionReason(verificationDetails, ocrResult);
        reasons.quality_issues = this.identifyQualityIssues(screenshot, ocrResult);
        reasons.extraction_issues = this.identifyExtractionFailures(ocrResult, verificationDetails);
        break;

      case 'pending':
        reasons.primary_reason = this.detectPendingReason(verificationDetails, ocrResult);
        reasons.confidence_factors = this.analyzeConfidenceFactors(ocrResult, screenshot);
        reasons.contributing_factors = this.identifyPendingFactors(verificationDetails);
        break;

      case 'verified':
        reasons.primary_reason = 'verification_successful';
        reasons.success_indicators = this.extractSuccessIndicators(ocrResult, verificationDetails);
        reasons.quality_indicators = this.identifyQualitySuccessFactors(screenshot);
        break;
    }

    return reasons;
  }

  /**
   * Extract learnable patterns from the screenshot analysis
   */
  extractPatterns(screenshot, status, ocrResult) {
    return {
      bank_patterns: this.extractBankPatterns(ocrResult, screenshot),
      amount_patterns: this.extractAmountPatterns(ocrResult, status),
      date_patterns: this.extractDatePatterns(ocrResult, status),
      quality_patterns: this.extractQualityPatterns(screenshot, status),
      tenant_patterns: this.extractTenantPatterns(screenshot.tenant_id, status),
      temporal_patterns: this.extractTemporalPatterns(screenshot, status)
    };
  }

  /**
   * Detect primary rejection reason
   */
  detectRejectionReason(verificationDetails, ocrResult) {
    // Analyze verification failure points
    if (verificationDetails.reason_code) {
      return verificationDetails.reason_code;
    }

    if (!ocrResult) {
      return 'ocr_processing_failed';
    }

    if (ocrResult.confidence === 'low') {
      return 'poor_image_quality';
    }

    if (!ocrResult.amount) {
      return 'amount_extraction_failed';
    }

    if (!ocrResult.bank) {
      return 'bank_detection_failed';
    }

    if (verificationDetails.amount_mismatch) {
      return 'amount_verification_failed';
    }

    if (verificationDetails.recipient_mismatch) {
      return 'recipient_verification_failed';
    }

    return 'unknown_rejection_reason';
  }

  /**
   * Detect primary pending reason
   */
  detectPendingReason(verificationDetails, ocrResult) {
    if (ocrResult && ocrResult.confidence === 'medium') {
      return 'medium_confidence_requires_review';
    }

    if (verificationDetails.manual_review_required) {
      return 'requires_manual_verification';
    }

    if (verificationDetails.partial_extraction) {
      return 'incomplete_data_extraction';
    }

    return 'general_uncertainty';
  }

  /**
   * Analyze confidence factors for pending status
   */
  analyzeConfidenceFactors(ocrResult, screenshot) {
    return {
      ocr_confidence: ocrResult?.confidence,
      image_quality: this.assessImageQuality(screenshot),
      extraction_completeness: this.calculateExtractionCompleteness(ocrResult),
      bank_recognition: ocrResult?.bank ? 'detected' : 'failed',
      data_consistency: this.assessDataConsistency(ocrResult)
    };
  }

  /**
   * Extract success indicators from verified payments
   */
  extractSuccessIndicators(ocrResult, verificationDetails) {
    return {
      high_confidence_extraction: ocrResult?.confidence === 'high',
      complete_data_extraction: this.calculateExtractionCompleteness(ocrResult) > 0.8,
      bank_successfully_detected: !!ocrResult?.bank,
      amount_accurately_extracted: !!ocrResult?.amount,
      recipient_data_present: !!ocrResult?.recipient,
      transaction_id_extracted: !!ocrResult?.transaction_id,
      verification_speed: verificationDetails.processing_time
    };
  }

  /**
   * Sync accumulated learning data with OCR service
   */
  async syncLearningData() {
    if (this.learningQueue.length === 0) {
      console.log('📡 No learning data to sync');
      return;
    }

    try {
      console.log(`📡 Syncing ${this.learningQueue.length} learning samples with OCR service...`);

      const batch = this.learningQueue.splice(0, this.config.batchSize);

      for (const analysis of batch) {
        await this.sendLearningData(analysis);
      }

      console.log(`✅ Successfully synced ${batch.length} learning samples`);

    } catch (error) {
      console.error('❌ Error syncing learning data:', error);
      // Re-queue failed items
      this.learningQueue.unshift(...batch);
    }
  }

  /**
   * Send individual learning data to OCR service
   */
  async sendLearningData(analysis) {
    try {
      const response = await axios.post(
        `${this.config.ocrServiceUrl}/api/v1/learning/receive`,
        {
          screenshot_data: analysis.screenshot_metadata,
          analysis: analysis,
          tenant_id: analysis.tenant_id
        },
        {
          headers: {
            'X-API-Key': this.config.apiKey,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data.success) {
        console.log(`📤 Learning data sent | ID: ${analysis.screenshot_id} | Status: ${analysis.status}`);

        // Process any improved prompts returned by OCR service
        if (response.data.improved_prompts) {
          this.processImprovedPrompts(response.data.improved_prompts);
        }

        return response.data;
      } else {
        throw new Error(response.data.error || 'Unknown error');
      }

    } catch (error) {
      console.error(`❌ Failed to send learning data for screenshot ${analysis.screenshot_id}:`, error.message);
      throw error;
    }
  }

  /**
   * Process improved prompts received from OCR service
   */
  processImprovedPrompts(improvedPrompts) {
    // Store or apply improved prompts in your scriptclient system
    console.log('💡 Received improved prompts from OCR service:', improvedPrompts);

    // Example: Update your OCR configuration with improved prompts
    if (improvedPrompts.bank_specific_prompt) {
      // Apply bank-specific improvements to your OCR calls
    }

    if (improvedPrompts.quality_requirements) {
      // Update image quality requirements
    }
  }

  /**
   * Start periodic sync with OCR service
   */
  startPeriodicSync() {
    setInterval(() => {
      if (this.learningQueue.length > 0) {
        this.syncLearningData().catch(console.error);
      }
    }, this.config.syncInterval);

    console.log(`⏰ Periodic sync started | Interval: ${this.config.syncInterval}ms`);
  }

  /**
   * Update local pattern storage
   */
  updateLocalPatterns(analysis) {
    const status = analysis.status;

    if (!this.patterns[`${status}_patterns`]) {
      this.patterns[`${status}_patterns`] = {};
    }

    // Update bank patterns
    const bank = analysis.training_data.bank;
    if (bank) {
      if (!this.patterns.bank_patterns) this.patterns.bank_patterns = {};
      if (!this.patterns.bank_patterns[bank]) this.patterns.bank_patterns[bank] = { count: 0, statuses: {} };

      this.patterns.bank_patterns[bank].count++;
      this.patterns.bank_patterns[bank].statuses[status] = (this.patterns.bank_patterns[bank].statuses[status] || 0) + 1;
    }

    // Update tenant patterns
    const tenantId = analysis.tenant_id;
    if (!this.patterns.tenant_patterns) this.patterns.tenant_patterns = {};
    if (!this.patterns.tenant_patterns[tenantId]) this.patterns.tenant_patterns[tenantId] = { count: 0, statuses: {} };

    this.patterns.tenant_patterns[tenantId].count++;
    this.patterns.tenant_patterns[tenantId].statuses[status] = (this.patterns.tenant_patterns[tenantId].statuses[status] || 0) + 1;
  }

  /**
   * Helper functions for pattern extraction and analysis
   */

  detectBankFromScreenshot(screenshot) {
    // Implement bank detection logic based on screenshot metadata or filename patterns
    // This is a placeholder - implement based on your screenshot data structure
    return 'unknown';
  }

  estimateConfidence(screenshot, status) {
    // Estimate confidence based on status and image quality
    if (status === 'verified') return 0.9;
    if (status === 'pending') return 0.6;
    return 0.3;
  }

  assessImageQuality(screenshot) {
    // Implement image quality assessment
    // Return score between 0-1
    return 0.8; // placeholder
  }

  calculateExtractionCompleteness(ocrResult) {
    if (!ocrResult) return 0;

    const fields = ['amount', 'bank', 'transaction_id', 'recipient', 'date'];
    const extractedFields = fields.filter(field => ocrResult[field]);

    return extractedFields.length / fields.length;
  }

  assessDataConsistency(ocrResult) {
    // Analyze consistency of extracted data
    return 'consistent'; // placeholder
  }

  // Implement other helper methods for pattern extraction...
  extractBankPatterns(ocrResult, screenshot) { return {}; }
  extractAmountPatterns(ocrResult, status) { return {}; }
  extractDatePatterns(ocrResult, status) { return {}; }
  extractQualityPatterns(screenshot, status) { return {}; }
  extractTenantPatterns(tenantId, status) { return {}; }
  extractTemporalPatterns(screenshot, status) { return {}; }
  identifyQualityIssues(screenshot, ocrResult) { return []; }
  identifyExtractionFailures(ocrResult, verificationDetails) { return []; }
  identifyPendingFactors(verificationDetails) { return []; }
  identifyQualitySuccessFactors(screenshot) { return []; }
  analyzeExtractionSuccess(ocrResult, verificationDetails) { return {}; }
  identifyFailurePoints(ocrResult, status, verificationDetails) { return []; }

  /**
   * Get current learning statistics
   */
  getLearningStats() {
    return {
      queue_size: this.learningQueue.length,
      patterns_tracked: Object.keys(this.patterns).length,
      bank_patterns: Object.keys(this.patterns.bank_patterns || {}).length,
      tenant_patterns: Object.keys(this.patterns.tenant_patterns || {}).length,
      last_sync: this.lastSyncTime,
      config: this.config
    };
  }

  /**
   * Manual trigger for immediate sync
   */
  async forceLearningSync() {
    console.log('🚀 Force syncing all learning data...');
    const originalBatchSize = this.config.batchSize;
    this.config.batchSize = this.learningQueue.length;

    try {
      await this.syncLearningData();
      console.log('✅ Force sync completed');
    } finally {
      this.config.batchSize = originalBatchSize;
    }
  }
}

/**
 * Usage Example:
 *
 * // Initialize the learning system
 * const autoLearning = new ScriptclientAutoLearning({
 *   ocrServiceUrl: 'http://ocr-service:3000',
 *   apiKey: 'your-api-key',
 *   enableSync: true,
 *   syncInterval: 30 * 60 * 1000 // 30 minutes
 * });
 *
 * // In your payment verification workflow:
 * async function processPaymentScreenshot(screenshot, expectedPayment) {
 *   // Your existing verification logic...
 *   const verificationResult = await verifyPayment(screenshot, expectedPayment);
 *   const ocrResult = await performOCR(screenshot);
 *
 *   // Analyze and learn from the result
 *   await autoLearning.analyzeScreenshot(
 *     screenshot,
 *     verificationResult.status, // 'verified', 'pending', 'rejected'
 *     ocrResult,
 *     verificationResult
 *   );
 *
 *   return verificationResult;
 * }
 *
 * // Get learning statistics
 * console.log('Learning Stats:', autoLearning.getLearningStats());
 *
 * // Force immediate sync
 * await autoLearning.forceLearningSync();
 */

module.exports = ScriptclientAutoLearning;