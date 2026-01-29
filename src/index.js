'use strict';

require('dotenv').config();

const express = require('express');
const { connect, disconnect } = require('./db/mongo');
const { getRateLimiterStatus } = require('./core/ocr-engine');

// Import routes
const verifyRoutes = require('./routes/verify');
const invoiceRoutes = require('./routes/invoices');
const exportRoutes = require('./routes/export');
const learningRoutes = require('./routes/learning');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// ====== Health & Status Endpoints ======

/**
 * GET /
 * Service info
 */
app.get('/', (req, res) => {
  res.json({
    service: 'OCR Verification Service',
    version: '1.0.0',
    status: 'running'
  });
});

/**
 * GET /health
 * Health check
 */
app.get('/health', async (req, res) => {
  const uptime = process.uptime();

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(uptime),
    service: 'ocr-verification-service'
  });
});

/**
 * GET /status
 * Detailed status
 */
app.get('/status', async (req, res) => {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  const rateLimiter = getRateLimiterStatus();

  res.json({
    service: {
      name: 'OCR Verification Service',
      version: '1.0.0',
      status: 'running'
    },
    ocr: {
      model: 'gpt-4o',
      rateLimiter: rateLimiter
    },
    system: {
      uptime: Math.floor(uptime),
      memory: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
        rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB'
      }
    },
    timestamp: new Date().toISOString()
  });
});

// ====== API Routes ======

app.use('/api/v1/verify', verifyRoutes);
app.use('/api/v1/invoices', invoiceRoutes);
app.use('/api/v1/export', exportRoutes);
app.use('/api/v1/learning', learningRoutes);

// ====== Error Handling ======

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      success: false,
      error: 'File too large',
      message: 'Maximum file size is 10MB'
    });
  }

  if (err.message && err.message.includes('Invalid file type')) {
    return res.status(400).json({
      success: false,
      error: 'Invalid file type',
      message: err.message
    });
  }

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

// ====== Server Startup ======

async function startServer() {
  try {
    // Validate required environment variables
    const requiredEnvVars = ['OPENAI_API_KEY', 'MONGO_URL', 'API_KEY'];
    const missing = requiredEnvVars.filter(v => !process.env[v]);

    if (missing.length > 0) {
      console.error(`Missing required environment variables: ${missing.join(', ')}`);
      process.exit(1);
    }

    // Connect to MongoDB
    await connect();

    // Start server
    app.listen(PORT, () => {
      console.log('═══════════════════════════════════════════');
      console.log('  OCR Verification Service');
      console.log('═══════════════════════════════════════════');
      console.log(`  Server:    http://localhost:${PORT}`);
      console.log(`  Health:    http://localhost:${PORT}/health`);
      console.log(`  API:       http://localhost:${PORT}/api/v1/verify`);
      console.log('═══════════════════════════════════════════');
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  await disconnect();
  process.exit(0);
});

// Start the server
startServer();
