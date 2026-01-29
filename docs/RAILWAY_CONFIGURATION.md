# Railway Deployment Configuration

## Overview

This document provides the specific configuration needed to deploy both OCR-service and scriptclient on Railway with proper bidirectional learning integration.

## Railway Environment Variables Setup

### OCR-Service Railway Configuration

Add these environment variables to your OCR-service Railway deployment:

```env
# API Authentication
API_KEY=your-secure-api-key-here

# OpenAI Configuration
OPENAI_API_KEY=sk-proj-your-openai-api-key-here

# MongoDB Configuration
MONGO_URL=mongodb+srv://username:password@cluster.mongodb.net/customerDB?retryWrites=true&w=majority
DB_NAME=customerDB

# Server Configuration
PORT=3000

# OCR Settings
OCR_TIMEOUT_MS=60000
OCR_MAX_RETRIES=3
OCR_RATE_LIMIT_PER_MINUTE=10

# Verification Rules
PAYMENT_TOLERANCE_PERCENT=5
MAX_SCREENSHOT_AGE_DAYS=7
USD_TO_KHR_RATE=4000

# Scriptclient Learning Integration
SCRIPTCLIENT_WEBHOOK=https://your-scriptclient.railway.app/api/webhook/ocr-insights
ACCEPT_LEARNING_DATA=true
PATTERN_UPDATE_THRESHOLD=10
LEARNING_SYNC_ENABLED=true
SYNC_INTERVAL_MINUTES=30
LEARNING_API_KEY=your-secure-api-key-here

# Optional: PostgreSQL for scriptclient data analysis
# DATABASE_URL=postgresql://username:password@host:5432/database
```

### Scriptclient Railway Configuration

Add these environment variables to your scriptclient Railway deployment:

```env
# OCR Service Integration
OCR_SERVICE_URL=https://your-ocr-service.railway.app
OCR_API_KEY=your-secure-api-key-here
LEARNING_ENABLED=true
SYNC_INTERVAL=30

# Your existing scriptclient environment variables...
DATABASE_URL=postgresql://username:password@host:5432/database
# ... other vars
```

## Important Security Notes

⚠️ **NEVER commit real credentials to git!**

- Replace `your-secure-api-key-here` with your actual API key
- Replace `your-openai-api-key-here` with your actual OpenAI key
- Replace `username:password@cluster.mongodb.net` with your actual MongoDB credentials
- Use Railway's environment variable dashboard to set these securely

## Authentication Configuration

Both services must use the **same API key** for authentication:

```env
# Same value in both services
API_KEY=your-secure-api-key-here          # In OCR-service
OCR_API_KEY=your-secure-api-key-here      # In scriptclient
```

## Testing Configuration

To test if the configuration is working:

```bash
# Test health endpoint (replace with your actual Railway URL)
curl https://your-ocr-service.railway.app/health

# Test learning API (replace API key and URL)
curl -X GET \
  -H "X-API-Key: your-actual-api-key" \
  https://your-ocr-service.railway.app/api/v1/learning/stats
```

## Configuration Troubleshooting

1. **Authentication Errors**: Verify API keys match exactly in both services
2. **Connection Errors**: Check Railway URLs are correct and services are running
3. **Database Errors**: Verify MongoDB connection string is valid

Remember to keep all credentials secure and never expose them in documentation or code!