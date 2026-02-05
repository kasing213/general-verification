'use strict';

const sharp = require('sharp');
const Jimp = require('jimp');

/**
 * Enhanced Image Processor for Multi-OCR Pipeline
 * Provides various preprocessing techniques optimized for different OCR engines
 */
class EnhancedImageProcessor {
  constructor() {
    this.config = {
      // Standard sizes for different engines
      tesseractOptimal: { width: 1200, height: 1600 },
      easyocrOptimal: { width: 1024, height: 1024 },
      templateSize: { width: 800, height: 1200 },

      // Quality thresholds
      minDPI: 150,
      maxFileSize: 5 * 1024 * 1024, // 5MB

      // Enhancement parameters
      contrastBoost: 1.2,
      sharpness: 1.5,
      gammaCorrection: 1.1
    };
  }

  /**
   * Main preprocessing pipeline - creates multiple optimized versions
   * @param {Buffer} imageBuffer - Original image
   * @returns {Promise<Object>} - Multiple processed versions
   */
  async processForMultiOCR(imageBuffer) {
    const startTime = Date.now();

    try {
      console.log('🎨 Starting enhanced image processing pipeline...');

      // Analyze original image
      const analysis = await this.analyzeImage(imageBuffer);
      console.log(`📊 Image analysis: ${analysis.width}x${analysis.height}, quality: ${analysis.qualityScore}`);

      // Create base enhanced version
      const baseEnhanced = await this.createBaseEnhancement(imageBuffer, analysis);

      // Create engine-specific versions in parallel
      const [tesseractVersion, easyocrVersion, templateVersion, originalClean] = await Promise.all([
        this.optimizeForTesseract(baseEnhanced),
        this.optimizeForEasyOCR(baseEnhanced),
        this.optimizeForTemplate(baseEnhanced),
        this.cleanOriginal(imageBuffer)
      ]);

      const processingTime = Date.now() - startTime;
      console.log(`✅ Multi-OCR preprocessing complete in ${processingTime}ms`);

      return {
        original: originalClean,
        tesseract: tesseractVersion,
        easyocr: easyocrVersion,
        template: templateVersion,
        base: baseEnhanced,
        analysis: analysis,
        processingTime: processingTime
      };

    } catch (error) {
      console.error('❌ Image processing failed:', error.message);
      // Return original as fallback
      return {
        original: imageBuffer,
        tesseract: imageBuffer,
        easyocr: imageBuffer,
        template: imageBuffer,
        base: imageBuffer,
        analysis: { error: error.message },
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Analyze image characteristics
   * @param {Buffer} imageBuffer
   * @returns {Promise<Object>}
   */
  async analyzeImage(imageBuffer) {
    const metadata = await sharp(imageBuffer).metadata();

    // Calculate quality score based on various factors
    let qualityScore = 50; // Base score

    // Size factor (prefer higher resolution)
    const totalPixels = metadata.width * metadata.height;
    if (totalPixels > 1000000) qualityScore += 20;
    else if (totalPixels > 500000) qualityScore += 10;

    // Density factor
    if (metadata.density >= 300) qualityScore += 20;
    else if (metadata.density >= 150) qualityScore += 10;

    // Format factor
    if (metadata.format === 'jpeg') qualityScore += 5;
    else if (metadata.format === 'png') qualityScore += 10;

    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      density: metadata.density || 72,
      channels: metadata.channels,
      hasAlpha: metadata.hasAlpha,
      qualityScore: Math.min(qualityScore, 100),
      aspectRatio: metadata.width / metadata.height,
      isLandscape: metadata.width > metadata.height,
      totalPixels: totalPixels
    };
  }

  /**
   * Create base enhanced version with general improvements
   * @param {Buffer} imageBuffer
   * @param {Object} analysis
   * @returns {Promise<Buffer>}
   */
  async createBaseEnhancement(imageBuffer, analysis) {
    let processor = sharp(imageBuffer);

    // Auto-rotate if needed
    processor = processor.rotate();

    // Resize if too large or too small
    if (analysis.width > 3000 || analysis.height > 3000 || analysis.totalPixels < 200000) {
      processor = processor.resize({
        width: Math.min(analysis.width, 2000),
        height: Math.min(analysis.height, 2000),
        fit: 'inside',
        withoutEnlargement: analysis.totalPixels > 200000
      });
    }

    // Apply general enhancements
    processor = processor
      .sharpen({ sigma: 1, m1: 1, m2: 2 }) // Mild sharpening
      .gamma(this.config.gammaCorrection) // Brightness correction
      .normalise() // Auto-contrast
      .jpeg({ quality: 95, progressive: true });

    return await processor.toBuffer();
  }

  /**
   * Optimize image specifically for Tesseract OCR
   * @param {Buffer} imageBuffer
   * @returns {Promise<Buffer>}
   */
  async optimizeForTesseract(imageBuffer) {
    return await sharp(imageBuffer)
      .resize(this.config.tesseractOptimal.width, this.config.tesseractOptimal.height, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .sharpen({ sigma: 1.5, m1: 1, m2: 3 }) // Stronger sharpening for Tesseract
      .gamma(1.2)
      .linear(this.config.contrastBoost, -(128 * this.config.contrastBoost) + 128) // Contrast boost
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  /**
   * Optimize image specifically for EasyOCR
   * @param {Buffer} imageBuffer
   * @returns {Promise<Buffer>}
   */
  async optimizeForEasyOCR(imageBuffer) {
    return await sharp(imageBuffer)
      .resize(this.config.easyocrOptimal.width, this.config.easyocrOptimal.height, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .sharpen({ sigma: 1, m1: 1, m2: 1.5 }) // Gentler sharpening for EasyOCR
      .gamma(1.1)
      .modulate({ brightness: 1.05, saturation: 0.9 }) // Slight brightness boost, reduce saturation
      .jpeg({ quality: 92 })
      .toBuffer();
  }

  /**
   * Optimize image for template matching
   * @param {Buffer} imageBuffer
   * @returns {Promise<Buffer>}
   */
  async optimizeForTemplate(imageBuffer) {
    return await sharp(imageBuffer)
      .resize(this.config.templateSize.width, this.config.templateSize.height, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .sharpen({ sigma: 0.5, m1: 1, m2: 1 }) // Minimal sharpening to preserve structure
      .gamma(1.0) // No gamma correction for template matching
      .jpeg({ quality: 85 })
      .toBuffer();
  }

  /**
   * Clean original image without major modifications
   * @param {Buffer} imageBuffer
   * @returns {Promise<Buffer>}
   */
  async cleanOriginal(imageBuffer) {
    return await sharp(imageBuffer)
      .rotate() // Auto-rotate only
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  /**
   * Create high-contrast version for difficult text
   * @param {Buffer} imageBuffer
   * @returns {Promise<Buffer>}
   */
  async createHighContrast(imageBuffer) {
    return await sharp(imageBuffer)
      .gamma(0.8) // Darken
      .linear(2.0, -128) // High contrast
      .sharpen({ sigma: 2, m1: 1, m2: 4 }) // Heavy sharpening
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  /**
   * Create grayscale version
   * @param {Buffer} imageBuffer
   * @returns {Promise<Buffer>}
   */
  async createGrayscale(imageBuffer) {
    return await sharp(imageBuffer)
      .grayscale()
      .sharpen()
      .normalise()
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  /**
   * Advanced preprocessing with Jimp for specialized operations
   * @param {Buffer} imageBuffer
   * @returns {Promise<Buffer>}
   */
  async advancedPreprocessing(imageBuffer) {
    try {
      const image = await Jimp.read(imageBuffer);

      // Apply advanced filters
      image
        .contrast(0.3) // Increase contrast
        .brightness(0.1) // Slight brightness increase
        .normalize() // Auto-levels
        .quality(95);

      return await image.getBufferAsync(Jimp.MIME_JPEG);
    } catch (error) {
      console.warn('Advanced preprocessing failed, returning original');
      return imageBuffer;
    }
  }

  /**
   * Detect if image contains text regions
   * @param {Buffer} imageBuffer
   * @returns {Promise<Object>}
   */
  async detectTextRegions(imageBuffer) {
    try {
      // Create edge detection version
      const edges = await sharp(imageBuffer)
        .grayscale()
        .normalise()
        .convolve({
          width: 3,
          height: 3,
          kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1]
        })
        .threshold(128)
        .toBuffer();

      // Analyze edge density to find text regions
      const { data } = await sharp(edges).raw().toBuffer({ resolveWithObject: true });

      let edgePixels = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] > 200) edgePixels++;
      }

      const edgeDensity = edgePixels / data.length;

      return {
        hasText: edgeDensity > 0.1,
        edgeDensity: edgeDensity,
        confidence: Math.min(edgeDensity * 5, 1.0)
      };

    } catch (error) {
      return { hasText: true, edgeDensity: 0.5, confidence: 0.5 };
    }
  }

  /**
   * Get recommended OCR engines based on image characteristics
   * @param {Object} analysis
   * @returns {Array}
   */
  getRecommendedEngines(analysis) {
    const recommendations = [];

    // High quality images - try EasyOCR first
    if (analysis.qualityScore > 70) {
      recommendations.push('easyocr', 'tesseract');
    } else {
      // Lower quality - Tesseract might work better
      recommendations.push('tesseract', 'easyocr');
    }

    // Always try template matching for banking apps
    if (analysis.aspectRatio > 0.4 && analysis.aspectRatio < 0.8) { // Portrait aspect typical for mobile apps
      recommendations.unshift('template');
    }

    return recommendations;
  }
}

module.exports = EnhancedImageProcessor;