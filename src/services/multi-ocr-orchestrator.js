'use strict';

const axios = require('axios');
const EnhancedImageProcessor = require('./enhanced-image-processor');
const BankTemplateMatcher = require('./bank-template-matcher');
const TesseractOCRService = require('./tesseract-ocr');

/**
 * Multi-OCR Orchestrator
 * Coordinates multiple OCR engines and combines results with confidence scoring
 */
class MultiOCROrchestrator {
  constructor() {
    this.imageProcessor = new EnhancedImageProcessor();
    this.templateMatcher = new BankTemplateMatcher();
    this.tesseractOCR = new TesseractOCRService();
    this.tesseractInitialized = false;
    this.initializationPromise = null;

    this.config = {
      easyocrUrl: 'http://localhost:8867',
      openaiApiKey: process.env.OPENAI_API_KEY,

      // Confidence weights for different engines
      weights: {
        template: 0.4,    // Template matching gets highest weight for banks
        easyocr: 0.3,     // EasyOCR good for mixed languages
        tesseract: 0.3    // Tesseract good for English
      },

      // Minimum confidence thresholds
      thresholds: {
        template: 0.6,    // High threshold for template matching
        easyocr: 0.5,     // Medium threshold for EasyOCR
        tesseract: 0.7,   // High threshold for Tesseract English
        combined: 0.6     // Final combined threshold
      },

      // Language routing
      useOpenAIForKhmer: true,
      maxRetries: 2
    };

    // Initialize Tesseract on startup
    this.initializeTesseract();

    this.stats = {
      totalRequests: 0,
      successfulExtractions: 0,
      engineUsage: {
        template: 0,
        easyocr: 0,
        tesseract: 0,
        openai: 0
      }
    };
  }

  /**
   * Initialize Tesseract worker with retry logic
   */
  async initializeTesseract() {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._doTesseractInitialization();
    return this.initializationPromise;
  }

  async _doTesseractInitialization() {
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔧 Initializing Tesseract worker (attempt ${attempt}/${maxRetries})...`);

        const success = await this.tesseractOCR.initialize();

        if (success) {
          this.tesseractInitialized = true;
          console.log('✅ Tesseract worker initialized successfully');
          return true;
        } else {
          throw new Error('Tesseract initialization returned false');
        }

      } catch (error) {
        lastError = error;
        console.warn(`⚠️ Tesseract initialization attempt ${attempt} failed:`, error.message);

        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.log(`🔄 Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error('❌ Failed to initialize Tesseract after all retries:', lastError?.message);
    this.tesseractInitialized = false;
    return false;
  }

  /**
   * Check if Tesseract is ready for use
   */
  isTesseractReady() {
    return this.tesseractInitialized && this.tesseractOCR.initialized;
  }

  /**
   * Get health status of all OCR engines
   */
  getHealthStatus() {
    return {
      tesseract: {
        initialized: this.tesseractInitialized,
        ready: this.isTesseractReady(),
        status: this.tesseractInitialized ? 'healthy' : 'failed'
      },
      easyocr: {
        url: this.config.easyocrUrl,
        status: 'unknown' // Would need to ping the service to verify
      },
      openai: {
        configured: !!this.config.openaiApiKey,
        status: this.config.openaiApiKey ? 'configured' : 'missing_key'
      }
    };
  }

  /**
   * Main orchestration method - process image with multiple OCR engines
   * @param {Buffer} imageBuffer
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async processImage(imageBuffer, options = {}) {
    const startTime = Date.now();
    this.stats.totalRequests++;

    try {
      console.log('🚀 Starting multi-OCR orchestration...');

      // Step 1: Enhanced image preprocessing
      const processedImages = await this.imageProcessor.processForMultiOCR(imageBuffer);
      console.log(`🎨 Image preprocessing complete: ${processedImages.processingTime}ms`);

      // Step 2: Template matching for bank detection
      const templateResult = await this.templateMatcher.analyzeImage(processedImages.template);
      console.log(`🏦 Template analysis: Bank=${templateResult.bankDetected}, confidence=${templateResult.confidence.toFixed(2)}`);

      // Step 3: Determine OCR strategy based on template results
      const strategy = this.determineStrategy(templateResult, processedImages.analysis);
      console.log(`📋 OCR Strategy: ${strategy.engines.join(' + ')}`);

      // Step 4: Execute OCR engines in parallel
      const ocrResults = await this.executeOCREngines(processedImages, strategy);

      // Step 5: Language detection and routing
      const languageAnalysis = this.analyzeLanguages(ocrResults);

      // Step 6: Route Khmer text to OpenAI if needed
      let openaiResult = null;
      if (languageAnalysis.hasKhmer && this.config.useOpenAIForKhmer) {
        openaiResult = await this.processWithOpenAI(processedImages.original);
      }

      // Step 7: Combine and merge results
      const combinedResult = this.combineResults({
        template: templateResult,
        ocr: ocrResults,
        openai: openaiResult,
        language: languageAnalysis,
        strategy: strategy
      });

      const totalTime = Date.now() - startTime;
      console.log(`✅ Multi-OCR complete in ${totalTime}ms, final confidence: ${combinedResult.confidence.toFixed(2)}`);

      // Update stats
      if (combinedResult.confidence >= this.config.thresholds.combined) {
        this.stats.successfulExtractions++;
      }

      return {
        ...combinedResult,
        processingTime: totalTime,
        strategy: strategy,
        stats: this.getStats()
      };

    } catch (error) {
      console.error('❌ Multi-OCR orchestration failed:', error.message);
      return this.createErrorResult(error.message, Date.now() - startTime);
    }
  }

  /**
   * Determine OCR strategy based on template detection
   * @param {Object} templateResult
   * @param {Object} imageAnalysis
   * @returns {Object}
   */
  determineStrategy(templateResult, imageAnalysis) {
    const strategy = {
      engines: [],
      priority: 'template',
      reason: 'default'
    };

    // If bank template detected with high confidence, prioritize template + targeted OCR
    if (templateResult.templateMatch && templateResult.confidence > this.config.thresholds.template) {
      strategy.engines = ['template', 'easyocr'];
      strategy.priority = 'template';
      strategy.reason = `High confidence bank detection: ${templateResult.bankDetected}`;
    }
    // If moderate bank detection, use all engines
    else if (templateResult.bankDetected && templateResult.confidence > 0.3) {
      strategy.engines = ['template', 'easyocr', 'tesseract'];
      strategy.priority = 'combined';
      strategy.reason = `Moderate bank detection, using all engines`;
    }
    // If no bank detected, focus on general OCR
    else {
      strategy.engines = ['easyocr', 'tesseract'];
      strategy.priority = 'ocr';
      strategy.reason = `No bank template detected, using general OCR`;
    }

    // Adjust based on image quality
    if (imageAnalysis.qualityScore > 80) {
      strategy.engines.unshift('tesseract'); // Tesseract works well with high quality
    }

    return strategy;
  }

  /**
   * Execute selected OCR engines in parallel
   * @param {Object} processedImages
   * @param {Object} strategy
   * @returns {Promise<Object>}
   */
  async executeOCREngines(processedImages, strategy) {
    const results = {};
    const promises = [];

    // EasyOCR
    if (strategy.engines.includes('easyocr')) {
      promises.push(
        this.runEasyOCR(processedImages.easyocr)
          .then(result => { results.easyocr = result; this.stats.engineUsage.easyocr++; })
          .catch(error => { results.easyocr = { error: error.message, confidence: 0 }; })
      );
    }

    // Tesseract
    if (strategy.engines.includes('tesseract')) {
      promises.push(
        this.runTesseractOCR(processedImages.tesseract)
          .then(result => { results.tesseract = result; this.stats.engineUsage.tesseract++; })
          .catch(error => { results.tesseract = { error: error.message, confidence: 0, errorType: 'execution_failed' }; })
      );
    }

    await Promise.all(promises);
    return results;
  }

  /**
   * Run Tesseract OCR with proper initialization checking
   * @param {Buffer} imageBuffer
   * @returns {Promise<Object>}
   */
  async runTesseractOCR(imageBuffer) {
    try {
      // Ensure Tesseract is initialized
      if (!this.isTesseractReady()) {
        console.log('🔄 Tesseract not ready, attempting initialization...');
        const initialized = await this.initializeTesseract();

        if (!initialized) {
          return {
            text: '',
            confidence: 0,
            error: 'Tesseract initialization failed',
            errorType: 'initialization_failed',
            engine: 'Tesseract'
          };
        }
      }

      // Run OCR extraction
      const result = await this.tesseractOCR.extractText(imageBuffer);

      // Check if result indicates initialization issues
      if (result.error && result.error.includes('initialize')) {
        return {
          ...result,
          errorType: 'initialization_failed',
          engine: 'Tesseract'
        };
      }

      // Check if meaningful text was extracted
      if ((!result.text || result.text.trim().length < 5) && result.confidence < 30) {
        return {
          ...result,
          errorType: 'no_meaningful_text',
          engine: 'Tesseract'
        };
      }

      return {
        ...result,
        engine: 'Tesseract'
      };

    } catch (error) {
      console.error('❌ Tesseract OCR execution failed:', error.message);

      // Categorize the error
      let errorType = 'execution_failed';
      if (error.message.includes('worker') || error.message.includes('initialize')) {
        errorType = 'initialization_failed';
      } else if (error.message.includes('timeout')) {
        errorType = 'timeout';
      }

      return {
        text: '',
        confidence: 0,
        error: error.message,
        errorType: errorType,
        engine: 'Tesseract'
      };
    }
  }

  /**
   * Call EasyOCR microservice
   * @param {Buffer} imageBuffer
   * @returns {Promise<Object>}
   */
  async runEasyOCR(imageBuffer) {
    try {
      const imageBase64 = imageBuffer.toString('base64');

      const response = await axios.post(`${this.config.easyocrUrl}/extract`, {
        image: imageBase64,
        preprocessing: true,
        detail: 1
      }, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });

      return {
        ...response.data,
        engine: 'EasyOCR'
      };

    } catch (error) {
      console.error('EasyOCR service error:', error.message);
      return {
        text: '',
        confidence: 0,
        error: error.message,
        engine: 'EasyOCR'
      };
    }
  }

  /**
   * Process image with OpenAI Vision for Khmer text
   * @param {Buffer} imageBuffer
   * @returns {Promise<Object>}
   */
  async processWithOpenAI(imageBuffer) {
    if (!this.config.openaiApiKey) {
      return { error: 'OpenAI API key not configured', confidence: 0 };
    }

    try {
      const imageBase64 = imageBuffer.toString('base64');

      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4-vision-preview',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract all text from this image, particularly any Khmer/Cambodian text. Format your response as JSON with extracted text and confidence (0-1).'
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`
              }
            }
          ]
        }],
        max_tokens: 1000
      }, {
        headers: {
          'Authorization': `Bearer ${this.config.openaiApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      const content = response.data.choices[0].message.content;
      const result = JSON.parse(content);

      this.stats.engineUsage.openai++;

      return {
        text: result.text || '',
        confidence: result.confidence || 0.8,
        engine: 'OpenAI-Vision'
      };

    } catch (error) {
      console.error('OpenAI Vision error:', error.message);
      return {
        text: '',
        confidence: 0,
        error: error.message,
        engine: 'OpenAI-Vision'
      };
    }
  }

  /**
   * Analyze language content in OCR results
   * @param {Object} ocrResults
   * @returns {Object}
   */
  analyzeLanguages(ocrResults) {
    let hasEnglish = false;
    let hasKhmer = false;
    let totalText = '';

    // Combine all OCR text
    for (const [engine, result] of Object.entries(ocrResults)) {
      if (result.text) {
        totalText += ' ' + result.text;
      }
    }

    // Detect English (A-Z, a-z characters)
    const englishChars = totalText.match(/[A-Za-z]/g) || [];
    if (englishChars.length > 5) {
      hasEnglish = true;
    }

    // Detect Khmer (Unicode range U+1780-U+17FF)
    const khmerChars = totalText.match(/[\u1780-\u17FF]/g) || [];
    if (khmerChars.length > 3) {
      hasKhmer = true;
    }

    return {
      hasEnglish: hasEnglish,
      hasKhmer: hasKhmer,
      englishCharCount: englishChars.length,
      khmerCharCount: khmerChars.length,
      totalLength: totalText.trim().length,
      primaryLanguage: khmerChars.length > englishChars.length ? 'khmer' : 'english'
    };
  }

  /**
   * Combine results from all engines with weighted confidence scoring
   * @param {Object} allResults
   * @returns {Object}
   */
  combineResults(allResults) {
    const { template, ocr, openai, language, strategy } = allResults;

    let bestResult = {
      text: '',
      confidence: 0,
      engine: 'none',
      extractedData: {}
    };

    let combinedConfidence = 0;
    let weightSum = 0;

    // Template matching results (highest weight for banks)
    if (template.templateMatch && template.extractedData) {
      const templateWeight = this.config.weights.template;
      combinedConfidence += template.confidence * templateWeight;
      weightSum += templateWeight;

      if (template.confidence > bestResult.confidence) {
        bestResult = {
          text: this.formatTemplateText(template.extractedData),
          confidence: template.confidence,
          engine: 'template',
          extractedData: template.extractedData
        };
      }
    }

    // OCR results
    for (const [engine, result] of Object.entries(ocr)) {
      if (result.confidence > this.config.thresholds[engine]) {
        const weight = this.config.weights[engine];
        combinedConfidence += (result.confidence / 100) * weight; // Normalize to 0-1
        weightSum += weight;

        if (result.confidence > bestResult.confidence * 100) {
          bestResult = {
            text: result.text,
            confidence: result.confidence / 100,
            engine: engine,
            extractedData: this.extractDataFromOCR(result)
          };
        }
      }
    }

    // OpenAI results (for Khmer)
    if (openai && openai.confidence > 0.5) {
      const openaiWeight = 0.3;
      combinedConfidence += openai.confidence * openaiWeight;
      weightSum += openaiWeight;

      // Merge Khmer text with existing results
      if (language.hasKhmer && openai.text) {
        bestResult.text += '\n[Khmer] ' + openai.text;
        bestResult.extractedData.khmerText = openai.text;
      }
    }

    // Calculate final confidence
    const finalConfidence = weightSum > 0 ? combinedConfidence / weightSum : 0;

    return {
      text: bestResult.text,
      confidence: finalConfidence,
      primaryEngine: bestResult.engine,
      extractedData: bestResult.extractedData,
      allResults: {
        template: template,
        ocr: ocr,
        openai: openai
      },
      language: language,
      success: finalConfidence >= this.config.thresholds.combined
    };
  }

  /**
   * Format template extraction results into readable text
   * @param {Object} extractedData
   * @returns {string}
   */
  formatTemplateText(extractedData) {
    const parts = [];

    if (extractedData.amount && extractedData.currency) {
      parts.push(`Amount: ${extractedData.amount} ${extractedData.currency}`);
    }

    if (extractedData.recipient) {
      parts.push(`Recipient: ${extractedData.recipient}`);
    }

    if (extractedData.transactionId) {
      parts.push(`Transaction ID: ${extractedData.transactionId}`);
    }

    return parts.join('\n');
  }

  /**
   * Extract structured data from OCR text
   * @param {Object} ocrResult
   * @returns {Object}
   */
  extractDataFromOCR(ocrResult) {
    const extractedData = {};

    if (ocrResult.patterns) {
      extractedData.amounts = ocrResult.patterns.amounts;
      extractedData.transactionIds = ocrResult.patterns.transactionIds;
      extractedData.names = ocrResult.patterns.names;
      extractedData.dates = ocrResult.patterns.dates;
    }

    return extractedData;
  }

  /**
   * Create error result
   * @param {string} errorMessage
   * @param {number} processingTime
   * @returns {Object}
   */
  createErrorResult(errorMessage, processingTime) {
    return {
      text: '',
      confidence: 0,
      primaryEngine: 'error',
      extractedData: {},
      error: errorMessage,
      success: false,
      processingTime: processingTime
    };
  }

  /**
   * Get current statistics
   * @returns {Object}
   */
  getStats() {
    const successRate = this.stats.totalRequests > 0 ?
      (this.stats.successfulExtractions / this.stats.totalRequests) * 100 : 0;

    return {
      totalRequests: this.stats.totalRequests,
      successfulExtractions: this.stats.successfulExtractions,
      successRate: Math.round(successRate * 100) / 100,
      engineUsage: { ...this.stats.engineUsage }
    };
  }

  /**
   * Update configuration
   * @param {Object} newConfig
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }
}

module.exports = MultiOCROrchestrator;