# CLAUDE.md — OCR Service Project Instructions

## Architecture

Node.js OCR microservice for Cambodian bank payment verification.

```
PaddleOCR → Tesseract → GPT-4o Vision (cascading fallback)
    ↓
Payment Parser (bank-specific regex extraction)
    ↓
4-Stage Verification Pipeline (verification.js)
    ↓
MongoDB Storage (payments, fraudAlerts, screenshots via GridFS)
```

## Key Files

```
src/core/verification.js          - 4-stage verification pipeline + duplicate pre-check
src/core/ocr-engine.js            - OCR routing (PaddleOCR → Tesseract → GPT-4o)
src/core/fraud-detector.js        - Date validation, fraud alert records, severity
src/core/khmer-date.js            - Deterministic Khmer date/number parser

src/services/payment-parser.js    - Bank-specific regex extraction + transactionId sanitization
src/services/name-intelligence.js - 7-step name matching (exact → normalize → OCR correct → initial → token → Levenshtein → alias)
src/services/bank-template-matcher.js - Bank template definitions
src/services/paddle-ocr.js        - PaddleOCR client
src/services/tesseract-ocr.js     - Tesseract client
src/services/image-enhancer.js    - Image quality enhancement

src/routes/verify.js              - POST /api/v1/verify endpoint + E11000 duplicate handler
src/routes/audit.js               - Audit trail endpoints
src/db/mongo.js                   - MongoDB connection, collections, GridFS, indexes
```

## Verification Pipeline (`src/core/verification.js`)

```
Image → OCR Extraction → PRE-CHECK: Duplicate Transaction
    ↓
Stage 1: Bank statement detection (isBankStatement)
Stage 2: Confidence check (low/medium → PENDING)
Stage 3: Security verification
  3a: Recipient verification (name intelligence 7-step)
  3b: Date validation (old screenshot >7 days)
  3c: Bank verification
  3d: Amount verification (±5% tolerance)
Stage 4: GPT judgment (borderline name matches 70-84%)
    ↓
Result: verified | pending | rejected
```

## Fraud Detection & Duplicate Transaction Prevention

### TransactionId Sanitization (`src/services/payment-parser.js`)

GPT-4o sometimes extracts merchant account/phone numbers as `transactionId`. Since all customers pay the same merchant, this causes false duplicate flags.

**Banking standard:** Transaction IDs (UTR, UETR, bank reference numbers) are always globally unique, long alphanumeric strings.

**Sanitization rule (applied after extraction):**
```
IF transactionId is pure digits AND ≤ 13 chars → null (account/phone number)
Real transaction IDs: longer OR contain letters (always)
```

| Bank | Transaction ID Format | Account/Phone Format |
|------|----------------------|---------------------|
| ABA | `Trx. ID: FT24xxx...` (16-20 chars, alphanumeric) | 9-12 digits |
| Wing | 15-20+ chars, alphanumeric | 8-10 digits (phone) |
| ACLEDA | `TXN ID: xxx` (12-20 chars) | 10-13 digits |
| Canadia | 14-20 chars, alphanumeric | 10-12 digits |
| Prince | Reference number (14-20 chars) | 10-12 digits |
| Sathapana | Reference number (14-20 chars) | 10-12 digits |

### Duplicate Detection Pre-Check (`src/core/verification.js`)

Runs BEFORE Stage 1. Checks `payments.findByTransactionId()` in MongoDB:
- If existing payment found (status != rejected) → REJECTED / DUPLICATE_TRANSACTION + fraud alert
- Wrapped in try/catch — DB failure degrades gracefully (skips check, proceeds with verification)

### E11000 Race Condition Handler (`src/routes/verify.js`)

MongoDB has a unique sparse index on `payments.transactionId`. If two identical screenshots are processed simultaneously:
1. First insert succeeds
2. Second insert hits E11000 duplicate key error
3. Handler: sets rejection status, re-inserts without transactionId for audit trail

### Fraud Alert Types

| `fraudType` | Severity | Trigger |
|-------------|----------|---------|
| `OLD_SCREENSHOT` | MEDIUM/HIGH | Transaction date > MAX_SCREENSHOT_AGE_DAYS (default 7) |
| `DUPLICATE_TRANSACTION` | CRITICAL | Same transactionId already in payments collection |
| `FUTURE_DATE` | HIGH | Transaction date in the future |
| `INVALID_DATE` | MEDIUM | Cannot parse date format |
| `MISSING_DATE` | LOW | No date found in screenshot |
| `WRONG_RECIPIENT` | HIGH | Recipient name mismatch |

### Verification Statuses

| Status | paymentLabel | When |
|--------|-------------|------|
| `verified` | PAID | All checks pass, confidence ≥ high |
| `pending` | PENDING | Low/medium confidence, amount mismatch, old screenshot, GPT judgment needed |
| `rejected` | UNPAID | Not bank statement, wrong recipient, duplicate transaction |

## MongoDB Collections & Indexes

```javascript
// Collections (src/db/mongo.js)
invoices        - Invoice records
payments        - Payment verification records
fraudAlerts     - Fraud alert records (OLD_SCREENSHOT, DUPLICATE_TRANSACTION, etc.)
auditLogs       - Audit trail
notifications   - Merchant notifications

// Key indexes
payments: { transactionId: 1 } (unique, sparse)  // Duplicate detection
payments: { invoice_id: 1 }, { customer_id: 1 }, { merchant_id: 1 }
fraudAlerts: { alertId: 1 } (unique), { payment_id: 1 }

// GridFS bucket: 'screenshots' (shared or main DB)
```

## Name Intelligence (`src/services/name-intelligence.js`)

7-step matching pipeline for recipient name verification:

| Step | Method | Confidence |
|------|--------|-----------|
| 1 | Exact match (case-insensitive) | 100% |
| 2 | Normalized match (strip punctuation, uppercase) | 98% |
| 3 | OCR error correction (0↔O, 1↔I, rn↔m, etc.) | 95% |
| 4 | Initial/prefix match (K. ↔ KANHA) | 80-90% |
| 5 | Token matching (word-level similarity ≥ 80%) | 85%+ |
| 6 | Levenshtein distance (≤ 30% normalized difference) | 70%+ |
| 7 | Tenant-specific aliases | 80%+ |

**Decision thresholds:**
- ≥ 85% (`strictThreshold`): Auto-approve
- 70-84% (`gptThreshold`): GPT judgment / manual review
- < 70%: Reject

**Khmer script handling:** Detected by `/[\u1780-\u17FF]/` — preserves structure, only strips zero-width chars (no uppercase, no punctuation removal).

## Khmer Date Parser (`src/core/khmer-date.js`)

Deterministic parsing — no AI translation. See scriptclient CLAUDE.md for full details.

- Khmer digits: U+17E0-U+17E9 → 0-9 (charCode subtraction)
- Month lookup: ~100 entries (full Khmer, short, skeleton, English)
- Position-aware: month name as anchor, day/year by position relative to month

## Environment Variables

```
# OCR Service
OPENAI_API_KEY              - GPT-4o Vision API key
MONGO_URL                   - MongoDB connection (main DB)
MONGO_SHARE_URL             - MongoDB connection (shared screenshots DB)
DB_NAME                     - Main database name (default: ocrServiceDB)
SHARE_DB_NAME               - Shared database name (default: customerDB)

# OCR Engine Config
GPT_FALLBACK_ENABLED        - Enable GPT-4o fallback (default: false)
TESSERACT_FALLBACK_ENABLED  - Enable Tesseract fallback (default: false)
OCR_RATE_LIMIT_PER_MINUTE   - GPT-4o rate limit (default: 10)
OCR_TIMEOUT_MS              - GPT-4o timeout (default: 60000)
TESSERACT_CONFIDENCE_THRESHOLD - Min Tesseract confidence (default: 70)

# Verification Config
PAYMENT_TOLERANCE_PERCENT   - Amount match tolerance (default: 5%)
MAX_SCREENSHOT_AGE_DAYS     - Old screenshot threshold (default: 7)

# Name Intelligence
NAME_MATCH_STRICT_THRESHOLD - Auto-approve threshold (default: 85)
NAME_MATCH_GPT_THRESHOLD    - GPT judgment threshold (default: 70)
MAX_LEVENSHTEIN_DISTANCE    - Max edit distance (default: 2)
ENABLE_OCR_CORRECTION       - OCR error correction (default: true)
ENABLE_INITIAL_MATCHING     - Initial/prefix matching (default: true)
```
