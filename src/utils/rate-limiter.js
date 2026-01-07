'use strict';

/**
 * OpenAI Rate Limiter
 * Manages API rate limiting with sliding window
 */
class OpenAIRateLimiter {
  constructor(maxRequestsPerMinute = 10) {
    this.maxRequests = maxRequestsPerMinute;
    this.requests = [];
    this.queue = [];
    this.processing = false;
  }

  async waitForSlot() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove requests older than 1 minute
    this.requests = this.requests.filter(time => time > oneMinuteAgo);

    if (this.requests.length >= this.maxRequests) {
      // Wait until the oldest request is older than 1 minute
      const oldestRequest = this.requests[0];
      const waitTime = oldestRequest + 60000 - now + 100; // Add 100ms buffer
      console.log(`Rate limit reached (${this.requests.length}/${this.maxRequests}). Waiting ${Math.ceil(waitTime / 1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.waitForSlot(); // Retry after waiting
    }

    this.requests.push(now);
    console.log(`Rate limiter: ${this.requests.length}/${this.maxRequests} requests in last minute`);
  }

  getStatus() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    this.requests = this.requests.filter(time => time > oneMinuteAgo);
    return {
      currentRequests: this.requests.length,
      maxRequests: this.maxRequests,
      available: this.maxRequests - this.requests.length
    };
  }
}

/**
 * Retry with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {object} options - Retry options
 * @returns {Promise} - Result of successful function call
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = parseInt(process.env.OCR_MAX_RETRIES) || 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffFactor = 2,
    retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'rate_limit', '429', '500', '502', '503']
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const errorMessage = error.message || error.toString();
      const errorCode = error.code || error.status || '';

      // Check if error is retryable
      const isRetryable = retryableErrors.some(e =>
        errorMessage.includes(e) || errorCode.toString().includes(e)
      );

      if (!isRetryable || attempt === maxRetries) {
        console.error(`OCR failed after ${attempt} attempt(s): ${errorMessage}`);
        throw error;
      }

      // Calculate delay with exponential backoff + jitter
      const delay = Math.min(
        initialDelay * Math.pow(backoffFactor, attempt - 1) + Math.random() * 1000,
        maxDelay
      );

      console.log(`OCR attempt ${attempt}/${maxRetries} failed: ${errorMessage}`);
      console.log(`Retrying in ${Math.ceil(delay / 1000)}s...`);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

module.exports = {
  OpenAIRateLimiter,
  retryWithBackoff
};
