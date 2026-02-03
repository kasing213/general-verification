'use strict';

/**
 * Merchant Authentication Middleware
 * Handles JWT-based authentication for merchants accessing the audit interface
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || process.env.API_KEY || 'default-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

/**
 * Generate JWT token for merchant
 * @param {object} merchantData - Merchant data { id, name, email }
 * @returns {string} - JWT token
 */
function generateMerchantToken(merchantData) {
  const payload = {
    merchant_id: merchantData.id,
    name: merchantData.name,
    email: merchantData.email,
    type: 'merchant',
    iat: Math.floor(Date.now() / 1000)
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Merchant JWT Authentication Middleware
 * Validates JWT token and extracts merchant info
 */
function merchantAuth(req, res, next) {
  try {
    // Check for token in multiple locations
    let token = null;

    // 1. Authorization header (Bearer token)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    // 2. X-Merchant-Token header
    if (!token) {
      token = req.headers['x-merchant-token'];
    }

    // 3. Cookie (for web interface)
    if (!token && req.headers.cookie) {
      const cookies = req.headers.cookie.split(';');
      const tokenCookie = cookies.find(c => c.trim().startsWith('merchant_token='));
      if (tokenCookie) {
        token = tokenCookie.split('=')[1];
      }
    }

    // 4. Query parameter (for WebSocket connections)
    if (!token && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided',
        message: 'Merchant authentication token is required'
      });
    }

    // Verify and decode token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Validate token type
    if (decoded.type !== 'merchant') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token type',
        message: 'Token must be a merchant token'
      });
    }

    // Add merchant info to request
    req.merchant = {
      id: decoded.merchant_id,
      name: decoded.name,
      email: decoded.email,
      token: token
    };

    next();

  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired',
        message: 'Merchant token has expired, please login again'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token',
        message: 'Invalid merchant authentication token'
      });
    }

    console.error('Merchant auth error:', error);
    return res.status(500).json({
      success: false,
      error: 'Authentication error',
      message: 'Failed to authenticate merchant token'
    });
  }
}

/**
 * Optional Merchant Authentication
 * Similar to merchantAuth but doesn't fail if no token provided
 */
function optionalMerchantAuth(req, res, next) {
  try {
    // Try to get token (same logic as merchantAuth)
    let token = null;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    if (!token) {
      token = req.headers['x-merchant-token'];
    }

    if (!token && req.headers.cookie) {
      const cookies = req.headers.cookie.split(';');
      const tokenCookie = cookies.find(c => c.trim().startsWith('merchant_token='));
      if (tokenCookie) {
        token = tokenCookie.split('=')[1];
      }
    }

    if (!token && req.query.token) {
      token = req.query.token;
    }

    // If no token, continue without merchant info
    if (!token) {
      req.merchant = null;
      return next();
    }

    // Verify token if provided
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.type === 'merchant') {
      req.merchant = {
        id: decoded.merchant_id,
        name: decoded.name,
        email: decoded.email,
        token: token
      };
    } else {
      req.merchant = null;
    }

    next();

  } catch (error) {
    // On any error, just continue without merchant info
    req.merchant = null;
    next();
  }
}

/**
 * Simple merchant login endpoint
 * @param {object} credentials - { merchant_id, api_key }
 * @returns {object} - { token, merchant }
 */
async function authenticateMerchant(credentials) {
  const { merchant_id, api_key } = credentials;

  // Simple validation - in production, validate against database
  if (!merchant_id || !api_key) {
    throw new Error('Merchant ID and API key are required');
  }

  // For now, use API_KEY as master key, but in production you'd validate merchant-specific keys
  if (api_key !== process.env.API_KEY) {
    throw new Error('Invalid API key');
  }

  // Create merchant object (in production, fetch from database)
  const merchant = {
    id: merchant_id,
    name: `Merchant ${merchant_id}`,
    email: `${merchant_id}@merchant.local`
  };

  const token = generateMerchantToken(merchant);

  return {
    token,
    merchant,
    expires_in: JWT_EXPIRES_IN
  };
}

/**
 * Admin-only middleware (for advanced audit operations)
 */
function adminAuth(req, res, next) {
  // First check if user is authenticated as merchant
  merchantAuth(req, res, (err) => {
    if (err) return;

    // Check if merchant has admin privileges
    // For now, any merchant with 'admin' in ID is considered admin
    // In production, check against proper admin role system
    if (!req.merchant.id.includes('admin')) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required',
        message: 'This operation requires administrator privileges'
      });
    }

    next();
  });
}

/**
 * Merchant access control - ensure merchant can only access their own data
 */
function merchantAccessControl(req, res, next) {
  const merchantId = req.merchant?.id;

  // Check various sources for merchant_id in request
  const requestMerchantId = req.params.merchantId || req.query.merchant_id || req.body.merchant_id;

  // If merchant_id is specified in request, ensure it matches authenticated merchant
  if (requestMerchantId && requestMerchantId !== merchantId) {
    return res.status(403).json({
      success: false,
      error: 'Access denied',
      message: 'You can only access your own data'
    });
  }

  // Add merchant ID to request for database queries
  req.merchantId = merchantId;
  next();
}

module.exports = {
  merchantAuth,
  optionalMerchantAuth,
  adminAuth,
  merchantAccessControl,
  generateMerchantToken,
  authenticateMerchant
};