'use strict';

const OpenAI = require('openai');
const fs = require('fs');
const { OpenAIRateLimiter, retryWithBackoff } = require('../utils/rate-limiter');
const { getLearnedPatterns, getImprovedPrompt } = require('../services/pattern-learner');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Rate limiter configuration
const OCR_RATE_LIMIT = parseInt(process.env.OCR_RATE_LIMIT_PER_MINUTE) || 10;
const rateLimiter = new OpenAIRateLimiter(OCR_RATE_LIMIT);

/**
 * OCR Prompt for GPT-4o Vision
 */
const OCR_PROMPT = `You are a BANK STATEMENT VERIFICATION OCR system for Cambodian banks.

STEP 1: IDENTIFY IMAGE TYPE
First, determine if this image is from a BANKING APP at all.

Set isBankStatement=FALSE if:
- This is a chat screenshot (Telegram, WhatsApp, Messenger, LINE, etc.)
- This is an invoice, bill, receipt, or QR code (NOT payment confirmation)
- This is a random photo, meme, selfie, or non-banking image
- This is text/numbers without a banking app interface
- You cannot identify any banking app UI elements

Set isBankStatement=TRUE if:
- This shows a banking app interface (ABA Bank, Wing, ACLEDA, Canadia, Prince Bank, Sathapana)
- Even if blurry, cropped, or partially visible - if it's clearly FROM a bank app

STEP 2: VERIFY PAYMENT (only if isBankStatement=TRUE)
If this IS a bank statement, determine if it's a valid payment proof:

Set isPaid=TRUE if this is a COMPLETED TRANSFER. Look for:

ABA Bank format (IMPORTANT - no "Success" text!):
- CT logo with minus amount (e.g., "-28,000 KHR" or "-6.99 USD")
- Shows "Trx. ID:", "To account:", "From account:"
- Minus sign = money was sent = completed transfer
- Has Transaction ID and Reference number

ACLEDA/Wing format:
- Shows "រួចរាល់" (completed) or checkmark ✓
- Green success screen with amount

Other banks:
- "Success", "Completed", "ជោគជ័យ" text
- Checkmark or green confirmation

A transfer IS PAID if you can see:
1. Amount (even with minus sign like -28,000)
2. Transaction ID or Reference number
3. Recipient info (account number OR name like "CHAN K. & THOEURN T.")

Set isPaid=FALSE but keep isBankStatement=TRUE if:
- Image is too blurry to read
- Image is cropped/partial - missing key fields
- Shows "Pending", "Failed", or "Processing" status

STEP 3: EXTRACT PAYMENT DATA (only if isPaid=TRUE)
Extract ALL fields carefully:
- toAccount: The recipient account number (CRITICAL for security)
- amount: The transfer amount (use POSITIVE number, ignore minus sign)
- transactionId: The Trx. ID or Transaction ID
- transactionDate: Extract date/time. Convert to ISO format (2026-01-04T13:35:00) if possible. If the date is in Khmer script with Khmer numerals or month names, extract as-is - our parser handles Khmer dates.

Return JSON format:
{
  "isBankStatement": true/false,
  "isPaid": true/false,
  "amount": number (POSITIVE, e.g., 28000 not -28000),
  "currency": "KHR" or "USD",
  "transactionId": "string",
  "referenceNumber": "string",
  "fromAccount": "string (sender account/name)",
  "toAccount": "string (recipient account number)",
  "bankName": "string",
  "transactionDate": "string (ISO format preferred, or Khmer format if visible)",
  "remark": "string",
  "recipientName": "string",
  "confidence": "high/medium/low"
}

RULES:
1. isBankStatement is about IMAGE TYPE (is it from a bank app?)
2. isPaid is about PAYMENT VALIDITY (can we verify the transfer?)
3. Random photo → isBankStatement=false, isPaid=false, confidence=low
4. Blurry bank statement → isBankStatement=true, isPaid=false, confidence=low
5. Clear bank statement → isBankStatement=true, isPaid=true, confidence=high/medium
6. Amount MUST be positive (if shows -28,000 KHR, return 28000)`;

/**
 * Analyzes payment screenshot using GPT-4o Vision with learned patterns
 * @param {string|Buffer} imageInput - Image path or buffer
 * @param {Object} options - Analysis options including learned patterns
 * @returns {Promise<object>} - OCR result
 */
async function analyzePaymentScreenshot(imageInput, options = {}) {
  const openaiTimeout = parseInt(process.env.OCR_TIMEOUT_MS) || 60000;

  // Get base64 image
  let base64Image;
  if (Buffer.isBuffer(imageInput)) {
    base64Image = imageInput.toString('base64');
  } else if (typeof imageInput === 'string') {
    const imageBuffer = await fs.promises.readFile(imageInput);
    base64Image = imageBuffer.toString('base64');
  } else {
    throw new Error('Invalid image input: must be Buffer or file path');
  }

  // Get learned patterns and improved prompts
  const learnedPatterns = await getLearnedPatterns(options.expectedBank);
  const improvedPrompt = await getImprovedPrompt(OCR_PROMPT, learnedPatterns);

  console.log(`🧠 Using learned patterns | Bank: ${options.expectedBank || 'unknown'} | Patterns: ${learnedPatterns.patterns_count || 0}`);

  const response = await retryWithBackoff(async () => {
    // Wait for rate limiter slot
    await rateLimiter.waitForSlot();

    console.log('Calling GPT-4o Vision API for Bank Statement OCR with learned patterns...');

    return await Promise.race([
      openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: improvedPrompt
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ]
          }
        ],
        max_tokens: 1500
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('OpenAI API timeout')), openaiTimeout)
      )
    ]);
  });

  console.log('OCR completed successfully');

  const aiResponse = response.choices[0].message.content;

  // Parse JSON response
  let paymentData;
  try {
    // Extract JSON from response (GPT might wrap it in markdown code blocks)
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      paymentData = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('No JSON found in response');
    }
  } catch (parseError) {
    console.error('Failed to parse AI response as JSON:', parseError.message);
    paymentData = {
      isBankStatement: false,
      isPaid: false,
      confidence: 'low',
      rawResponse: aiResponse
    };
  }

  return paymentData;
}

/**
 * Get rate limiter status
 * @returns {object} - Rate limiter status
 */
function getRateLimiterStatus() {
  return rateLimiter.getStatus();
}

module.exports = {
  analyzePaymentScreenshot,
  getRateLimiterStatus,
  OCR_PROMPT
};
