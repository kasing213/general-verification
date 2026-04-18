'use strict';

const OpenAI = require('openai');
const fs = require('fs');
const { OpenAIRateLimiter, retryWithBackoff } = require('../utils/rate-limiter');
const { getLearnedPatterns, getImprovedPrompt } = require('../services/pattern-learner');
const PaddleOCRService = require('../services/paddle-ocr');
const PaymentDataParser = require('../services/payment-parser');
const ImageEnhancerService = require('../services/image-enhancer');
const MultiOCROrchestrator = require('../services/multi-ocr-orchestrator');
const claudeDateExtractor = require('../services/claude-date-extractor');
const BankTemplateMatcher = require('../services/bank-template-matcher');

// Initialize services
let openai = null;
try {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-test-dummy-key-for-tesseract-testing') {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }
} catch (error) {
  console.warn('⚠️ OpenAI client initialization skipped:', error.message);
}

const paddleOCR = new PaddleOCRService();
const paymentParser = new PaymentDataParser();
const imageEnhancer = new ImageEnhancerService();
const multiOCROrchestrator = new MultiOCROrchestrator();
const bankTemplateMatcher = new BankTemplateMatcher();

const BANK_CODE_TO_NAME = {
  ABA: 'ABA Bank',
  ACLEDA: 'ACLEDA',
  Wing: 'Wing',
};

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
- transactionId: The unique transaction/receipt reference ID (NOT the account/phone number).
  * Transaction IDs are ALWAYS long alphanumeric strings (UTR/UETR/bank refs, typically 15+ chars)
  * Account numbers and phone numbers (8-13 pure digits) are NEVER transaction IDs
  * ABA: labeled "Trx. ID:" — use that exact field
  * Wing: the LONG alphanumeric number (15+ chars), NOT the 8-10 digit phone/account number
  * ACLEDA: labeled "Transaction ID" or "TXN ID"
  * Canadia/Prince/Sathapana: look for "Reference", "Transaction ID", or similar labeled field
  * If you cannot find a clearly labeled transaction/reference ID, return null
  * NEVER use an account number, phone number, or short numeric string as transactionId
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
  "confidence": "high/medium/low",
  "rawText": "string — ALL visible text from the screenshot, preserving line breaks with \\n. This enables a second-pass bank-specific extractor to verify your fields."
}

RULES:
1. isBankStatement is about IMAGE TYPE (is it from a bank app?)
2. isPaid is about PAYMENT VALIDITY (can we verify the transfer?)
3. Random photo → isBankStatement=false, isPaid=false, confidence=low
4. Blurry bank statement → isBankStatement=true, isPaid=false, confidence=low
5. Clear bank statement → isBankStatement=true, isPaid=true, confidence=high/medium
6. Amount MUST be positive (if shows -28,000 KHR, return 28000)`;

/**
 * Analyzes payment screenshot using intelligent OCR routing
 * Tries PaddleOCR first, falls back to GPT-4o for complex cases
 * @param {string|Buffer} imageInput - Image path or buffer
 * @param {Object} options - Analysis options including learned patterns
 * @returns {Promise<object>} - OCR result
 */
async function analyzePaymentScreenshot(imageInput, options = {}) {
  const startTime = Date.now();

  // Prepare image buffer
  let imageBuffer;
  if (Buffer.isBuffer(imageInput)) {
    imageBuffer = imageInput;
  } else if (typeof imageInput === 'string') {
    imageBuffer = await fs.promises.readFile(imageInput);
  } else {
    throw new Error('Invalid image input: must be Buffer or file path');
  }

  console.log(`🔍 Starting intelligent OCR analysis | Bank: ${options.expectedBank || 'unknown'}`);

  // Step 1: Apply image enhancement for better OCR accuracy
  let enhancedImageBuffer = imageBuffer;
  let enhancementResult = null;

  try {
    enhancementResult = await imageEnhancer.enhanceImage(imageBuffer, {
      forceEnhancement: options.forceEnhancement || false,
      expectedBank: options.expectedBank
    });

    if (enhancementResult.enhanced) {
      enhancedImageBuffer = enhancementResult.enhancedBuffer;
      console.log(`🎨 Image enhanced | Quality: ${enhancementResult.qualityAnalysis.overallScore}/100 | Enhancements: ${enhancementResult.enhancementsApplied.join(', ')}`);
    } else {
      console.log(`📸 Skipped enhancement | Quality: ${enhancementResult.qualityAnalysis?.overallScore || 'unknown'}/100`);
    }
  } catch (error) {
    console.warn('⚠️ Image enhancement failed, using original:', error.message);
  }

  // Step 1.5: Pre-detect bank from image template (color/logo) before OCR
  // Bank hint flows downstream to PaddleOCR/GPT-4o prompts and to the parser.
  // Never overrides a merchant-supplied expectedBank.
  try {
    const tpl = await bankTemplateMatcher.detectBankType(enhancedImageBuffer);
    if (tpl && tpl.bank && tpl.confidence >= 0.6) {
      const fullName = BANK_CODE_TO_NAME[tpl.bank] || tpl.bank;
      if (!options.expectedBank) {
        options.expectedBank = fullName;
      }
      console.log(`🏦 Bank pre-detected from template: ${fullName} (conf: ${tpl.confidence.toFixed(2)})`);
    } else {
      console.log(`🏦 Bank template detection weak (bank: ${tpl?.bank || 'none'}, conf: ${(tpl?.confidence || 0).toFixed(2)}) — relying on text extraction`);
    }
  } catch (err) {
    console.warn(`⚠️ Bank template pre-detection failed: ${err.message} — continuing without hint`);
  }

  // Step 2: Try PaddleOCR first
  const paddleResult = await tryPaddleOCR(enhancedImageBuffer, options);

  // Check configuration for fallback options
  const gptFallbackEnabled = process.env.GPT_FALLBACK_ENABLED === 'true';
  const tesseractFallbackEnabled = process.env.TESSERACT_FALLBACK_ENABLED === 'true';

  // Use PaddleOCR result if it's good enough
  if (paddleResult && shouldUsePaddleResult(paddleResult)) {
    // Add enhancement metadata to PaddleOCR result
    paddleResult.imageEnhancement = {
      enhanced: enhancementResult?.enhanced || false,
      qualityScore: enhancementResult?.qualityAnalysis?.overallScore,
      enhancementsApplied: enhancementResult?.enhancementsApplied || [],
      processingTime: enhancementResult?.processingTime || 0
    };

    console.log(`✅ PaddleOCR success | Time: ${Date.now() - startTime}ms | Confidence: ${paddleResult.confidence}`);
    return paddleResult;
  }

  // If no fallbacks enabled, force PaddleOCR result
  if (!gptFallbackEnabled && !tesseractFallbackEnabled) {
    console.log(`🔧 All fallbacks DISABLED - using PaddleOCR result regardless of quality`);

    if (paddleResult && !paddleResult.fallbackReason) {
      // Success case - add enhancement metadata
      paddleResult.imageEnhancement = {
        enhanced: enhancementResult?.enhanced || false,
        qualityScore: enhancementResult?.qualityAnalysis?.overallScore,
        enhancementsApplied: enhancementResult?.enhancementsApplied || [],
        processingTime: enhancementResult?.processingTime || 0
      };

      console.log(`✅ PaddleOCR success (forced) | Time: ${Date.now() - startTime}ms | Confidence: ${paddleResult.confidence}`);
      return paddleResult;
    } else {
      // PaddleOCR failed - return error but still use PaddleOCR format
      console.log(`❌ PaddleOCR failed | Reason: ${paddleResult?.fallbackReason || 'Service unavailable'}`);

      const failedResult = {
        success: false,
        isBankStatement: false,
        isPaid: false,
        confidence: 'low',
        error: `PaddleOCR failed: ${paddleResult?.fallbackReason || 'Service unavailable'}`,
        ocrEngine: 'PaddleOCR',
        processingTime: Date.now() - startTime,
        imageEnhancement: {
          enhanced: enhancementResult?.enhanced || false,
          qualityScore: enhancementResult?.qualityAnalysis?.overallScore,
          enhancementsApplied: enhancementResult?.enhancementsApplied || [],
          processingTime: enhancementResult?.processingTime || 0
        },
        ocrText: paddleResult?.ocrText || '',
        debugInfo: {
          paddleResult: paddleResult,
          allFallbacksDisabled: true
        }
      };

      return failedResult;
    }
  }

  // Step 3: Try Tesseract as fallback (if enabled and better suited for English text)
  let tesseractResult = null;
  if (tesseractFallbackEnabled) {
    console.log(`🔤 Trying Tesseract fallback | Reason: ${paddleResult?.fallbackReason || 'PaddleOCR low quality'}`);

    try {
      tesseractResult = await multiOCROrchestrator.runTesseractOCR(enhancedImageBuffer);

      // Check if Tesseract produced better results
      const tesseractThreshold = parseInt(process.env.TESSERACT_CONFIDENCE_THRESHOLD) || 70;
      if (tesseractResult && !tesseractResult.error && tesseractResult.confidence > tesseractThreshold) {
        const tesseractParsed = paymentParser.parsePaymentData(tesseractResult.text, options.expectedBank);

        if (tesseractParsed.isBankStatement && tesseractParsed.confidence === 'high') {
          // Tesseract found good results
          tesseractParsed.ocrEngine = 'Tesseract';
          tesseractParsed.processingTime = Date.now() - startTime;
          tesseractParsed.paddleFallbackReason = paddleResult?.fallbackReason;
          tesseractParsed.imageEnhancement = {
            enhanced: enhancementResult?.enhanced || false,
            qualityScore: enhancementResult?.qualityAnalysis?.overallScore,
            enhancementsApplied: enhancementResult?.enhancementsApplied || [],
            processingTime: enhancementResult?.processingTime || 0
          };

          console.log(`✅ Tesseract fallback success | Time: ${Date.now() - startTime}ms | Confidence: ${tesseractParsed.confidence}`);
          return tesseractParsed;
        }
      }
    } catch (error) {
      console.warn(`⚠️ Tesseract fallback failed: ${error.message}`);
      tesseractResult = { error: error.message };
    }
  }

  // Step 4: Use GPT-4o for complex cases (if enabled)
  if (gptFallbackEnabled) {
    if (!openai) {
      console.warn('⚠️ GPT fallback requested but OpenAI client not initialized');
      // Continue to final error handling
    } else {
      console.log(`🧠 Falling back to GPT-4o Vision | Reason: ${paddleResult?.fallbackReason || 'Previous OCR engines failed'}`);

      const gptResult = await analyzeWithGPT4Vision(enhancedImageBuffer, {
        ...options,
        paddleHints: paddleResult?.ocrText, // Pass PaddleOCR text as hint
        tesseractHints: tesseractResult?.text, // Pass Tesseract text as hint
        enhancementData: enhancementResult // Pass enhancement metadata
      });

      // Add performance metrics and enhancement metadata
      gptResult.ocrEngine = 'GPT-4o';
      gptResult.processingTime = Date.now() - startTime;
      gptResult.paddleFallbackReason = paddleResult?.fallbackReason;
      gptResult.tesseractFallbackReason = tesseractResult?.error;
      gptResult.imageEnhancement = {
        enhanced: enhancementResult?.enhanced || false,
        qualityScore: enhancementResult?.qualityAnalysis?.overallScore,
        enhancementsApplied: enhancementResult?.enhancementsApplied || [],
        processingTime: enhancementResult?.processingTime || 0
      };

      console.log(`✅ GPT-4o analysis complete | Time: ${Date.now() - startTime}ms | Confidence: ${gptResult.confidence}`);
      return gptResult;
    }
  }

  // If we reach here, all OCR engines failed and no fallbacks are enabled
  console.error(`❌ All OCR engines failed | Paddle: ${paddleResult?.fallbackReason || 'failed'} | Tesseract: ${tesseractResult?.error || 'disabled'} | GPT: disabled`);

  return {
    success: false,
    isBankStatement: false,
    isPaid: false,
    confidence: 'failed',
    error: 'All OCR engines failed',
    ocrEngine: 'none',
    processingTime: Date.now() - startTime,
    imageEnhancement: {
      enhanced: enhancementResult?.enhanced || false,
      qualityScore: enhancementResult?.qualityAnalysis?.overallScore,
      enhancementsApplied: enhancementResult?.enhancementsApplied || [],
      processingTime: enhancementResult?.processingTime || 0
    },
    debugInfo: {
      paddleResult: paddleResult,
      tesseractResult: tesseractResult,
      gptFallbackEnabled: gptFallbackEnabled,
      tesseractFallbackEnabled: tesseractFallbackEnabled
    }
  };
}

/**
 * Try PaddleOCR extraction and parsing
 * @param {Buffer} imageBuffer - Image data
 * @param {Object} options - Options
 * @returns {Promise<object|null>} - PaddleOCR result or null
 */
async function tryPaddleOCR(imageBuffer, options = {}) {
  try {
    // Check if PaddleOCR is available
    if (!paddleOCR.enabled) {
      return { fallbackReason: 'PaddleOCR disabled' };
    }

    // Extract text with PaddleOCR
    const ocrResult = await paddleOCR.extractText(imageBuffer);

    if (!ocrResult || !ocrResult.fullText) {
      return { fallbackReason: 'PaddleOCR extraction failed' };
    }

    // Check if any text was extracted
    if (!ocrResult.fullText || ocrResult.fullText.trim().length === 0) {
      console.warn('⚠️  PaddleOCR extracted no text from image');
      return {
        fallbackReason: 'No text extracted from image',
        confidence: 'failed',
        ocrEngine: 'PaddleOCR',
        ocrText: '',
        linesExtracted: 0,
        errorType: 'no_text_extracted'
      };
    }

    // Parse payment data from OCR text
    const paymentData = paymentParser.parsePaymentData(ocrResult.fullText, options.expectedBank);

    // Add OCR metadata
    paymentData.ocrEngine = 'PaddleOCR';
    paymentData.ocrConfidence = ocrResult.avgConfidence;
    paymentData.ocrText = ocrResult.fullText;
    paymentData.linesExtracted = ocrResult.lines.length;

    // Validate result quality
    if (!isValidPaddleResult(paymentData, ocrResult)) {
      return {
        fallbackReason: `Low quality: confidence=${paymentData.confidence}, isBankStatement=${paymentData.isBankStatement}`,
        ocrText: ocrResult.fullText,
        confidence: paymentData.confidence,
        errorType: 'low_quality'
      };
    }

    return paymentData;

  } catch (error) {
    console.error('❌ PaddleOCR processing failed:', error.message);
    return {
      fallbackReason: `PaddleOCR error: ${error.message}`,
      confidence: 'error',
      ocrEngine: 'PaddleOCR',
      ocrText: '',
      linesExtracted: 0,
      errorType: 'processing_error',
      errorDetails: error.message
    };
  }
}

/**
 * Check if PaddleOCR result is good enough to use
 * @param {object} paddleResult - PaddleOCR result
 * @returns {boolean} - Should use this result
 */
function shouldUsePaddleResult(paddleResult) {
  if (!paddleResult || paddleResult.fallbackReason) {
    return false;
  }

  // Check if GPT fallback is disabled - if so, always try to use PaddleOCR result
  const gptFallbackEnabled = process.env.GPT_FALLBACK_ENABLED === 'true';

  if (!gptFallbackEnabled) {
    console.log('🔧 GPT fallback disabled - using PaddleOCR result regardless of quality');
    return true;
  }

  // Original strict criteria (only when GPT fallback is enabled)
  // Must be identified as a bank statement
  if (!paddleResult.isBankStatement) {
    return false;
  }

  // Must have high confidence
  if (paddleResult.confidence !== 'high') {
    return false;
  }

  // Must have payment completion status
  if (!paddleResult.isPaid) {
    return false;
  }

  // Must have essential fields
  const hasAmount = paddleResult.amount !== null;
  const hasBankName = paddleResult.bankName !== null;
  const hasIdentifier = paddleResult.transactionId || paddleResult.toAccount;

  return hasAmount && hasBankName && hasIdentifier;
}

/**
 * Validate PaddleOCR result quality
 * @param {object} paymentData - Parsed payment data
 * @param {object} ocrResult - OCR raw result
 * @returns {boolean} - Is valid
 */
function isValidPaddleResult(paymentData, ocrResult) {
  // OCR confidence must be reasonable
  if (ocrResult.avgConfidence < 0.75) {
    return false;
  }

  // Must have extracted meaningful text
  if (!ocrResult.fullText || ocrResult.fullText.length < 20) {
    return false;
  }

  // Payment data must be valid
  if (!paymentData.isBankStatement || !paymentData.isPaid) {
    return false;
  }

  return true;
}

/**
 * Analyze with GPT-4o Vision (original implementation)
 * @param {Buffer} imageBuffer - Image data
 * @param {Object} options - Analysis options
 * @returns {Promise<object>} - GPT-4o result
 */
async function analyzeWithGPT4Vision(imageBuffer, options = {}) {
  if (!openai) {
    throw new Error('OpenAI client not available - check API key configuration');
  }

  const openaiTimeout = parseInt(process.env.OCR_TIMEOUT_MS) || 60000;

  // Get base64 image
  const base64Image = imageBuffer.toString('base64');

  // Get learned patterns and improved prompts
  const learnedPatterns = await getLearnedPatterns(options.expectedBank);

  // Enhance prompt with PaddleOCR hints if available
  let enhancedPrompt = await getImprovedPrompt(OCR_PROMPT, learnedPatterns);

  if (options.paddleHints) {
    enhancedPrompt += `\n\nPADDLEOCR EXTRACTED TEXT (for reference):\n${options.paddleHints}`;
  }

  if (options.tesseractHints) {
    enhancedPrompt += `\n\nTESSERACT EXTRACTED TEXT (for reference):\n${options.tesseractHints}`;
  }

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
                text: enhancedPrompt
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

  console.log('GPT-4o OCR completed successfully');

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

  // Normalize GPT's date output via parseKhmerDate (handles Khmer, English, mixed)
  if (paymentData.transactionDate) {
    const { parseKhmerDate } = require('./khmer-date');
    const parsed = parseKhmerDate(paymentData.transactionDate);
    if (parsed && !isNaN(parsed.getTime())) {
      paymentData._originalDate = paymentData.transactionDate;
      paymentData.transactionDate = parsed.toISOString().split('T')[0]; // YYYY-MM-DD
    }
  }

  // ── Bank-specific field sharpener (port of scriptclient's 0.90-confidence pattern) ──
  // Runs over GPT-4o's rawText with bank-specific positional regex. Overrides weak/missing
  // fields when the per-bank extractor produces high-confidence values.
  const sourceText = paymentData.rawText || options.paddleHints || options.tesseractHints || '';
  if (paymentData.bankName && sourceText) {
    try {
      const bankFieldExtractor = require('../services/bank-field-extractor');
      const extracted = bankFieldExtractor.extractBankFields(sourceText, paymentData.bankName);
      if (extracted.applied) {
        const overridden = bankFieldExtractor.applyToPayment(paymentData, extracted);
        if (overridden.length > 0) {
          console.log(`🏦 [${paymentData.bankName}] Bank field extractor sharpened: ${overridden.join(', ')}`);
          paymentData._bankFieldExtractor = { applied: overridden, confidence: 0.9 };
        } else {
          console.log(`🏦 [${paymentData.bankName}] Bank field extractor matched ${Object.keys(extracted.fields).join(', ')} but GPT-4o values already strong`);
        }
      }
    } catch (err) {
      console.warn(`⚠️ Bank field extractor failed: ${err.message} — keeping GPT-4o values`);
    }
  }

  // ── Override transactionDate with Claude Haiku extraction (more reliable for Khmer dates) ──
  // Mirrors scriptclient: Haiku returns raw date text → khmer-date.js parses deterministically.
  // Skips silently if ANTHROPIC_API_KEY is not set.
  if (claudeDateExtractor.isAvailable()) {
    try {
      const haikuRaw = await claudeDateExtractor.extractDateText(imageBuffer);
      if (haikuRaw) {
        const { parseKhmerDate } = require('./khmer-date');
        const parsed = parseKhmerDate(haikuRaw);
        if (parsed && !isNaN(parsed.getTime())) {
          const previous = paymentData.transactionDate;
          paymentData._gptDate = previous;
          paymentData._haikuRawDate = haikuRaw;
          paymentData.transactionDate = parsed.toISOString();
          console.log(`📅 [DATE] Haiku raw "${haikuRaw}" → parsed ${paymentData.transactionDate}${previous ? ` (was: ${previous})` : ''}`);
        } else {
          console.warn(`📅 [DATE] Haiku returned "${haikuRaw}" but khmer-date parser returned null — keeping GPT date`);
        }
      }
    } catch (err) {
      console.warn(`📅 [DATE] Haiku override failed: ${err.message} — keeping GPT date`);
    }
  }

  logExtractedFields('GPT-4o', paymentData);

  // ── ESCALATION: retry with stronger pass if first attempt was weak ──
  const escalationEnabled = process.env.OCR_ESCALATION_ENABLED !== 'false';
  if (escalationEnabled && needsEscalation(paymentData)) {
    console.log(`⬆️  Escalating to higher-tier extraction | Reason: ${escalationReason(paymentData)}`);
    try {
      const escalated = await escalateExtraction(imageBuffer, paymentData, options);
      if (escalated && isStrongerResult(escalated, paymentData)) {
        escalated._escalated = true;
        escalated._escalatedFrom = { confidence: paymentData.confidence, missing: missingCriticalFields(paymentData) };
        logExtractedFields('GPT-4o-HIGH', escalated);
        return escalated;
      } else {
        console.log(`⬆️  Escalation did not improve result — keeping original`);
      }
    } catch (err) {
      console.warn(`⚠️ Escalation attempt failed: ${err.message} — keeping original result`);
    }
  }

  return paymentData;
}

/**
 * Check whether a GPT-4o result is weak enough to warrant escalation.
 */
function needsEscalation(data) {
  if (!data) return true;
  if (data.confidence === 'low' || data.confidence === 'medium') return true;
  return missingCriticalFields(data).length > 0;
}

function missingCriticalFields(data) {
  const missing = [];
  if (data.isBankStatement === false) return missing; // not a bank stmt — escalation won't help
  if (!data.amount) missing.push('amount');
  if (!data.bankName) missing.push('bankName');
  if (!data.transactionId && !data.toAccount) missing.push('transactionId|toAccount');
  return missing;
}

function escalationReason(data) {
  const missing = missingCriticalFields(data);
  const parts = [];
  if (data.confidence === 'low' || data.confidence === 'medium') parts.push(`confidence=${data.confidence}`);
  if (missing.length) parts.push(`missing=[${missing.join(',')}]`);
  return parts.join(', ') || 'unknown';
}

/**
 * A second extraction pass that scores higher than the first only if it
 * fills in more critical fields OR raises confidence. Conservative on purpose —
 * we don't want to overwrite a high-confidence answer with a worse retry.
 */
function isStrongerResult(retry, original) {
  const retryMissing = missingCriticalFields(retry).length;
  const origMissing = missingCriticalFields(original).length;
  if (retryMissing < origMissing) return true;
  if (retryMissing > origMissing) return false;

  const rank = { low: 0, medium: 1, high: 2 };
  const retryConf = rank[retry.confidence] ?? 0;
  const origConf = rank[original.confidence] ?? 0;
  return retryConf > origConf;
}

/**
 * Higher-tier extraction. Currently uses GPT-4o with a sharper, gap-aware prompt
 * that includes the first attempt's output + Paddle/Tesseract hints. To upgrade
 * to Claude Opus 4.7 (best-in-class vision): add @anthropic-ai/sdk, set
 * ANTHROPIC_API_KEY, and replace the openai.chat.completions.create() call below
 * with anthropic.messages.create({ model: 'claude-opus-4-7', ... }).
 */
async function escalateExtraction(imageBuffer, firstAttempt, options = {}) {
  if (!openai) throw new Error('OpenAI client not available for escalation');

  const openaiTimeout = parseInt(process.env.OCR_TIMEOUT_MS) || 60000;
  const base64Image = imageBuffer.toString('base64');
  const missing = missingCriticalFields(firstAttempt);

  let escalationPrompt = `You are extracting SPECIFIC FIELDS from a Cambodian bank statement screenshot. A previous extraction was incomplete or low-confidence.

PREVIOUS EXTRACTION (confidence: ${firstAttempt.confidence}):
${JSON.stringify({
  bankName: firstAttempt.bankName,
  amount: firstAttempt.amount,
  currency: firstAttempt.currency,
  transactionId: firstAttempt.transactionId,
  toAccount: firstAttempt.toAccount,
  recipientName: firstAttempt.recipientName,
  transactionDate: firstAttempt.transactionDate,
}, null, 2)}

YOUR JOB: Return improved values for the MISSING or UNCERTAIN fields. Focus on:
${missing.length ? missing.join(', ') : 'all fields (overall confidence was too low)'}

Common mistakes to avoid:
- amount: missed the minus sign on ABA "CT" line / wrong decimal placement / extracted random number
- bankName: failed to identify bank from the header logo (ABA = dark blue, ACLEDA = navy, Wing = orange)
- transactionId: confused 8-13 digit account/phone number with real Trx ID (real Trx IDs are 15+ chars and contain letters: e.g. "FT24..." for ABA)
- toAccount: missed the labeled "To account:" / "Beneficiary:" row
- recipientName: cut off after first word, missed "&" between two names

Return JSON with the SAME SHAPE as the previous extraction (isBankStatement, isPaid, amount, currency, transactionId, referenceNumber, fromAccount, toAccount, bankName, transactionDate, remark, recipientName, confidence). Fill the listed missing fields with corrected values. If you genuinely cannot read a field clearly, return null — do NOT guess. Set confidence='high' only if every critical field is clearly readable.`;

  if (options.paddleHints) {
    escalationPrompt += `\n\nPADDLEOCR EXTRACTED TEXT:\n${options.paddleHints}`;
  }
  if (options.tesseractHints) {
    escalationPrompt += `\n\nTESSERACT EXTRACTED TEXT:\n${options.tesseractHints}`;
  }

  const response = await retryWithBackoff(async () => {
    await rateLimiter.waitForSlot();
    console.log('Calling GPT-4o (escalation pass) for stronger Bank Statement OCR...');
    return await Promise.race([
      openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: escalationPrompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
          ]
        }],
        max_tokens: 1500
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('OpenAI escalation timeout')), openaiTimeout)
      )
    ]);
  });

  const aiResponse = response.choices[0].message.content;
  const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in escalation response');

  const escalated = JSON.parse(jsonMatch[0]);

  if (escalated.transactionDate) {
    const { parseKhmerDate } = require('./khmer-date');
    const parsed = parseKhmerDate(escalated.transactionDate);
    if (parsed && !isNaN(parsed.getTime())) {
      escalated._originalDate = escalated.transactionDate;
      escalated.transactionDate = parsed.toISOString().split('T')[0];
    }
  }

  return escalated;
}

/**
 * Log all extracted payment fields in a single readable block.
 * Helps diagnose why a result was marked low/medium confidence by showing
 * exactly what the model returned (or failed to return).
 */
function logExtractedFields(engine, data) {
  const present = (v) => (v === null || v === undefined || v === '') ? '—' : v;
  console.log(`📋 [${engine}] Extracted fields:`);
  console.log(`   isBankStatement: ${present(data.isBankStatement)} | isPaid: ${present(data.isPaid)} | confidence: ${present(data.confidence)}`);
  console.log(`   bankName:        ${present(data.bankName)}`);
  console.log(`   amount:          ${present(data.amount)} ${present(data.currency)}`);
  console.log(`   transactionId:   ${present(data.transactionId)}`);
  console.log(`   referenceNumber: ${present(data.referenceNumber)}`);
  console.log(`   toAccount:       ${present(data.toAccount)}`);
  console.log(`   fromAccount:     ${present(data.fromAccount)}`);
  console.log(`   recipientName:   ${present(data.recipientName)}`);
  console.log(`   transactionDate: ${present(data.transactionDate)}${data._originalDate ? ` (raw: ${data._originalDate})` : ''}`);
}

/**
 * Get rate limiter status
 * @returns {object} - Rate limiter status
 */
function getRateLimiterStatus() {
  return rateLimiter.getStatus();
}

/**
 * Get OCR service status
 * @returns {object} - Service status
 */
function getOCRServiceStatus() {
  return {
    paddleOCR: paddleOCR.getStatus(),
    imageEnhancer: imageEnhancer.getStatus(),
    rateLimiter: rateLimiter.getStatus(),
    paymentParser: {
      initialized: !!paymentParser
    },
    multiOCR: multiOCROrchestrator.getHealthStatus()
  };
}

module.exports = {
  analyzePaymentScreenshot,
  analyzeWithGPT4Vision,
  getRateLimiterStatus,
  getOCRServiceStatus,
  OCR_PROMPT
};
