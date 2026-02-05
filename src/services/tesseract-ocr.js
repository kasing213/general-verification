'use strict';

const Tesseract = require('tesseract.js');
const sharp = require('sharp');

/**
 * Tesseract OCR Service for English Text Extraction
 * Optimized for bank payment screenshots and English text
 */
class TesseractOCRService {
  constructor() {
    this.initialized = false;
    this.worker = null;
    this.config = {
      // Tesseract configuration optimized for bank text
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,- &$:',
      tessedit_pageseg_mode: '6', // Uniform block of text
      preserve_interword_spaces: '1',
      tessjs_create_hocr: '0',
      tessjs_create_tsv: '0'
    };

    this.confidenceThresholds = {
      high: 85,
      medium: 70,
      low: 50,
      failed: 30
    };
  }

  /**
   * Initialize Tesseract worker
   * @returns {Promise<boolean>}
   */
  async initialize() {
    if (this.initialized) return true;

    try {
      console.log('🔧 Initializing Tesseract worker...');

      // Tesseract.js v7+ API
      this.worker = await Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text') {
            console.log(`📝 Tesseract progress: ${Math.round(m.progress * 100)}%`);
          }
        }
      });

      // Set configuration parameters
      for (const [key, value] of Object.entries(this.config)) {
        await this.worker.setParameters({
          [key]: value
        });
      }

      this.initialized = true;
      console.log('✅ Tesseract worker initialized successfully');
      return true;

    } catch (error) {
      console.error('❌ Failed to initialize Tesseract:', error.message);
      console.error('Full error:', error);
      return false;
    }
  }

  /**
   * Extract text from image using Tesseract
   * @param {Buffer} imageBuffer
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async extractText(imageBuffer, options = {}) {
    if (!this.initialized) {
      const initSuccess = await this.initialize();
      if (!initSuccess) {
        return this.createErrorResult('Failed to initialize Tesseract');
      }
    }

    const startTime = Date.now();

    try {
      console.log('🔍 Starting Tesseract OCR extraction...');

      // Preprocess image for better OCR results
      const processedImage = await this.preprocessForTesseract(imageBuffer);

      // Run OCR
      const result = await this.worker.recognize(processedImage);
      const processingTime = Date.now() - startTime;

      console.log(`📄 Tesseract completed in ${processingTime}ms with confidence: ${result.data.confidence.toFixed(1)}%`);

      // Parse results
      const parsedResult = this.parseOCRResult(result.data, processingTime);

      return parsedResult;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error('❌ Tesseract extraction failed:', error.message);

      return this.createErrorResult(error.message, processingTime);
    }
  }

  /**
   * Extract text from specific regions
   * @param {Buffer} imageBuffer
   * @param {Array} regions - Array of {x, y, width, height} objects
   * @returns {Promise<Array>}
   */
  async extractRegions(imageBuffer, regions) {
    if (!this.initialized) {
      await this.initialize();
    }

    const results = [];

    for (const [index, region] of regions.entries()) {
      try {
        // Extract region
        const regionBuffer = await sharp(imageBuffer)
          .extract({
            left: region.x,
            top: region.y,
            width: region.width,
            height: region.height
          })
          .sharpen()
          .normalise()
          .jpeg({ quality: 95 })
          .toBuffer();

        // OCR the region
        const regionResult = await this.extractText(regionBuffer, { region: index });

        results.push({
          region: region,
          index: index,
          ...regionResult
        });

      } catch (error) {
        results.push({
          region: region,
          index: index,
          error: error.message,
          text: '',
          confidence: 0
        });
      }
    }

    return results;
  }

  /**
   * Preprocess image specifically for Tesseract
   * @param {Buffer} imageBuffer
   * @returns {Promise<Buffer>}
   */
  async preprocessForTesseract(imageBuffer) {
    return await sharp(imageBuffer)
      .resize({ width: 1200, fit: 'inside', withoutEnlargement: true })
      .sharpen({ sigma: 1.5, m1: 1, m2: 3 })
      .gamma(1.2)
      .linear(1.2, -(128 * 1.2) + 128) // Contrast boost
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  /**
   * Parse OCR result and categorize confidence
   * @param {Object} ocrData
   * @param {number} processingTime
   * @returns {Object}
   */
  parseOCRResult(ocrData, processingTime) {
    const fullText = ocrData.text.trim();
    const confidence = ocrData.confidence || 0;

    // Categorize confidence
    let confidenceCategory;
    if (confidence >= this.confidenceThresholds.high) {
      confidenceCategory = 'high';
    } else if (confidence >= this.confidenceThresholds.medium) {
      confidenceCategory = 'medium';
    } else if (confidence >= this.confidenceThresholds.low) {
      confidenceCategory = 'low';
    } else {
      confidenceCategory = 'failed';
    }

    // Extract words with individual confidence scores
    const words = ocrData.words || [];
    const highConfidenceWords = words.filter(word => word.confidence > this.confidenceThresholds.medium);

    // Parse specific patterns commonly found in bank payments
    const patterns = this.extractPatterns(fullText);

    return {
      text: fullText,
      confidence: Math.round(confidence),
      confidenceCategory: confidenceCategory,
      words: words.map(word => ({
        text: word.text,
        confidence: Math.round(word.confidence),
        bbox: word.bbox
      })),
      highConfidenceWords: highConfidenceWords.map(word => word.text),
      wordCount: words.length,
      highConfidenceWordCount: highConfidenceWords.length,
      patterns: patterns,
      processingTime: processingTime,
      engine: 'Tesseract'
    };
  }

  /**
   * Extract common banking patterns from text
   * @param {string} text
   * @returns {Object}
   */
  extractPatterns(text) {
    const patterns = {
      amounts: [],
      transactionIds: [],
      accounts: [],
      names: [],
      dates: []
    };

    // Amount patterns (USD, KHR)
    const amountRegex = /[-]?\d{1,3}(?:,\d{3})*(?:\.\d{2})?\s*(?:USD|KHR|\$|៛)/gi;
    patterns.amounts = [...text.matchAll(amountRegex)].map(match => match[0].trim());

    // Transaction ID patterns
    const txnRegex = /(?:TXN|Trx\.?\s*ID|Transaction\s*ID)[:\s]*([A-Z0-9]{6,})/gi;
    patterns.transactionIds = [...text.matchAll(txnRegex)].map(match => match[1]);

    // Account number patterns
    const accountRegex = /\b\d{3}[\s-]*\d{3}[\s-]*\d{3,}\b/g;
    patterns.accounts = [...text.matchAll(accountRegex)].map(match => match[0].replace(/[\s-]/g, ''));

    // Name patterns (2+ capitalized words)
    const nameRegex = /\b[A-Z][a-z]+(?:\s+[A-Z]\.?){1,}\s+[A-Z][a-z]+\b/g;
    patterns.names = [...text.matchAll(nameRegex)].map(match => match[0]);

    // Date patterns
    const dateRegex = /\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/g;
    patterns.dates = [...text.matchAll(dateRegex)].map(match => match[0]);

    return patterns;
  }

  /**
   * Create error result object
   * @param {string} errorMessage
   * @param {number} processingTime
   * @returns {Object}
   */
  createErrorResult(errorMessage, processingTime = 0) {
    return {
      text: '',
      confidence: 0,
      confidenceCategory: 'failed',
      words: [],
      highConfidenceWords: [],
      wordCount: 0,
      highConfidenceWordCount: 0,
      patterns: {
        amounts: [],
        transactionIds: [],
        accounts: [],
        names: [],
        dates: []
      },
      error: errorMessage,
      processingTime: processingTime,
      engine: 'Tesseract'
    };
  }

  /**
   * Check if text appears to be English
   * @param {string} text
   * @returns {Object}
   */
  isEnglishText(text) {
    const englishChars = text.match(/[A-Za-z]/g) || [];
    const totalChars = text.replace(/\s/g, '').length;
    const englishRatio = totalChars > 0 ? englishChars.length / totalChars : 0;

    return {
      isEnglish: englishRatio > 0.7,
      englishRatio: englishRatio,
      confidence: englishRatio > 0.8 ? 'high' : englishRatio > 0.6 ? 'medium' : 'low'
    };
  }

  /**
   * Cleanup worker
   */
  async terminate() {
    if (this.worker && this.initialized) {
      try {
        await this.worker.terminate();
        this.initialized = false;
        this.worker = null;
        console.log('🔄 Tesseract worker terminated');
      } catch (error) {
        console.error('Error terminating Tesseract worker:', error.message);
      }
    }
  }
}

module.exports = TesseractOCRService;