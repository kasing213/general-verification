# CLAUDE.md — OCR Service Project Instructions

## Architecture

Node.js OCR microservice for Cambodian bank payment verification.

```
Claude 3-agent (primary)   →  PaddleOCR → Tesseract → GPT-4o Vision (fallback cascade)
    ↓                            ↓
    └────────────── adaptClaudeResult / Payment Parser ──────────────┘
                                 ↓
              4-Stage Verification Pipeline (verification.js)
                                 ↓
              MongoDB Storage (payments, fraudAlerts, screenshots via GridFS)
```

**Primary path — Claude 3-agent (Haiku 5.5 by default, `CLAUDE_OCR_MODEL`).** Three parallel agents — DATE
(verbatim Khmer-safe transcription), AMOUNT (no math, no conversion), and
META (classification + transactionId/account/recipient/bank) — fire in
parallel. Wall-clock is `max(A,B,C)` ≈ 2-3s. Activates when
`ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) is set and `OCR_PRIMARY` is not
`cascade`. On any error, falls through automatically to the cascade.

**Model choice (2026-10-12: Sonnet 4.6 -> Haiku 5.5, cost).** All three
agents default to `claude-haiku-5-5` ($0.10 / $0.50 per MTok for prompts up to
100k tokens; a screenshot prompt is ~5k) vs Sonnet 4.6's $3 / $15. Estimated
per scan: Sonnet 4.6 ~$0.035 -> Haiku 4.5 ~$0.012 -> **Haiku 5.5 ~$0.002**.
Haiku 5.5 is not a pure 10x on Haiku 4.5: it counts ~30% more text tokens
(newer tokenizer) and reads images at the high-resolution tier (up to 2,576 px
long edge / 4,784 visual tokens vs 1,568 / 1,568), so a phone screenshot costs
~2.5x the image tokens. Check the real number in the `💲 scan cost` log line.

**Fallback / rollback is env-only** (Railway variable, no code change):
`CLAUDE_OCR_MODEL=claude-haiku-4-5-20251001` (previous Haiku) or
`CLAUDE_OCR_MODEL=claude-sonnet-4-6` (the pre-2026-10-12 model). If one agent
proves weaker (DATE on Khmer numerals / month names, META on long
transaction ids), override just that agent with `CLAUDE_OCR_MODEL_DATE` /
`_AMOUNT` / `_META`.

**Request shape per model** (`requestOptionsFor` in `claude-ocr.js`):
- `claude-haiku-5-5`: `thinking: {type: "disabled"}`, `output_config.effort: "low"`,
  `max_tokens` 1000. The effort docs (Recommended effort levels for Claude Haiku
  5.5) allow `disabled` at low/medium/high only. Off is cheaper (zero thinking
  tokens; at `low` the model can still think on hard images) and safer (no
  thinking block can eat `max_tokens` before the JSON), and it matches the
  old path, which never thought. `CLAUDE_OCR_THINKING=adaptive` turns thinking
  back on (4000-token ceiling) for an A/B; `CLAUDE_OCR_EFFORT` changes the level
  (at `xhigh`/`max` thinking stays adaptive, since `disabled` is a 400 there).
- Other adaptive-by-default models (Sonnet/Opus 5.x, Fable): effort `low`,
  adaptive thinking, 4000 ceiling (Opus 5.5 rejects `disabled` at every level).
- Haiku 4.5 / Sonnet 4.6: plain request, no thinking, no effort (Haiku 4.5
  rejects it), `max_tokens` 600.
- Never sent on any model: `temperature` / `top_p` / `top_k`, assistant prefill
  (400 on Haiku 5.5). Vision + text only, no tools, no structured outputs.

Haiku 5.5 may write prose around the JSON (more often with thinking off);
`extractJson` takes the outermost object, else the last balanced one that
parses. It also runs safety classifiers: a `refusal` stop reason fails only
that agent, which falls back to its null result. Each agent logs model,
tokens and estimated cost; each scan logs `💲 scan cost`. Tests:
`tests/claude-ocr-model.test.js`.

**Fallback cascade.** PaddleOCR → Tesseract → GPT-4o Vision. Same code as
before. Gated by `GPT_FALLBACK_ENABLED` / `TESSERACT_FALLBACK_ENABLED`.

The merchant identity (account, recipient name, expected amount) is NEVER
hardcoded in either path. It is supplied per request via the `expectedPayment`
field on the verify endpoint, or resolved from the invoice document. The OCR
engine only extracts what is on screen; matching happens downstream in
`verification.js`.

## Key Files

```
src/core/verification.js          - 4-stage verification pipeline + duplicate pre-check
src/core/ocr-engine.js            - OCR routing (Claude 3-agent primary → cascade fallback)
src/core/fraud-detector.js        - Date validation, fraud alert records, severity
src/core/khmer-date.js            - Deterministic Khmer date/number parser

src/services/claude-ocr.js        - Claude 3-agent OCR (DATE / AMOUNT / META, parallel)
src/services/payment-parser.js    - Bank-specific regex extraction + transactionId sanitization
src/services/name-intelligence.js - 7-step name matching (exact → normalize → OCR correct → initial → token → Levenshtein → alias)
src/services/bank-template-matcher.js - Bank template definitions
src/services/paddle-ocr.js        - PaddleOCR client
src/services/tesseract-ocr.js     - Tesseract client
src/services/image-enhancer.js    - Image quality enhancement (skipped on Claude path)

src/routes/verify.js              - POST /api/v1/verify endpoint + E11000 duplicate handler
src/routes/audit.js               - Audit trail endpoints
src/db/mongo.js                   - MongoDB connection, collections, GridFS, indexes
```

## Verification Pipeline (`src/core/verification.js`)

```
Image → OCR Extraction → PRE-CHECK: Duplicate Transaction
    ↓
Stage 1: Bank statement detection (isBankStatement)
Stage 2: Read-quality check (medium proceeds when receiver/date/amount/currency are present)
Stage 3: Security verification
  3a: Receiver-name verification (primary identity; account number is optional evidence)
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

### Read Each Image Once (`src/services/image-dedupe.js`, `src/routes/verify.js`)

Before any OCR call the route hashes the image bytes (sha256 → `imageHash`) and
scopes the hash to merchant + invoice + expected payment (`imageKey`). The same
key within `IMAGE_DEDUPE_WINDOW_HOURS` (default 24, 0 = off) is answered from
the first send's stored response (`responseSnapshot` on the payment record) with
no Claude call and no new payment row. A send arriving while the first is still
running waits for it (in-process map, per instance). Replies are flagged
`duplicate: true`, `duplicateOf: <original record_id>`, `duplicateReason: 'SAME_IMAGE'`.
A verified original is never re-issued as verified (double-credit): the resend
gets `pending` / `DUPLICATE_TRANSACTION` with `verification.originalStatus: 'verified'`.

### E11000 Duplicate Handler (`src/routes/verify.js`)

MongoDB has a unique sparse index on `payments.transactionId`. The insert collides
when the pre-check did not see the original (it skips rejected originals, or two
sends of the same transaction ran at once). The handler looks the original up
(`duplicateTransactionVerdict` in verification.js) and answers with:
- same merchant, original rejected → the original's status, rejectionReason and userMessage
- same merchant, original verified/pending → pending / DUPLICATE_TRANSACTION (same as the pre-check)
- other merchant, or lookup failed (`scope=unknown` in the log) → pending / DUPLICATE_TRANSACTION_OTHER_ACCOUNT, no details
Then re-inserts without transactionId for the audit trail. Response carries
`duplicate: true`, `duplicateReason: 'SAME_TRANSACTION'`, `duplicateOf` (id, same merchant only).

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
payments: { imageKey: 1, uploadedAt: 1 } (partial: imageKey exists)  // Read-once lookup
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

**Receiver-first rule (2026-09-14):** The expected receiver name is mandatory
for automatic verification. A matching receiver can pass when the receipt does
not show a destination account number. An account-number match is recorded as
supporting evidence only and never overrides a wrong or missing receiver.
Transaction date and amount must also pass before the payment is verified.

**Khmer script handling:** Detected by `/[\u1780-\u17FF]/` — preserves structure, only strips zero-width chars (no uppercase, no punctuation removal).

## Khmer Date Parser (`src/core/khmer-date.js`)

Deterministic parsing — no AI translation. See scriptclient CLAUDE.md for full details.

- Khmer digits: U+17E0-U+17E9 → 0-9 (charCode subtraction)
- Month lookup: ~100 entries (full Khmer, short, skeleton, English)
- Position-aware: month name as anchor, day/year by position relative to month

## Environment Variables

```
# OCR Service
OPENAI_API_KEY              - GPT-4o Vision API key (fallback path)
ANTHROPIC_API_KEY           - Claude API key for the 3-agent primary path
CLAUDE_API_KEY              - Accepted as an alias for ANTHROPIC_API_KEY
MONGO_URL                   - MongoDB connection (main DB)
MONGO_SHARE_URL             - MongoDB connection (shared screenshots DB)
DB_NAME                     - Main database name (default: ocrServiceDB)
SHARE_DB_NAME               - Shared database name (default: customerDB)

# OCR Engine — Claude primary (default when ANTHROPIC_API_KEY is set)
OCR_PRIMARY                 - 'claude' (default) | 'cascade' to force legacy path
CLAUDE_OCR_MODEL            - Model id for all 3 agents (default: claude-haiku-5-5; fallback: claude-haiku-4-5-20251001; rollback: claude-sonnet-4-6)
CLAUDE_OCR_MODEL_DATE       - Optional per-agent override (also _AMOUNT, _META); blank = use CLAUDE_OCR_MODEL
CLAUDE_OCR_THINKING         - Haiku 5.5 only: unset = thinking disabled (default); 'adaptive' = let it think
CLAUDE_OCR_EFFORT           - Effort for 5.x models (default: low); ignored on Haiku 4.5 / Sonnet 4.6
CLAUDE_OCR_MAX_TOKENS       - Optional max_tokens override (default: 1000 Haiku 5.5 thinking-off, 4000 adaptive, 600 Haiku 4.5 / Sonnet 4.6)
CLAUDE_OCR_TIMEOUT_MS       - Per-agent timeout (default: 15000)

# OCR Engine — legacy cascade (fallback path)
GPT_FALLBACK_ENABLED        - Enable GPT-4o fallback (default: false)
TESSERACT_FALLBACK_ENABLED  - Enable Tesseract fallback (default: false)
OCR_RATE_LIMIT_PER_MINUTE   - GPT-4o rate limit (default: 10)
OCR_TIMEOUT_MS              - GPT-4o timeout (default: 60000)
TESSERACT_CONFIDENCE_THRESHOLD - Min Tesseract confidence (default: 70)

# Verification Config
PAYMENT_TOLERANCE_PERCENT   - Amount match tolerance (default: 5%)
MAX_SCREENSHOT_AGE_DAYS     - Old screenshot threshold (default: 7)
IMAGE_DEDUPE_WINDOW_HOURS   - Reuse the result for a resent identical image (default: 24, 0 = off)

# Name Intelligence
NAME_MATCH_STRICT_THRESHOLD - Auto-approve threshold (default: 85)
NAME_MATCH_GPT_THRESHOLD    - GPT judgment threshold (default: 70)
MAX_LEVENSHTEIN_DISTANCE    - Max edit distance (default: 2)
ENABLE_OCR_CORRECTION       - OCR error correction (default: true)
ENABLE_INITIAL_MATCHING     - Initial/prefix matching (default: true)
```
