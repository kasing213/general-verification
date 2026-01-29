# Scriptclient ↔ OCR-Service Bidirectional Learning Integration

## Overview

This integration enables bidirectional learning between scriptclient (PostgreSQL-based payment system) and OCR-service (MongoDB-based OCR system). Both systems learn from each other's successes and failures to continuously improve accuracy.

## Key Features

- **Reason-Based Learning**: Analyzes WHY payments are verified/pending/rejected
- **Selective Data Sharing**: Excludes fixed recipient names (OCR-service remains general-purpose)
- **Real-time Pattern Updates**: Both systems improve continuously
- **Bank-Specific Learning**: Learns patterns for different banks independently
- **Quality Feedback Loop**: Learns what makes images succeed or fail

## Architecture

```
┌─────────────────┐    Learning Data    ┌─────────────────┐
│   Scriptclient  │ ──────────────────► │  OCR-Service    │
│   (PostgreSQL)  │                     │   (MongoDB)     │
│                 │ ◄────────────────── │                 │
└─────────────────┘    OCR Insights     └─────────────────┘

Flow:
1. Scriptclient analyzes WHY screenshots succeed/fail
2. Shares learning data (excluding fixed recipient names) → OCR-Service
3. OCR-Service learns patterns and improves prompts
4. OCR-Service shares confidence insights → Scriptclient
5. Both systems continuously improve together
```

## Installation & Setup

### 1. OCR-Service Setup (Already Complete)

The OCR-service is ready with:
- ✅ Learning API endpoints (`/api/v1/learning/*`)
- ✅ MongoDB collections for pattern storage
- ✅ Pattern learning services
- ✅ Enhanced OCR engine with learned patterns

### 2. Scriptclient Setup

#### Step 1: Install Dependencies
```bash
npm install axios
```

#### Step 2: Copy Autolearning Template
```bash
cp docs/scriptclient-autolearning.js /path/to/scriptclient/autolearning.js
```

#### Step 3: Configure Environment
Add to your scriptclient `.env`:
```env
# OCR Service Integration
OCR_SERVICE_URL=http://ocr-service:3000
OCR_API_KEY=your-api-key
LEARNING_ENABLED=true
SYNC_INTERVAL=30
```

#### Step 4: Initialize Autolearning System
```javascript
const ScriptclientAutoLearning = require('./autolearning');

const autoLearning = new ScriptclientAutoLearning({
  ocrServiceUrl: process.env.OCR_SERVICE_URL,
  apiKey: process.env.OCR_API_KEY,
  enableSync: process.env.LEARNING_ENABLED === 'true',
  syncInterval: (process.env.SYNC_INTERVAL || 30) * 60 * 1000
});
```

#### Step 5: Integrate with Payment Verification
```javascript
// In your payment verification workflow
async function processPaymentScreenshot(screenshot, expectedPayment) {
  // Your existing verification logic
  const verificationResult = await verifyPayment(screenshot, expectedPayment);
  const ocrResult = await performOCR(screenshot); // if available

  // NEW: Analyze and learn from the result
  await autoLearning.analyzeScreenshot(
    screenshot,                    // Screenshot data from PostgreSQL
    verificationResult.status,     // 'verified', 'pending', 'rejected'
    ocrResult,                    // OCR result (optional)
    verificationResult            // Detailed verification info
  );

  return verificationResult;
}
```

## API Endpoints

### OCR-Service Learning Endpoints

#### POST `/api/v1/learning/receive`
Receives learning data from scriptclient.

**Headers:**
```
X-API-Key: your-api-key
Content-Type: application/json
```

**Request Body:**
```json
{
  "screenshot_data": {
    "upload_date": "2026-01-28T10:00:00Z",
    "file_size": 245760,
    "quality_score": 0.8
  },
  "analysis": {
    "screenshot_id": "12345",
    "tenant_id": "tenant_1",
    "status": "verified",
    "reasons": {
      "primary_reason": "verification_successful",
      "success_indicators": {
        "high_confidence_extraction": true,
        "complete_data_extraction": true
      }
    },
    "training_data": {
      "bank": "ABA Bank",
      "confidence_level": 0.95,
      "extraction_success": {
        "amount": true,
        "transaction_id": true,
        "date": true
      }
    }
  },
  "tenant_id": "tenant_1"
}
```

**Response:**
```json
{
  "success": true,
  "learning_id": "60a7b8c9d1e2f3a4b5c6d7e8",
  "learned_patterns": {
    "bank_formats": "ABA Bank",
    "confidence_patterns": 0.95
  },
  "improved_prompts": {
    "bank_specific_prompt": "Enhanced prompt for ABA Bank...",
    "quality_requirements": {...}
  }
}
```

#### POST `/api/v1/learning/share`
Shares OCR insights back to scriptclient.

#### GET `/api/v1/learning/stats`
Returns learning progress statistics.

**Response:**
```json
{
  "success": true,
  "learning_statistics": {
    "total_patterns_learned": 156,
    "verified_learnings": 120,
    "pending_learnings": 25,
    "rejected_learnings": 11
  },
  "accuracy_improvements": {
    "period": "30_days",
    "total_learnings": 156
  }
}
```

## Learning Data Flow

### Scriptclient → OCR-Service

**What is shared:**
- ✅ Verification status (verified/pending/rejected)
- ✅ Reason analysis (WHY that status occurred)
- ✅ Bank detection results
- ✅ Image quality metrics
- ✅ Extraction success/failure patterns
- ✅ Confidence level correlations

**What is NOT shared:**
- ❌ Fixed recipient names (preserves OCR-service generality)
- ❌ Actual screenshot images (privacy)
- ❌ Tenant-specific business logic
- ❌ Sensitive payment details

### OCR-Service → Scriptclient

**What is shared:**
- ✅ Improved OCR confidence scoring
- ✅ Bank-specific extraction patterns
- ✅ Image quality requirements
- ✅ Optimal prompt improvements
- ✅ Success/failure predictors

## Learning Outcomes

### Week 1: Initial Data Sharing
- **Scriptclient**: Shares analysis of 500+ historical screenshots
- **OCR-Service**: Learns bank-specific patterns
- **Expected**: 15-20% accuracy improvement

### Week 2: Bidirectional Learning
- **Scriptclient**: Receives improved confidence thresholds
- **OCR-Service**: Gets real-world verification feedback
- **Expected**: 25-30% accuracy improvement

### Week 3: Pattern Optimization
- **Both Systems**: Optimize based on shared learnings
- **Self-Improvement**: Automatic pattern updates
- **Expected**: 35%+ accuracy improvement

## Monitoring & Maintenance

### Learning Statistics
```bash
# Check OCR-Service learning stats
curl -H "X-API-Key: your-key" http://localhost:3000/api/v1/learning/stats

# Check Scriptclient learning queue
console.log('Learning Stats:', autoLearning.getLearningStats());
```

### Manual Sync Triggers
```javascript
// Force immediate sync of all queued learning data
await autoLearning.forceLearningSync();
```

### Performance Monitoring
- **Learning Queue Size**: Monitor `learningQueue.length`
- **Sync Success Rate**: Track successful API calls to OCR-service
- **Pattern Update Frequency**: Monitor pattern collection growth
- **Accuracy Improvements**: Compare before/after verification rates

## Troubleshooting

### Common Issues

#### 1. "No DATABASE_URL found" Warning
```bash
# In OCR-service .env, add (optional):
DATABASE_URL=postgresql://username:password@host:5432/database
```

#### 2. Learning Data Not Syncing
```bash
# Check OCR-service is running
curl http://localhost:3000/health

# Verify API key in scriptclient config
echo $OCR_API_KEY

# Check learning queue size
autoLearning.getLearningStats()
```

#### 3. Pattern Updates Not Applied
```bash
# Check MongoDB learning collections
node scripts/init-learning-collections.js

# Verify pattern counts
curl -H "X-API-Key: your-key" http://localhost:3000/api/v1/learning/stats
```

## Security & Privacy

### Data Protection
- Screenshots are **never** transmitted (only metadata)
- Fixed recipient names are **excluded** from sharing
- All API calls use secure API key authentication
- Learning data is anonymized and aggregated

### API Security
```javascript
// Always use HTTPS in production
const autoLearning = new ScriptclientAutoLearning({
  ocrServiceUrl: 'https://ocr-service.yourdomain.com',
  apiKey: process.env.OCR_API_KEY // Store securely
});
```

## Advanced Configuration

### Custom Learning Patterns
```javascript
// Extend the autolearning class for custom pattern extraction
class CustomAutoLearning extends ScriptclientAutoLearning {
  extractCustomPatterns(screenshot, status, ocrResult) {
    // Implement custom pattern extraction logic
    return {
      custom_bank_indicators: this.detectCustomBankFeatures(screenshot),
      tenant_specific_patterns: this.analyzeTenantPatterns(screenshot.tenant_id)
    };
  }
}
```

### Batch Processing Historical Data
```javascript
// Process historical screenshots for initial learning
async function processHistoricalData() {
  const screenshots = await db.query('SELECT * FROM scriptclient.screenshot ORDER BY created_at DESC LIMIT 1000');

  for (const screenshot of screenshots) {
    await autoLearning.analyzeScreenshot(screenshot, screenshot.verified ? 'verified' : 'pending');
  }

  await autoLearning.forceLearningSync();
  console.log('Historical data processing complete');
}
```

## Integration Checklist

- [ ] OCR-service running with learning endpoints
- [ ] MongoDB learning collections initialized
- [ ] Scriptclient autolearning.js integrated
- [ ] Environment variables configured
- [ ] API key authentication working
- [ ] First learning data successfully sent
- [ ] Pattern updates being applied
- [ ] Monitoring and logging in place
- [ ] Performance improvements measured

## Support

For issues with this integration:
1. Check OCR-service logs: `docker logs ocr-service`
2. Check learning statistics: `GET /api/v1/learning/stats`
3. Verify scriptclient learning queue: `autoLearning.getLearningStats()`
4. Review MongoDB learning collections for pattern growth

The integration creates a true bidirectional learning ecosystem where both scriptclient and OCR-service continuously improve from each other's successes and failures.