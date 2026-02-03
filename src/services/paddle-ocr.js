'use strict';

const axios = require('axios');
const sharp = require('sharp');

/**
 * PaddleOCR Service
 * Handles text extraction from bank payment screenshots
 */
class PaddleOCRService {
  constructor() {
    this.serviceUrl = process.env.PADDLE_OCR_SERVICE_URL || 'http://localhost:8866/predict/ocr_system';
    this.confidenceThreshold = parseFloat(process.env.PADDLE_CONFIDENCE_THRESHOLD) || 0.85;
    this.enabled = process.env.USE_PADDLE_OCR === 'true';
    this.timeout = parseInt(process.env.PADDLE_OCR_TIMEOUT_MS) || 30000;
  }

  /**
   * Extract text from image using PaddleOCR
   * @param {Buffer} imageBuffer - Image data
   * @returns {Promise<object>} - OCR result with text and confidence
   */
  async extractText(imageBuffer) {
    if (!this.enabled) {
      console.log('PaddleOCR is disabled, skipping');
      return null;
    }

    try {
      console.log('Starting PaddleOCR text extraction...');

      // Preprocess image for better OCR
      const processedImage = await this.preprocessImage(imageBuffer);

      // Call PaddleOCR HTTP service
      const response = await axios.post(this.serviceUrl, {
        images: [processedImage.toString('base64')]
      }, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.data || !response.data.results || !response.data.results[0]) {
        throw new Error('Invalid response from PaddleOCR service');
      }

      const result = this.parseOCRResult(response.data.results[0]);
      console.log(`PaddleOCR extraction completed | Confidence: ${result.avgConfidence}% | Lines: ${result.lines.length}`);

      return result;

    } catch (error) {
      console.error('PaddleOCR extraction failed:', error.message);
      return null;
    }
  }

  /**
   * Preprocess image for better OCR results
   * @param {Buffer} imageBuffer - Original image
   * @returns {Promise<Buffer>} - Processed image
   */
  async preprocessImage(imageBuffer) {
    try {
      // Enhance image for better OCR
      return await sharp(imageBuffer)
        .resize({ width: 1200, height: 1600, fit: 'inside', withoutEnlargement: true })
        .sharpen()
        .gamma(1.2)
        .jpeg({ quality: 95 })
        .toBuffer();
    } catch (error) {
      console.warn('Image preprocessing failed, using original:', error.message);
      return imageBuffer;
    }
  }

  /**
   * Parse PaddleOCR response into structured format
   * @param {Array} ocrResults - Raw OCR results from PaddleOCR
   * @returns {object} - Parsed OCR data
   */
  parseOCRResult(ocrResults) {
    if (!Array.isArray(ocrResults) || ocrResults.length === 0) {
      return {
        fullText: '',
        lines: [],
        avgConfidence: 0,
        isHighConfidence: false
      };
    }

    const lines = [];
    let totalConfidence = 0;

    for (const result of ocrResults) {
      if (result && result.length >= 2) {
        const text = result[1][0] || '';
        const confidence = result[1][1] || 0;
        const bbox = result[0] || [];

        lines.push({
          text: text.trim(),
          confidence: confidence,
          bbox: bbox
        });

        totalConfidence += confidence;
      }
    }

    const avgConfidence = lines.length > 0 ? totalConfidence / lines.length : 0;
    const fullText = lines.map(line => line.text).join(' ').trim();

    return {
      fullText,
      lines,
      avgConfidence: Math.round(avgConfidence * 100) / 100,
      isHighConfidence: avgConfidence >= this.confidenceThreshold
    };
  }

  /**
   * Check if PaddleOCR service is available
   * @returns {Promise<boolean>} - Service availability
   */
  async isServiceAvailable() {
    if (!this.enabled) {
      return false;
    }

    try {
      const response = await axios.get(`${this.serviceUrl}/health`, { timeout: 5000 });
      return response.status === 200;
    } catch (error) {
      console.warn('PaddleOCR service health check failed:', error.message);
      return false;
    }
  }

  /**
   * Get service status for monitoring
   * @returns {object} - Service status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      serviceUrl: this.serviceUrl,
      confidenceThreshold: this.confidenceThreshold,
      timeout: this.timeout
    };
  }
}

module.exports = PaddleOCRService;