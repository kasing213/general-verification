'use strict';

/**
 * X-API-Key Authentication Middleware
 * Validates API key from X-API-Key header
 */
function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'Missing API key',
      message: 'X-API-Key header is required'
    });
  }

  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({
      success: false,
      error: 'Invalid API key',
      message: 'The provided API key is not valid'
    });
  }

  next();
}

/**
 * Learning API Authentication Middleware
 * More flexible auth for internal service communication
 */
function learningApiAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const learningKey = process.env.LEARNING_API_KEY || process.env.API_KEY;

  // Check for API key
  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'Missing API key',
      message: 'X-API-Key header is required for learning endpoints'
    });
  }

  // Allow both main API key and learning-specific key
  if (apiKey !== process.env.API_KEY && apiKey !== learningKey) {
    return res.status(401).json({
      success: false,
      error: 'Invalid API key',
      message: 'The provided API key is not valid for learning endpoints',
      hint: 'Use the same API key configured in OCR service'
    });
  }

  // Log the learning API access for debugging
  console.log(`🔑 Learning API access | Key: ${apiKey.substring(0, 8)}... | From: ${req.ip || 'unknown'}`);

  next();
}

/**
 * Optional: Relaxed auth for internal Railway communication
 * Use this if services are on internal Railway network
 */
function internalServiceAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const userAgent = req.headers['user-agent'];
  const origin = req.headers['origin'] || req.headers['referer'];

  // If API key is provided, validate it
  if (apiKey) {
    return learningApiAuth(req, res, next);
  }

  // For internal services without API key, check other indicators
  if (userAgent && (userAgent.includes('scriptclient') || userAgent.includes('axios'))) {
    console.log(`🚀 Internal service access detected | User-Agent: ${userAgent}`);
    return next();
  }

  // Check if request comes from Railway internal network
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && forwarded.includes('railway.internal')) {
    console.log(`🚂 Railway internal network access detected`);
    return next();
  }

  // Default to requiring API key
  return res.status(401).json({
    success: false,
    error: 'Authentication required',
    message: 'API key required or internal service authentication failed',
    hint: 'Add X-API-Key header with the OCR service API key'
  });
}

module.exports = {
  apiKeyAuth,
  learningApiAuth,
  internalServiceAuth
};
