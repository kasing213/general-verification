'use strict';

// Try to load OpenCV, fallback to Sharp+Jimp if not available
let cv;
let useOpenCV = false;

try {
  cv = require('opencv4nodejs');
  useOpenCV = true;
  console.log('✅ OpenCV loaded successfully');
} catch (error) {
  console.warn('⚠️ OpenCV not available, using Sharp+Jimp fallback:', error.message);
  useOpenCV = false;
}

const sharp = require('sharp');
const ImageQualityAnalyzer = require('../utils/image-quality');

/**
 * Advanced Image Enhancement Service
 * Applies OpenCV-based enhancements to improve OCR accuracy
 */
class ImageEnhancerService {
  constructor() {
    this.qualityAnalyzer = new ImageQualityAnalyzer();

    // Enhancement configuration
    this.config = {
      autoEnhance: process.env.AUTO_ENHANCE_IMAGES === 'true' || true,
      deskew: process.env.ENABLE_DESKEW === 'true' || true,
      denoise: process.env.DENOISE_METHOD || 'bilateral', // bilateral, nlm, fastNlMeans
      sharpen: process.env.SHARPEN_METHOD || 'unsharp', // unsharp, laplacian, kernel
      contrast: process.env.CONTRAST_METHOD || 'clahe', // clahe, histogram, adaptive
      superResolution: process.env.ENABLE_SUPER_RESOLUTION === 'true' || false,
      textDetection: process.env.TEXT_DETECTION_METHOD || 'morphological',
      qualityThreshold: parseInt(process.env.ENHANCEMENT_QUALITY_THRESHOLD) || 70,
      maxProcessingTime: parseInt(process.env.MAX_ENHANCEMENT_TIME_MS) || 10000
    };

    console.log('ImageEnhancer initialized with config:', this.config);
  }

  /**
   * Main enhancement pipeline
   * @param {Buffer} imageBuffer - Original image buffer
   * @param {Object} options - Enhancement options
   * @returns {Promise<Object>} Enhancement result with processed image and metadata
   */
  async enhanceImage(imageBuffer, options = {}) {
    const startTime = Date.now();

    try {
      console.log('🎨 Starting image enhancement pipeline...');

      // Step 1: Quality analysis
      const qualityAnalysis = await this.qualityAnalyzer.analyzeQuality(imageBuffer);
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

      // Step 3: Load image into OpenCV
      let mat = cv.imdecode(imageBuffer);

      if (mat.empty) {
        throw new Error('Failed to decode image for enhancement');
      }

      console.log(`📸 Original image: ${mat.cols}x${mat.rows}, channels: ${mat.channels}`);

      // Step 4: Apply enhancements based on recommendations
      const enhancementsApplied = [];
      const recommendations = qualityAnalysis.recommendedEnhancements || ['gentle_enhance'];

      for (const enhancement of recommendations) {
        try {
          mat = await this.applyEnhancement(mat, enhancement, qualityAnalysis);
          enhancementsApplied.push(enhancement);
        } catch (error) {
          console.warn(`⚠️ Enhancement '${enhancement}' failed:`, error.message);
        }
      }

      // Step 5: Final optimization
      if (this.config.autoEnhance) {
        mat = await this.applyFinalOptimizations(mat);
        enhancementsApplied.push('final_optimization');
      }

      // Step 6: Convert back to buffer
      const enhancedBuffer = cv.imencode('.jpg', mat, [cv.IMWRITE_JPEG_QUALITY, 95]);
      mat.release();

      const processingTime = Date.now() - startTime;
      console.log(`✅ Enhancement completed in ${processingTime}ms`);

      return {
        enhanced: true,
        originalBuffer: imageBuffer,
        enhancedBuffer: enhancedBuffer,
        qualityAnalysis: qualityAnalysis,
        processingTime: processingTime,
        enhancementsApplied: enhancementsApplied
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
   * Apply specific enhancement technique
   * @param {cv.Mat} mat - OpenCV matrix
   * @param {string} enhancement - Enhancement type
   * @param {Object} qualityAnalysis - Quality analysis results
   * @returns {Promise<cv.Mat>} Enhanced matrix
   */
  async applyEnhancement(mat, enhancement, qualityAnalysis) {
    console.log(`🔧 Applying enhancement: ${enhancement}`);

    switch (enhancement) {
      case 'sharpen':
        return this.applySharpen(mat);

      case 'enhance_contrast':
        return this.enhanceContrast(mat);

      case 'adjust_brightness':
        return this.adjustBrightness(mat, qualityAnalysis.brightness);

      case 'denoise':
        return this.applyDenoising(mat);

      case 'deskew':
        return this.correctSkew(mat, qualityAnalysis.skew);

      case 'correct_lighting':
        return this.correctLighting(mat);

      case 'upscale':
        return this.upscaleImage(mat);

      case 'gentle_enhance':
        return this.applyGentleEnhancement(mat);

      case 'enhance_all':
        return this.applyComprehensiveEnhancement(mat);

      default:
        console.warn(`Unknown enhancement type: ${enhancement}`);
        return mat;
    }
  }

  /**
   * Apply image sharpening
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {cv.Mat} Sharpened image
   */
  applySharpen(mat) {
    try {
      if (this.config.sharpen === 'unsharp') {
        // Unsharp masking
        const blurred = mat.gaussianBlur(new cv.Size(0, 0), 1.0);
        const sharpened = mat.addWeighted(1.5, blurred, -0.5, 0);
        blurred.release();
        return sharpened;
      } else if (this.config.sharpen === 'laplacian') {
        // Laplacian sharpening
        const kernel = new cv.Mat(3, 3, cv.CV_32F, [0, -1, 0, -1, 5, -1, 0, -1, 0]);
        const sharpened = mat.filter2D(cv.CV_8U, kernel);
        kernel.release();
        return sharpened;
      } else {
        // Custom sharpening kernel
        const kernel = new cv.Mat(3, 3, cv.CV_32F, [-1, -1, -1, -1, 9, -1, -1, -1, -1]);
        const sharpened = mat.filter2D(cv.CV_8U, kernel);
        kernel.release();
        return sharpened;
      }
    } catch (error) {
      console.error('Sharpening failed:', error.message);
      return mat.clone();
    }
  }

  /**
   * Enhance image contrast
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {cv.Mat} Contrast enhanced image
   */
  enhanceContrast(mat) {
    try {
      if (this.config.contrast === 'clahe') {
        // CLAHE (Contrast Limited Adaptive Histogram Equalization)
        const gray = mat.channels === 3 ? mat.cvtColor(cv.COLOR_BGR2GRAY) : mat.clone();
        const clahe = new cv.CLAHE(3.0, new cv.Size(8, 8));
        const enhanced = clahe.apply(gray);

        if (mat.channels === 3) {
          // Convert back to color
          const result = enhanced.cvtColor(cv.COLOR_GRAY2BGR);
          gray.release();
          enhanced.release();
          return result;
        } else {
          gray.release();
          return enhanced;
        }
      } else if (this.config.contrast === 'histogram') {
        // Histogram equalization
        const gray = mat.channels === 3 ? mat.cvtColor(cv.COLOR_BGR2GRAY) : mat.clone();
        const equalized = gray.equalizeHist();

        if (mat.channels === 3) {
          const result = equalized.cvtColor(cv.COLOR_GRAY2BGR);
          gray.release();
          equalized.release();
          return result;
        } else {
          gray.release();
          return equalized;
        }
      } else {
        // Simple contrast stretching
        const alpha = 1.5; // Contrast control
        const beta = 0;    // Brightness control
        return mat.convertScaleAbs(alpha, beta);
      }
    } catch (error) {
      console.error('Contrast enhancement failed:', error.message);
      return mat.clone();
    }
  }

  /**
   * Adjust image brightness
   * @param {cv.Mat} mat - OpenCV matrix
   * @param {Object} brightnessInfo - Brightness analysis
   * @returns {cv.Mat} Brightness adjusted image
   */
  adjustBrightness(mat, brightnessInfo) {
    try {
      let beta = 0; // Brightness adjustment

      if (brightnessInfo.level === 'dark') {
        beta = 30; // Brighten dark images
      } else if (brightnessInfo.level === 'bright') {
        beta = -20; // Darken bright images
      }

      if (beta !== 0) {
        return mat.convertScaleAbs(1.0, beta);
      }

      return mat.clone();
    } catch (error) {
      console.error('Brightness adjustment failed:', error.message);
      return mat.clone();
    }
  }

  /**
   * Apply denoising
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {cv.Mat} Denoised image
   */
  applyDenoising(mat) {
    try {
      if (this.config.denoise === 'bilateral') {
        // Bilateral filtering preserves edges
        return mat.bilateralFilter(9, 75, 75);
      } else if (this.config.denoise === 'nlm') {
        // Non-local means denoising
        if (mat.channels === 3) {
          return mat.fastNlMeansDenoisingColored(3, 3, 7, 21);
        } else {
          return mat.fastNlMeansDenoising(3, 7, 21);
        }
      } else {
        // Gaussian blur for simple denoising
        return mat.gaussianBlur(new cv.Size(3, 3), 0);
      }
    } catch (error) {
      console.error('Denoising failed:', error.message);
      return mat.clone();
    }
  }

  /**
   * Correct image skew/rotation
   * @param {cv.Mat} mat - OpenCV matrix
   * @param {Object} skewInfo - Skew analysis
   * @returns {cv.Mat} Deskewed image
   */
  correctSkew(mat, skewInfo) {
    try {
      if (!skewInfo.needsCorrection || Math.abs(skewInfo.angle) < 1) {
        return mat.clone();
      }

      // Calculate rotation matrix
      const center = new cv.Point2(mat.cols / 2, mat.rows / 2);
      const rotationMatrix = cv.getRotationMatrix2D(center, -skewInfo.angle, 1.0);

      // Apply rotation
      const corrected = mat.warpAffine(rotationMatrix, new cv.Size(mat.cols, mat.rows), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

      console.log(`📐 Corrected skew by ${skewInfo.angle.toFixed(2)}°`);
      return corrected;
    } catch (error) {
      console.error('Skew correction failed:', error.message);
      return mat.clone();
    }
  }

  /**
   * Correct uneven lighting
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {cv.Mat} Lighting corrected image
   */
  correctLighting(mat) {
    try {
      const gray = mat.channels === 3 ? mat.cvtColor(cv.COLOR_BGR2GRAY) : mat.clone();

      // Create background estimation using morphological operations
      const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(15, 15));
      const background = gray.morphologyEx(cv.MORPH_DILATE, kernel);

      // Subtract background
      const corrected = gray.divide(background).convertScaleAbs(255);

      gray.release();
      background.release();

      if (mat.channels === 3) {
        const result = corrected.cvtColor(cv.COLOR_GRAY2BGR);
        corrected.release();
        return result;
      } else {
        return corrected;
      }
    } catch (error) {
      console.error('Lighting correction failed:', error.message);
      return mat.clone();
    }
  }

  /**
   * Upscale image for better OCR
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {cv.Mat} Upscaled image
   */
  upscaleImage(mat) {
    try {
      const scaleFactor = 2.0;
      const newSize = new cv.Size(mat.cols * scaleFactor, mat.rows * scaleFactor);

      // Use bicubic interpolation for upscaling
      const upscaled = mat.resize(newSize.height, newSize.width, 0, 0, cv.INTER_CUBIC);

      console.log(`📈 Upscaled image from ${mat.cols}x${mat.rows} to ${upscaled.cols}x${upscaled.rows}`);
      return upscaled;
    } catch (error) {
      console.error('Upscaling failed:', error.message);
      return mat.clone();
    }
  }

  /**
   * Apply gentle enhancement for high-quality images
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {cv.Mat} Gently enhanced image
   */
  applyGentleEnhancement(mat) {
    try {
      // Light sharpening
      const kernel = new cv.Mat(3, 3, cv.CV_32F, [0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0]);
      const sharpened = mat.filter2D(cv.CV_8U, kernel);
      kernel.release();

      // Gentle contrast enhancement
      const enhanced = sharpened.convertScaleAbs(1.1, 5);
      sharpened.release();

      return enhanced;
    } catch (error) {
      console.error('Gentle enhancement failed:', error.message);
      return mat.clone();
    }
  }

  /**
   * Apply comprehensive enhancement for poor quality images
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {cv.Mat} Comprehensively enhanced image
   */
  applyComprehensiveEnhancement(mat) {
    try {
      let enhanced = mat.clone();

      // 1. Denoising
      const denoised = enhanced.bilateralFilter(9, 75, 75);
      enhanced.release();
      enhanced = denoised;

      // 2. Contrast enhancement
      const gray = enhanced.channels === 3 ? enhanced.cvtColor(cv.COLOR_BGR2GRAY) : enhanced.clone();
      const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
      const contrasted = clahe.apply(gray);

      if (enhanced.channels === 3) {
        enhanced.release();
        enhanced = contrasted.cvtColor(cv.COLOR_GRAY2BGR);
        contrasted.release();
      } else {
        enhanced.release();
        enhanced = contrasted;
      }

      gray.release();

      // 3. Sharpening
      const kernel = new cv.Mat(3, 3, cv.CV_32F, [-1, -1, -1, -1, 9, -1, -1, -1, -1]);
      const sharpened = enhanced.filter2D(cv.CV_8U, kernel);
      kernel.release();
      enhanced.release();

      return sharpened;
    } catch (error) {
      console.error('Comprehensive enhancement failed:', error.message);
      return mat.clone();
    }
  }

  /**
   * Apply final optimizations
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {cv.Mat} Optimized image
   */
  applyFinalOptimizations(mat) {
    try {
      // Ensure optimal size for OCR (around 1200-1600px width)
      const targetWidth = 1400;

      if (mat.cols < targetWidth * 0.8) {
        // Upscale small images
        const scaleFactor = targetWidth / mat.cols;
        const newSize = new cv.Size(targetWidth, Math.round(mat.rows * scaleFactor));
        const resized = mat.resize(newSize.height, newSize.width, 0, 0, cv.INTER_CUBIC);
        return resized;
      } else if (mat.cols > targetWidth * 1.5) {
        // Downscale very large images
        const scaleFactor = targetWidth / mat.cols;
        const newSize = new cv.Size(targetWidth, Math.round(mat.rows * scaleFactor));
        const resized = mat.resize(newSize.height, newSize.width, 0, 0, cv.INTER_AREA);
        return resized;
      }

      return mat.clone();
    } catch (error) {
      console.error('Final optimization failed:', error.message);
      return mat.clone();
    }
  }

  /**
   * Get enhancement service status
   * @returns {Object} Service status
   */
  getStatus() {
    return {
      enabled: true,
      config: this.config,
      openCVVersion: cv.version
    };
  }
}

// Export the appropriate enhancer based on OpenCV availability
if (useOpenCV) {
  module.exports = ImageEnhancerService;
} else {
  const FallbackEnhancer = require('./image-enhancer-fallback');
  module.exports = FallbackEnhancer;
}