'use strict';

/**
 * Configuration Schema
 * Default values (all can be overridden per request)
 */
module.exports = {
  // Default payment verification values
  defaults: {
    expectedAccount: null,      // No recipient check by default
    expectedNames: null,        // No name matching by default
    tolerancePercent: 5,        // 5% amount tolerance
    currency: 'KHR'             // Default currency
  },

  // Verification rules
  rules: {
    maxScreenshotAgeDays: parseInt(process.env.MAX_SCREENSHOT_AGE_DAYS) || 7,
    requireHighConfidence: true,
    checkDuplicateTransactions: true
  },

  // OCR settings
  ocr: {
    model: 'gpt-4o',
    timeout: parseInt(process.env.OCR_TIMEOUT_MS) || 60000,
    maxRetries: parseInt(process.env.OCR_MAX_RETRIES) || 3,
    rateLimit: parseInt(process.env.OCR_RATE_LIMIT_PER_MINUTE) || 10
  },

  // Upload settings
  upload: {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    uploadDir: './uploads'
  }
};
