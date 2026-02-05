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
      console.log('🔍 Starting PaddleOCR text extraction...');

      // Validate input
      if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error('Empty or invalid image buffer');
      }

      // Preprocess image for better OCR
      const processedImage = await this.preprocessImage(imageBuffer);

      // Call PaddleOCR HTTP service
      const response = await axios.post(this.serviceUrl, {
        images: [processedImage.toString('base64')]
      }, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json'
        },
        validateStatus: function (status) {
          return status < 500; // Accept 4xx errors to handle them properly
        }
      });

      // Handle HTTP errors
      if (response.status >= 400) {
        console.error(`❌ PaddleOCR service error: HTTP ${response.status}`);
        console.error('Response:', JSON.stringify(response.data, null, 2));

        if (response.status === 400) {
          throw new Error('PaddleOCR: Bad request - possibly corrupted or unsupported image format');
        } else if (response.status === 413) {
          throw new Error('PaddleOCR: Image too large');
        } else if (response.status === 415) {
          throw new Error('PaddleOCR: Unsupported media type');
        } else {
          throw new Error(`PaddleOCR service returned HTTP ${response.status}`);
        }
      }

      if (!response.data) {
        throw new Error('Empty response from PaddleOCR service');
      }

      // Handle direct response from PaddleX (not wrapped in results array)
      const ocrData = response.data.results ? response.data.results[0] : response.data;

      if (!ocrData) {
        throw new Error('No OCR data in response');
      }

      const result = this.parseOCRResult(ocrData);

      console.log(`✅ PaddleOCR extraction completed:`);
      console.log(`   📝 Lines extracted: ${result.lines.length}`);
      console.log(`   🎯 Average confidence: ${result.avgConfidence}%`);
      console.log(`   📊 High confidence: ${result.isHighConfidence ? 'Yes' : 'No'}`);

      if (result.lines.length === 0) {
        console.warn('⚠️  No text was extracted from the image');
        console.warn('   This might indicate:');
        console.warn('   - Image contains no readable text');
        console.warn('   - Text is too small, blurry, or low contrast');
        console.warn('   - Image format/encoding issues');
        console.warn('   - PaddleOCR model limitations');
      }

      return result;

    } catch (error) {
      console.error('❌ PaddleOCR extraction failed:');
      console.error(`   Error: ${error.message}`);

      if (error.code === 'ECONNREFUSED') {
        console.error('   Cause: PaddleOCR service is not running');
        console.error('   Solution: Start the service with: source paddleocr_env/bin/activate && python scripts/paddle-server.py');
      } else if (error.code === 'ETIMEDOUT') {
        console.error('   Cause: Request timeout');
        console.error('   Solution: Image might be too large or complex');
      }

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
      console.log('📸 Preprocessing image for PaddleOCR...');

      // Get image metadata
      const metadata = await sharp(imageBuffer).metadata();
      console.log(`   Original: ${metadata.width}x${metadata.height}, format: ${metadata.format}`);

      // Apply multiple preprocessing steps for better OCR
      let processedImage = sharp(imageBuffer);

      // 1. Convert to standard JPEG format if needed
      if (metadata.format !== 'jpeg') {
        console.log('   Converting to JPEG format...');
        processedImage = processedImage.jpeg({ quality: 95 });
      }

      // 2. Resize if image is too large or too small
      if (metadata.width > 2000 || metadata.height > 2000 ||
          metadata.width < 300 || metadata.height < 300) {
        console.log('   Resizing image for optimal OCR...');
        processedImage = processedImage.resize({
          width: 1200,
          height: 1600,
          fit: 'inside',
          withoutEnlargement: false
        });
      }

      // 3. Enhance image quality
      console.log('   Applying enhancement filters...');
      processedImage = processedImage
        .sharpen(1, 1, 2)  // Moderate sharpening
        .gamma(1.1)        // Slight gamma correction
        .normalise()       // Auto-contrast
        .jpeg({ quality: 95 });

      const result = await processedImage.toBuffer();
      console.log(`   ✅ Preprocessing complete: ${result.length} bytes`);

      return result;
    } catch (error) {
      console.error('❌ Image preprocessing failed:', error.message);
      console.log('   Using original image...');
      return imageBuffer;
    }
  }

  /**
   * Parse PaddleOCR response into structured format
   * @param {Array|Object} ocrResults - Raw OCR results from PaddleOCR
   * @returns {object} - Parsed OCR data
   */
  parseOCRResult(ocrResults) {
    // Handle new PaddleX format (object with rec_texts and rec_scores)
    if (ocrResults && typeof ocrResults === 'object' && !Array.isArray(ocrResults)) {
      const recTexts = ocrResults.rec_texts || [];
      const recScores = ocrResults.rec_scores || [];
      const recPolys = ocrResults.rec_polys || [];

      if (recTexts.length === 0) {
        return {
          fullText: '',
          lines: [],
          avgConfidence: 0,
          isHighConfidence: false
        };
      }

      const lines = [];
      let totalConfidence = 0;

      for (let i = 0; i < recTexts.length; i++) {
        const text = recTexts[i] || '';
        const confidence = recScores[i] || 0;
        const bbox = recPolys[i] || [];

        lines.push({
          text: text.trim(),
          confidence: confidence,
          bbox: bbox
        });

        totalConfidence += confidence;
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

    // Handle old format (array of arrays)
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