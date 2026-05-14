'use strict';

/**
 * Claude-based OCR for Cambodian bank screenshots.
 *
 * Design: 3 specialized agents run in parallel, each with a focused prompt.
 *   Agent A — date (verbatim transcription, Khmer-safe)
 *   Agent B — amount + currency (no math, no conversion)
 *   Agent C — classification + transactionId + recipient + bank
 *
 * Returns the same paymentData shape the GPT-4o path produces. Downstream
 * verification (Khmer date parsing, amount/recipient matching against
 * per-request expectedPayment, transactionId sanitization, duplicate
 * detection) is unchanged.
 *
 * No merchant-specific values are baked into the prompts. Expected
 * recipient/account/amount live on the invoice or the API request and are
 * applied in verification.js — this module only EXTRACTS what is on screen.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_OCR_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 600;
const TIMEOUT_MS = parseInt(process.env.CLAUDE_OCR_TIMEOUT_MS, 10) || 15000;

let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error('Neither ANTHROPIC_API_KEY nor CLAUDE_API_KEY is set');
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

function isAvailable() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
}

// ── Prompts ─────────────────────────────────────────────────────────
//
// Generic by design: every example is a format placeholder, not a real
// merchant value. ocr-service is multi-tenant — the merchant identity comes
// from invoice.expectedPayment, not from anything baked here.

const PROMPT_DATE = `You are extracting ONE field from a Cambodian bank screenshot.

TASK: Find the transaction date/time field. In Khmer screenshots it is usually labeled "កាលបរិច្ឆេទ". In English it may be labeled "Date" or "Date & Time".

Return the date/time text VERBATIM — exactly as it appears on screen.

RULES:
- COPY characters exactly. If the screen shows Khmer script (e.g. "ឧសភា", "ខែ"), output Khmer script.
- If the screen shows Khmer digits (e.g. "១២", "២០២៦"), output Khmer digits — do NOT convert to Arabic.
- DO NOT translate Khmer month names to English.
- DO NOT reformat. The Khmer-style "DD <month> YYYY | HH:MM <marker>" pattern stays as-is.
- Include the time marker if visible (ល្ងាច = PM, ព្រឹក = AM, AM/PM).
- DO NOT extract the screenshot upload time or notification time — only the date INSIDE the receipt body.
- If no transaction date is visible inside the receipt, return null.

Output JSON only:
{"dateRaw": "string or null"}`;

const PROMPT_AMOUNT = `You are extracting amount fields from a Cambodian bank screenshot.

TASK: Find the LARGE/HEADER transfer amount and its currency.

RULES:
- Read the MAIN amount — the largest, most prominent number on screen (usually colored/highlighted near the top).
- Return the NUMBER displayed, without commas. "26,000 ៛" → 26000. "1,200,000" → 1200000.
- "៛" or "រៀល" → currency "KHR".
- "$" or "ដុល្លារ" or "USD" → currency "USD".
- If BOTH USD and KHR are shown, use the KHR amount (it is the actual Cambodian transfer value).
- NEVER multiply, divide, or convert between currencies. NEVER calculate from an exchange rate.
- If the amount has a minus sign (e.g. "-26,000 KHR" on ABA), return the POSITIVE value: 26000.
- If you cannot find a clear amount, return null for amount.

Output JSON only:
{"amount": number or null, "currency": "KHR" or "USD" or null}`;

const PROMPT_META = `You are extracting reference and identity fields from a Cambodian bank screenshot.

TASK 1 — CLASSIFY:
- isBankStatement: true if this image is from a Cambodian bank app UI (ABA, ACLEDA, Wing, Canadia, Prince, Sathapana, KHQR, Bakong). False if it's a chat screenshot, photo, invoice, QR code, or unrelated image.
- isPaid: true if this is a COMPLETED transfer (success screen, ABA "-amount KHR", ACLEDA checkmark/"រួចរាល់", "ជោគជ័យ", or any clear completion signal). False if pending, failed, blurry, or cropped beyond use.
- confidence: "high" | "medium" | "low".

TASK 2 — EXTRACT IDENTIFIERS (read whatever is on screen — do NOT guess and do NOT assume any particular merchant):
- transactionId: the unique reference for THIS transfer.
  * MUST come from a labeled field. Look for labels like "Trx. ID", "Transaction ID", "TXN ID", "Reference", "Reference number", "លេខយោង".
  * Real transaction IDs are LONG alphanumeric strings (15+ chars) OR contain letters (e.g. a string starting with "FT" followed by digits, or a hex-like string).
  * NEVER use account numbers, phone numbers, or short pure-digit strings (8-13 pure digits is ALWAYS an account/phone, never a transaction ID).
  * If no clearly labeled reference is visible, return null. Do NOT fabricate.
- toAccount: the recipient's account number (often masked, e.g. digits with "***" in the middle, or a full digit string). Read it as displayed.
- recipientName: the recipient display name AS PRINTED on screen. May be Latin script with initials and "&" between two names, or Khmer script. Copy verbatim.
- bankName: the bank app shown ("ABA", "ACLEDA", "Wing", "Canadia", "Prince", "Sathapana", "KHQR", "Bakong", or "unknown"). Use the short name only.

Output JSON only:
{
  "isBankStatement": boolean,
  "isPaid": boolean,
  "confidence": "high" | "medium" | "low",
  "transactionId": "string or null",
  "toAccount": "string or null",
  "recipientName": "string or null",
  "bankName": "string or null"
}`;

// ── Single agent call ───────────────────────────────────────────────

async function callAgent(label, prompt, base64Image, mediaType) {
  const client = getClient();
  const started = Date.now();

  const response = await Promise.race([
    client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
            { type: 'text', text: prompt }
          ]
        }
      ]
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Claude timeout (${label})`)), TIMEOUT_MS)
    )
  ]);

  const elapsed = Date.now() - started;
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`[OCR-CLAUDE/${label}] no JSON in response: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(jsonMatch[0]);
  console.log(`✅ [OCR-CLAUDE/${label}] ${elapsed}ms ${JSON.stringify(parsed)}`);
  return parsed;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Extracts payment data from a bank screenshot using 3 parallel Claude agents.
 * Accepts either a Buffer or a base64 string. ocr-engine.js works in Buffers;
 * route handlers may already have base64 — both are handled.
 *
 * @param {Buffer|string} imageInput - Image bytes or base64-encoded string (no data: prefix)
 * @param {object} [options]
 * @param {string} [options.mediaType] - "image/jpeg" or "image/png" (default "image/jpeg")
 * @returns {Promise<object>} - paymentData in the shape downstream expects
 */
async function extractWithClaude(imageInput, options = {}) {
  const mediaType = options.mediaType || 'image/jpeg';

  let base64Image;
  if (Buffer.isBuffer(imageInput)) {
    base64Image = imageInput.toString('base64');
  } else if (typeof imageInput === 'string') {
    base64Image = imageInput;
  } else {
    throw new Error('extractWithClaude: imageInput must be Buffer or base64 string');
  }

  console.log(`🔍 [OCR-CLAUDE] Dispatching 3 agents (model=${MODEL})`);
  const started = Date.now();

  const [dateResult, amountResult, metaResult] = await Promise.all([
    callAgent('DATE', PROMPT_DATE, base64Image, mediaType).catch(err => {
      console.error(`❌ [OCR-CLAUDE/DATE] ${err.message}`);
      return { dateRaw: null };
    }),
    callAgent('AMOUNT', PROMPT_AMOUNT, base64Image, mediaType).catch(err => {
      console.error(`❌ [OCR-CLAUDE/AMOUNT] ${err.message}`);
      return { amount: null, currency: null };
    }),
    callAgent('META', PROMPT_META, base64Image, mediaType).catch(err => {
      console.error(`❌ [OCR-CLAUDE/META] ${err.message}`);
      return {
        isBankStatement: false,
        isPaid: false,
        confidence: 'low',
        transactionId: null,
        toAccount: null,
        recipientName: null,
        bankName: null
      };
    })
  ]);

  const elapsed = Date.now() - started;

  const paymentData = {
    isBankStatement: metaResult.isBankStatement === true,
    isPaid: metaResult.isPaid === true,
    confidence: metaResult.confidence || 'low',
    amount: typeof amountResult.amount === 'number' ? amountResult.amount : null,
    currency: amountResult.currency || null,
    transactionId: metaResult.transactionId || null,
    referenceNumber: null,
    fromAccount: null,
    toAccount: metaResult.toAccount || null,
    bankName: metaResult.bankName || null,
    dateRaw: dateResult.dateRaw || null,
    remark: null,
    recipientName: metaResult.recipientName || null,
    _claudeElapsedMs: elapsed
  };

  console.log(`✅ [OCR-CLAUDE] Done in ${elapsed}ms — isPaid=${paymentData.isPaid} amount=${paymentData.amount} ${paymentData.currency} dateRaw="${paymentData.dateRaw}" trxId="${paymentData.transactionId}"`);
  return paymentData;
}

module.exports = {
  extractWithClaude,
  isAvailable,
  // exported for testing
  _internals: { callAgent, PROMPT_DATE, PROMPT_AMOUNT, PROMPT_META, MODEL }
};
