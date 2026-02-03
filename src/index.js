'use strict';

require('dotenv').config();

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { connect, disconnect } = require('./db/mongo');
const { getRateLimiterStatus } = require('./core/ocr-engine');
const { optionalMerchantAuth } = require('./middleware/merchant-auth');
const NotificationService = require('./services/notification-service');

// Import routes
const verifyRoutes = require('./routes/verify');
const invoiceRoutes = require('./routes/invoices');
const exportRoutes = require('./routes/export');
const learningRoutes = require('./routes/learning');
const auditRoutes = require('./routes/audit');

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;

// Initialize Socket.io with CORS
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Initialize notification service with WebSocket
const notificationService = new NotificationService();
notificationService.setSocketServer(io);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files for audit interface
app.use('/audit', express.static('public/audit'));

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
app.use('/api/v1/audit', auditRoutes);

// ====== WebSocket Handlers ======

io.use(async (socket, next) => {
  try {
    // Extract token from handshake
    const token = socket.handshake.auth.token || socket.handshake.query.token;

    if (!token) {
      return next(new Error('Authentication token required'));
    }

    // Verify merchant token
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || process.env.API_KEY || 'default-secret-change-in-production';

    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.type !== 'merchant') {
      return next(new Error('Invalid token type'));
    }

    socket.merchant = {
      id: decoded.merchant_id,
      name: decoded.name,
      email: decoded.email
    };

    next();
  } catch (error) {
    console.error('WebSocket auth error:', error.message);
    next(new Error('Authentication failed'));
  }
});

io.on('connection', (socket) => {
  const merchantId = socket.merchant.id;
  const merchantRoom = `merchant_${merchantId}`;

  console.log(`🔌 Merchant ${merchantId} connected via WebSocket`);

  // Join merchant-specific room
  socket.join(merchantRoom);

  // Send welcome message
  socket.emit('connected', {
    message: 'Connected to audit interface',
    merchant_id: merchantId,
    room: merchantRoom
  });

  // Handle merchant ping
  socket.on('ping', (data) => {
    socket.emit('pong', {
      timestamp: new Date().toISOString(),
      merchant_id: merchantId
    });
  });

  // Handle subscription to payment updates
  socket.on('subscribe_payment', (paymentId) => {
    socket.join(`payment_${paymentId}`);
    console.log(`📡 Merchant ${merchantId} subscribed to payment ${paymentId}`);
  });

  // Handle unsubscription from payment updates
  socket.on('unsubscribe_payment', (paymentId) => {
    socket.leave(`payment_${paymentId}`);
    console.log(`📡 Merchant ${merchantId} unsubscribed from payment ${paymentId}`);
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 Merchant ${merchantId} disconnected:`, reason);
  });
});

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
    server.listen(PORT, () => {
      console.log('═══════════════════════════════════════════');
      console.log('  OCR Verification Service with Audit Interface');
      console.log('═══════════════════════════════════════════');
      console.log(`  Server:     http://localhost:${PORT}`);
      console.log(`  Health:     http://localhost:${PORT}/health`);
      console.log(`  API:        http://localhost:${PORT}/api/v1/verify`);
      console.log(`  Audit:      http://localhost:${PORT}/audit`);
      console.log(`  WebSocket:  ws://localhost:${PORT}`);
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
