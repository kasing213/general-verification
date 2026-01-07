# OCR Verification Service API

REST API for payment screenshot verification using GPT-4o Vision.

## Base URL

```
http://localhost:3000
```

## Authentication

All protected endpoints require `X-API-Key` header:

```
X-API-Key: your-api-key
```

---

## Health & Status

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-01-07T10:30:00.000Z",
  "uptime": 3600,
  "service": "ocr-verification-service"
}
```

### GET /status

Detailed system status.

**Response:**
```json
{
  "service": {
    "name": "OCR Verification Service",
    "version": "1.0.0",
    "status": "running"
  },
  "ocr": {
    "model": "gpt-4o",
    "rateLimiter": {
      "currentRequests": 2,
      "maxRequests": 10,
      "available": 8
    }
  },
  "system": {
    "uptime": 3600,
    "memory": {
      "heapUsed": "50 MB",
      "heapTotal": "100 MB",
      "rss": "120 MB"
    }
  },
  "timestamp": "2026-01-07T10:30:00.000Z"
}
```

---

## Payment Verification

### POST /api/v1/verify

Verify a payment screenshot.

**Headers:**
```
X-API-Key: your-api-key
Content-Type: multipart/form-data
```

**Request Body (multipart/form-data):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| image | File | Yes | Payment screenshot (JPEG, PNG, WebP, GIF) |
| expectedPayment | JSON string | No | Expected payment details |
| invoice_id | String | No | Invoice ID to lookup expectations |
| customer_id | String | No | Customer reference |

#### Mode A: Inline Parameters

Pass `expectedPayment` directly in the request:

```json
{
  "expectedPayment": {
    "amount": 28000,
    "currency": "KHR",
    "bank": null,
    "toAccount": null,
    "recipientNames": null,
    "tolerancePercent": 5
  },
  "customer_id": "C123"
}
```

**Verification behavior when fields are null:**

| Field | Value | Behavior |
|-------|-------|----------|
| `amount` | 28000 | **REQUIRED** - always verified |
| `currency` | "KHR" | Convert to KHR for comparison |
| `bank` | null | Skip bank name check |
| `toAccount` | null | Skip account check |
| `recipientNames` | null | Skip name check |
| `toAccount` | "086228226" | Verify account matches |
| `recipientNames` | ["chan k", "thoeurn t"] | Verify name contains any |

#### Mode B: Invoice Lookup

Pass `invoice_id` to lookup expectations from database:

```json
{
  "invoice_id": "INV-2026-001"
}
```

#### cURL Example

```bash
# Mode A: Inline parameters
curl -X POST http://localhost:3000/api/v1/verify \
  -H "X-API-Key: your-api-key" \
  -F "image=@payment.jpg" \
  -F 'expectedPayment={"amount":28000,"currency":"KHR"}'

# Mode B: Invoice lookup
curl -X POST http://localhost:3000/api/v1/verify \
  -H "X-API-Key: your-api-key" \
  -F "image=@payment.jpg" \
  -F "invoice_id=INV-2026-001"

# Minimal (OCR only, no verification)
curl -X POST http://localhost:3000/api/v1/verify \
  -H "X-API-Key: your-api-key" \
  -F "image=@payment.jpg"
```

**Response:**

```json
{
  "success": true,
  "recordId": "550e8400-e29b-41d4-a716-446655440000",
  "invoiceId": "INV-2026-001",

  "verification": {
    "status": "verified",
    "paymentLabel": "PAID",
    "confidence": "high",
    "rejectionReason": null
  },

  "payment": {
    "amount": 28000,
    "currency": "KHR",
    "transactionId": "47062628112",
    "transactionDate": "2026-01-06T10:30:00",
    "fromAccount": "MEY THIDA",
    "toAccount": "086 228 226",
    "recipientName": "CHAN K. & THOEURN T.",
    "bankName": "ABA Bank",
    "referenceNumber": "100FT36424434346",
    "remark": "H228",
    "isBankStatement": true,
    "isPaid": true
  },

  "validation": {
    "amount": {
      "expected": 28000,
      "actual": 28000,
      "match": true,
      "skipped": false
    },
    "bank": {
      "expected": null,
      "actual": "ABA Bank",
      "match": null,
      "skipped": true
    },
    "toAccount": {
      "expected": null,
      "actual": "086 228 226",
      "match": null,
      "skipped": true
    },
    "recipientNames": {
      "expected": null,
      "actual": "CHAN K. & THOEURN T.",
      "match": null,
      "skipped": true
    },
    "isOldScreenshot": false,
    "dateValidation": {
      "isValid": true,
      "fraudType": null,
      "ageDays": 1,
      "parsedDate": "2026-01-06T10:30:00.000Z",
      "reason": null
    }
  },

  "fraud": null,
  "screenshotPath": "./uploads/verified/550e8400-e29b-41d4-a716-446655440000.jpg"
}
```

### Verification Statuses

| Status | paymentLabel | Description |
|--------|--------------|-------------|
| `verified` | PAID | All checks passed |
| `pending` | PENDING | Needs manual review (blurry, amount mismatch) |
| `rejected` | UNPAID | Failed verification (wrong recipient, old screenshot) |

### Rejection Reasons

| Code | Description | Response |
|------|-------------|----------|
| `NOT_BANK_STATEMENT` | Image is not from banking app | Silent reject |
| `BLURRY` | Image unclear/low confidence | Pending |
| `WRONG_RECIPIENT` | Payment to wrong account | Rejected |
| `OLD_SCREENSHOT` | Screenshot > 7 days old | Rejected + fraud alert |
| `FUTURE_DATE` | Transaction date in future | Rejected + fraud alert |
| `INVALID_DATE` | Cannot parse date | Rejected |
| `MISSING_DATE` | No date found | Rejected |
| `AMOUNT_MISMATCH` | Amount doesn't match expected | Pending |

### GET /api/v1/verify/:id

Get verification result by record ID.

**Response:**
```json
{
  "success": true,
  "recordId": "550e8400-e29b-41d4-a716-446655440000",
  "invoiceId": "INV-2026-001",
  "verification": {
    "status": "verified",
    "paymentLabel": "PAID",
    "confidence": "high",
    "rejectionReason": null
  },
  "payment": {
    "amount": 28000,
    "currency": "KHR",
    "transactionId": "47062628112",
    "bankName": "ABA Bank"
  },
  "uploadedAt": "2026-01-07T10:30:00.000Z"
}
```

---

## Invoice Management

### POST /api/v1/invoices

Create new invoice.

**Request Body:**
```json
{
  "customer_id": "C123",
  "expectedPayment": {
    "amount": 28000,
    "currency": "KHR",
    "bank": "ABA Bank",
    "toAccount": "086228226",
    "recipientNames": ["chan k", "thoeurn t"],
    "tolerancePercent": 5
  },
  "expires_at": "2026-01-14T00:00:00.000Z",
  "metadata": {
    "order_id": "ORD-001"
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Invoice created",
  "invoice": {
    "_id": "INV-2026-A1B2C3D4",
    "customer_id": "C123",
    "expectedPayment": {
      "amount": 28000,
      "currency": "KHR",
      "bank": "ABA Bank",
      "toAccount": "086228226",
      "recipientNames": ["chan k", "thoeurn t"],
      "tolerancePercent": 5
    },
    "status": "pending",
    "created_at": "2026-01-07T10:30:00.000Z",
    "expires_at": "2026-01-14T00:00:00.000Z",
    "verified_at": null,
    "payment_id": null,
    "metadata": {
      "order_id": "ORD-001"
    }
  }
}
```

### GET /api/v1/invoices/:id

Get invoice by ID.

**Response:**
```json
{
  "success": true,
  "invoice": { ... },
  "payments": [ ... ]
}
```

### PUT /api/v1/invoices/:id

Update invoice.

**Request Body:**
```json
{
  "expectedPayment": {
    "amount": 30000
  },
  "status": "pending"
}
```

### GET /api/v1/invoices

List invoices with filters.

**Query Parameters:**

| Name | Type | Description |
|------|------|-------------|
| status | string | Filter by status: `pending`, `verified`, `expired`, `cancelled` |
| customer_id | string | Filter by customer ID |
| limit | number | Max results (default: 100) |
| skip | number | Offset for pagination |

**Response:**
```json
{
  "success": true,
  "count": 25,
  "invoices": [ ... ]
}
```

### DELETE /api/v1/invoices/:id

Cancel invoice (soft delete).

**Response:**
```json
{
  "success": true,
  "message": "Invoice INV-2026-001 cancelled"
}
```

---

## Error Responses

All errors return:

```json
{
  "success": false,
  "error": "Error type",
  "message": "Detailed error message"
}
```

**HTTP Status Codes:**

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Invalid or missing API key |
| 404 | Not Found - Resource doesn't exist |
| 500 | Internal Server Error |

---

## Integration Example

### JavaScript/Node.js

```javascript
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const API_URL = 'http://localhost:3000';
const API_KEY = 'your-api-key';

// Create invoice
async function createInvoice(customerId, amount) {
  const response = await axios.post(`${API_URL}/api/v1/invoices`, {
    customer_id: customerId,
    expectedPayment: {
      amount,
      currency: 'KHR',
      toAccount: '086228226',
      recipientNames: ['chan k', 'thoeurn t']
    }
  }, {
    headers: { 'X-API-Key': API_KEY }
  });
  return response.data.invoice;
}

// Verify payment
async function verifyPayment(imagePath, invoiceId) {
  const form = new FormData();
  form.append('image', fs.createReadStream(imagePath));
  form.append('invoice_id', invoiceId);

  const response = await axios.post(`${API_URL}/api/v1/verify`, form, {
    headers: {
      'X-API-Key': API_KEY,
      ...form.getHeaders()
    }
  });
  return response.data;
}

// Usage
const invoice = await createInvoice('C123', 28000);
const result = await verifyPayment('./payment.jpg', invoice._id);

if (result.verification.status === 'verified') {
  console.log('Payment verified!');
} else {
  console.log(`Status: ${result.verification.status}`);
  console.log(`Reason: ${result.verification.rejectionReason}`);
}
```

### Python

```python
import requests

API_URL = 'http://localhost:3000'
API_KEY = 'your-api-key'
HEADERS = {'X-API-Key': API_KEY}

# Create invoice
def create_invoice(customer_id, amount):
    response = requests.post(
        f'{API_URL}/api/v1/invoices',
        headers=HEADERS,
        json={
            'customer_id': customer_id,
            'expectedPayment': {
                'amount': amount,
                'currency': 'KHR'
            }
        }
    )
    return response.json()['invoice']

# Verify payment
def verify_payment(image_path, invoice_id):
    with open(image_path, 'rb') as f:
        response = requests.post(
            f'{API_URL}/api/v1/verify',
            headers=HEADERS,
            files={'image': f},
            data={'invoice_id': invoice_id}
        )
    return response.json()

# Usage
invoice = create_invoice('C123', 28000)
result = verify_payment('./payment.jpg', invoice['_id'])

if result['verification']['status'] == 'verified':
    print('Payment verified!')
else:
    print(f"Status: {result['verification']['status']}")
    print(f"Reason: {result['verification']['rejectionReason']}")
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEY` | Yes | - | API authentication key |
| `OPENAI_API_KEY` | Yes | - | OpenAI API key for GPT-4o |
| `MONGO_URL` | Yes | - | MongoDB connection string |
| `DB_NAME` | No | ocrServiceDB | Database name |
| `PORT` | No | 3000 | Server port |
| `OCR_TIMEOUT_MS` | No | 60000 | OCR timeout in ms |
| `OCR_MAX_RETRIES` | No | 3 | Max OCR retries |
| `OCR_RATE_LIMIT_PER_MINUTE` | No | 10 | OpenAI rate limit |
| `PAYMENT_TOLERANCE_PERCENT` | No | 5 | Amount tolerance % |
| `MAX_SCREENSHOT_AGE_DAYS` | No | 7 | Max screenshot age |
| `USD_TO_KHR_RATE` | No | 4000 | USD to KHR rate |
