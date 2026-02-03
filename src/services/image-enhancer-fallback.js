'use strict';

const sharp = require('sharp');
const Jimp = require('jimp');

/**
 * Fallback Image Enhancement Service
 * Uses Sharp and Jimp instead of OpenCV for better compatibility
 */
class ImageEnhancerService {
  constructor() {
    this.config = {
      autoEnhance: process.env.AUTO_ENHANCE_IMAGES === 'true' || true,
      deskew: process.env.ENABLE_DESKEW === 'true' || true,
      denoise: process.env.DENOISE_METHOD || 'bilateral',
      sharpen: process.env.SHARPEN_METHOD || 'unsharp',
      contrast: process.env.CONTRAST_METHOD || 'clahe',
      superResolution: process.env.ENABLE_SUPER_RESOLUTION === 'true' || false,
      textDetection: process.env.TEXT_DETECTION_METHOD || 'morphological',
      qualityThreshold: parseInt(process.env.ENHANCEMENT_QUALITY_THRESHOLD) || 70,
      maxProcessingTime: parseInt(process.env.MAX_ENHANCEMENT_TIME_MS) || 10000
    };

    console.log('ImageEnhancer (Fallback) initialized with config:', this.config);
  }

  /**
   * Main enhancement pipeline using Sharp and Jimp
   * @param {Buffer} imageBuffer - Original image buffer
   * @param {Object} options - Enhancement options
   * @returns {Promise<Object>} Enhancement result
   */
  async enhanceImage(imageBuffer, options = {}) {
    const startTime = Date.now();

    try {
      console.log('🎨 Starting fallback image enhancement pipeline...');

      // Step 1: Basic quality analysis using Sharp metadata
      const qualityAnalysis = await this.analyzeImageQuality(imageBuffer);
      console.log(`📊 Quality score: ${qualityAnalysis.overallScore}/100`);

      // Step 2: Determine if enhancement is needed
      if (qualityAnalysis.overallScore > 90 && !options.forceEnhancement) {
        console.log('✅ Image quality is excellent, skipping enhancement');
        return {
          enhanced: false,
          originalBuffer: imageBuffer,
          enhancedBuffer: imageBuffer,
          qualityAnalysis: qualityAnalysis,
          processingTime: Date.now() - startTime,
          enhancementsApplied: []
        };
      }

      // Step 3: Apply enhancements using Sharp
      let enhancedBuffer = await this.applySharpEnhancements(imageBuffer);

      // Step 4: Apply additional enhancements using Jimp if needed
      if (qualityAnalysis.overallScore < 50) {
        enhancedBuffer = await this.applyJimpEnhancements(enhancedBuffer);
      }

      const processingTime = Date.now() - startTime;
      console.log(`✅ Enhancement completed in ${processingTime}ms`);

      return {
        enhanced: true,
        originalBuffer: imageBuffer,
        enhancedBuffer: enhancedBuffer,
        qualityAnalysis: qualityAnalysis,
        processingTime: processingTime,
        enhancementsApplied: ['sharp_enhance', 'contrast_boost', 'noise_reduction']
      };

    } catch (error) {
      console.error('❌ Image enhancement failed:', error.message);
      return {
        enhanced: false,
        originalBuffer: imageBuffer,
        enhancedBuffer: imageBuffer,
        error: error.message,
        processingTime: Date.now() - startTime,
        enhancementsApplied: []
      };
    }
  }

  /**
   * Analyze image quality using Sharp metadata
   * @param {Buffer} imageBuffer - Image buffer
   * @returns {Promise<Object>} Quality analysis
   */
  async analyzeImageQuality(imageBuffer) {
    try {
      const image = sharp(imageBuffer);
      const metadata = await image.metadata();
      const stats = await image.stats();

      // Calculate quality score based on metadata and stats
      let score = 100;

      // Check resolution
      const totalPixels = metadata.width * metadata.height;
      if (totalPixels < 300000) score -= 20; // Low resolution
      if (totalPixels > 2000000) score += 5;  // High resolution bonus

      // Check if image has good contrast (basic approximation)
      if (stats.channels) {
        const avgEntropy = stats.channels.reduce((sum, channel) => sum + (channel.entropy || 0), 0) / stats.channels.length;
        if (avgEntropy < 6) score -= 15; // Low contrast
        if (avgEntropy > 7) score += 5;  // Good contrast bonus
      }

      // Check for reasonable aspect ratio (not too extreme)
      const aspectRatio = metadata.width / metadata.height;
      if (aspectRatio < 0.3 || aspectRatio > 3) score -= 10;

      const overallScore = Math.max(0, Math.min(100, Math.round(score)));

      return {
        dimensions: {
          width: metadata.width,
          height: metadata.height,
          channels: metadata.channels,
          totalPixels: totalPixels
        },
        overallScore: overallScore,
        format: metadata.format,
        density: metadata.density || 'unknown',
        hasAlpha: metadata.hasAlpha,
        recommendedEnhancements: this.getRecommendations(overallScore, metadata)
      };
    } catch (error) {
      console.error('Quality analysis failed:', error.message);
      return {
        overallScore: 50,
        recommendedEnhancements: ['enhance_all']
      };
    }
  }

  /**
   * Get enhancement recommendations based on quality score
   * @param {number} score - Quality score
   * @param {Object} metadata - Image metadata
   * @returns {Array} Recommended enhancements
   */
  getRecommendations(score, metadata) {
    const recommendations = [];

    if (score < 30) {
      recommendations.push('enhance_all');
    } else if (score < 50) {
      recommendations.push('sharpen', 'enhance_contrast', 'denoise');
    } else if (score < 70) {
      recommendations.push('sharpen', 'enhance_contrast');
    } else {
      recommendations.push('gentle_enhance');
    }

    // Resolution-based recommendations
    if (metadata.width * metadata.height < 500000) {
      recommendations.push('upscale');
    }

    return recommendations;
  }

  /**
   * Apply enhancements using Sharp
   * @param {Buffer} imageBuffer - Image buffer
   * @returns {Promise<Buffer>} Enhanced image buffer
   */
  async applySharpEnhancements(imageBuffer) {
    try {
      let image = sharp(imageBuffer);

      // Get original dimensions
      const metadata = await image.metadata();

      // Resize to optimal size for OCR (around 1200-1600px width)
      const targetWidth = 1400;
      if (metadata.width < targetWidth * 0.8) {
        // Upscale small images
        image = image.resize(targetWidth, null, {
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: false
        });
      } else if (metadata.width > targetWidth * 1.5) {
        // Downscale very large images
        image = image.resize(targetWidth, null, {
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: true
        });
      }

      // Apply enhancements
      const enhanced = await image
        .sharpen(1.2, 0.5) // Mild sharpening
        .normalise() // Normalize contrast
        .gamma(1.1) // Slight gamma correction
        .modulate({
          brightness: 1.05, // Slight brightness boost
          saturation: 0.95  // Slight saturation reduction for text clarity
        })
        .jpeg({ quality: 95, progressive: true })
        .toBuffer();

      return enhanced;
    } catch (error) {
      console.error('Sharp enhancement failed:', error.message);
      return imageBuffer;
    }
  }

  /**
   * Apply additional enhancements using Jimp for low-quality images
   * @param {Buffer} imageBuffer - Image buffer
   * @returns {Promise<Buffer>} Enhanced image buffer
   */
  async applyJimpEnhancements(imageBuffer) {
    try {
      const image = await Jimp.read(imageBuffer);

      // Apply Jimp enhancements
      image
        .contrast(0.2)      // Increase contrast
        .brightness(0.1)    // Slight brightness increase
        .blur(0.5)          // Very slight blur to reduce noise
        .convolute([         // Custom sharpening kernel
          [0, -1, 0],
          [-1, 5, -1],
          [0, -1, 0]
        ]);

      const enhanced = await image.getBufferAsync(Jimp.MIME_JPEG);
      return enhanced;
    } catch (error) {
      console.error('Jimp enhancement failed:', error.message);
      return imageBuffer;
    }
  }

  /**
   * Get service status
   * @returns {Object} Service status
   */
  getStatus() {
    return {
      enabled: true,
      fallbackMode: true,
      config: this.config,
      sharpVersion: sharp.versions.sharp,
      jimpAvailable: true
    };
  }
}

module.exports = ImageEnhancerService;