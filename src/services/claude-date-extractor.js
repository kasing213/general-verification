'use strict';

/**
 * Claude Haiku Date Extractor
 *
 * Single-purpose service: extract ONLY the raw date/time text from a bank
 * statement screenshot using Claude Haiku 4.5 (vision). The raw text is then
 * fed into khmer-date.js's deterministic parser — no AI translation step.
 *
 * Mirrors scriptclient's [CLAUDE-OCR] flow: model returns raw date text →
 * khmer-date.js parses it. Khmer numerals/months are notoriously misread by
 * generalist OCR; isolating this one field to a focused model is reliable.
 *
 * Skips silently if ANTHROPIC_API_KEY is not set, so the rest of the OCR
 * pipeline continues to function.
 */

let Anthropic;
try {
  ({ Anthropic } = require('@anthropic-ai/sdk'));
} catch (err) {
  Anthropic = null;
}

let client = null;
function getClient() {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!Anthropic || !key) return null;
  client = new Anthropic({ apiKey: key });
  return client;
}

const HAIKU_MODEL = process.env.HAIKU_DATE_MODEL || 'claude-haiku-4-5-20251001';
const HAIKU_TIMEOUT_MS = parseInt(process.env.HAIKU_TIMEOUT_MS) || 15000;

const DATE_PROMPT = `You are extracting ONLY the transaction date/time text from a bank statement screenshot.

Look at the image and find the date/time of the transaction (NOT today's date, NOT a printed footer date — the transaction date shown on the receipt).

Return ONLY the raw text exactly as it appears on the screen. Examples of valid responses:
- "Apr 03, 2026 04:05 PM"
- "03/04/2026 16:05"
- "៣ មេសា ២០២៦ ១៦:០៥"
- "2026-04-03 16:05:00"

Do NOT translate, reformat, or interpret. If you cannot find a date in the image, respond with exactly "NONE".

Do NOT add any commentary, JSON, quotes, or explanation. Just the raw date text on a single line.`;

/**
 * Extract raw date text from a bank statement image using Claude Haiku.
 * @param {Buffer} imageBuffer - Image bytes (jpg/png)
 * @returns {Promise<string|null>} - Raw date text or null if unavailable / not found
 */
async function extractDateText(imageBuffer) {
  const c = getClient();
  if (!c) return null;
  if (!Buffer.isBuffer(imageBuffer)) return null;

  const base64Image = imageBuffer.toString('base64');

  console.log('[CLAUDE-OCR] Extracting raw date text with Claude Haiku...');

  try {
    const response = await Promise.race([
      c.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
            { type: 'text', text: DATE_PROMPT }
          ]
        }]
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Haiku date timeout')), HAIKU_TIMEOUT_MS)
      )
    ]);

    const raw = (response.content?.[0]?.text || '').trim();
    console.log(`[CLAUDE-OCR] Raw response: ${raw}`);

    if (!raw || raw.toUpperCase() === 'NONE') return null;
    return raw;
  } catch (err) {
    console.warn(`[CLAUDE-OCR] Haiku date extraction failed: ${err.message}`);
    return null;
  }
}

function isAvailable() {
  return getClient() !== null;
}

module.exports = {
  extractDateText,
  isAvailable
};
