'use strict';

// Try to load OpenCV, fallback to Sharp if not available
let cv;

let useOpenCV = false;
try {
  cv = require('opencv4nodejs');
  useOpenCV = true;
} catch (error) {
  console.warn('⚠️ OpenCV not available for image quality analysis, using Sharp fallback');
  useOpenCV = false;
}

/**
 * Image Quality Assessment Utilities
 * Analyzes various aspects of image quality to determine optimal enhancement strategies
 */
class ImageQualityAnalyzer {
  constructor() {
    this.qualityThresholds = {
      blur: {
        sharp: 100,      // Laplacian variance threshold for sharp images
        acceptable: 50,   // Acceptable blur level
        blurry: 10       // Below this is considered blurry
      },
      contrast: {
        high: 0.8,       // High contrast threshold
        acceptable: 0.4,  // Acceptable contrast
        low: 0.2         // Low contrast threshold
      },
      brightness: {
        dark: 50,        // Dark image threshold
        optimal: 128,    // Optimal brightness
        bright: 200      // Bright image threshold
      },
      noise: {
        clean: 5,        // Clean image threshold
        acceptable: 15,   // Acceptable noise level
        noisy: 30        // High noise threshold
      },
      resolution: {
        low: 300000,     // Low resolution (pixels)
        medium: 1000000, // Medium resolution
        high: 2000000    // High resolution
      }
    };
  }

  /**
   * Comprehensive image quality analysis
   * @param {Buffer} imageBuffer - Image buffer
   * @returns {Promise<Object>} Quality analysis results
   */
  async analyzeQuality(imageBuffer) {
    try {
      const mat = cv.imdecode(imageBuffer);

      if (mat.empty) {
        throw new Error('Failed to decode image');
      }

      const analysis = {
        dimensions: {
          width: mat.cols,
          height: mat.rows,
          channels: mat.channels,
          totalPixels: mat.cols * mat.rows
        },
        blur: await this.assessBlur(mat),
        contrast: await this.assessContrast(mat),
        brightness: await this.assessBrightness(mat),
        noise: await this.assessNoise(mat),
        skew: await this.detectSkew(mat),
        lighting: await this.assessLighting(mat),
        textRegions: await this.detectTextRegions(mat),
        overallScore: 0,
        recommendedEnhancements: []
      };

      // Calculate overall quality score
      analysis.overallScore = this.calculateOverallScore(analysis);

      // Recommend enhancements
      analysis.recommendedEnhancements = this.recommendEnhancements(analysis);

      mat.release();
      return analysis;

    } catch (error) {
      console.error('Image quality analysis failed:', error.message);
      return {
        error: error.message,
        overallScore: 0,
        recommendedEnhancements: ['enhance_all']
      };
    }
  }

  /**
   * Assess image blur using Laplacian variance
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {Object} Blur assessment
   */
  async assessBlur(mat) {
    try {
      const gray = mat.channels === 3 ? mat.cvtColor(cv.COLOR_BGR2GRAY) : mat.clone();
      const laplacian = gray.laplacian(cv.CV_64F);
      const stats = laplacian.meanStdDev();
      const variance = Math.pow(stats.stddev[0], 2);

      gray.release();
      laplacian.release();

      let level;
      if (variance >= this.qualityThresholds.blur.sharp) {
        level = 'sharp';
      } else if (variance >= this.qualityThresholds.blur.acceptable) {
        level = 'acceptable';
      } else {
        level = 'blurry';
      }

      return {
        variance: Math.round(variance * 100) / 100,
        level: level,
        needsSharpening: variance < this.qualityThresholds.blur.acceptable
      };
    } catch (error) {
      console.error('Blur assessment failed:', error.message);
      return { variance: 0, level: 'unknown', needsSharpening: true };
    }
  }

  /**
   * Assess image contrast using standard deviation
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {Object} Contrast assessment
   */
  async assessContrast(mat) {
    try {
      const gray = mat.channels === 3 ? mat.cvtColor(cv.COLOR_BGR2GRAY) : mat.clone();
      const stats = gray.meanStdDev();
      const contrast = stats.stddev[0] / 255.0; // Normalize to 0-1

      gray.release();

      let level;
      if (contrast >= this.qualityThresholds.contrast.high) {
        level = 'high';
      } else if (contrast >= this.qualityThresholds.contrast.acceptable) {
        level = 'acceptable';
      } else {
        level = 'low';
      }

      return {
        value: Math.round(contrast * 1000) / 1000,
        level: level,
        needsEnhancement: contrast < this.qualityThresholds.contrast.acceptable
      };
    } catch (error) {
      console.error('Contrast assessment failed:', error.message);
      return { value: 0, level: 'unknown', needsEnhancement: true };
    }
  }

  /**
   * Assess image brightness
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {Object} Brightness assessment
   */
  async assessBrightness(mat) {
    try {
      const gray = mat.channels === 3 ? mat.cvtColor(cv.COLOR_BGR2GRAY) : mat.clone();
      const stats = gray.meanStdDev();
      const brightness = stats.mean[0];

      gray.release();

      let level;
      if (brightness < this.qualityThresholds.brightness.dark) {
        level = 'dark';
      } else if (brightness > this.qualityThresholds.brightness.bright) {
        level = 'bright';
      } else {
        level = 'optimal';
      }

      return {
        value: Math.round(brightness),
        level: level,
        needsAdjustment: level !== 'optimal'
      };
    } catch (error) {
      console.error('Brightness assessment failed:', error.message);
      return { value: 128, level: 'unknown', needsAdjustment: true };
    }
  }

  /**
   * Assess image noise using local standard deviation
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {Object} Noise assessment
   */
  async assessNoise(mat) {
    try {
      const gray = mat.channels === 3 ? mat.cvtColor(cv.COLOR_BGR2GRAY) : mat.clone();

      // Apply Gaussian blur and calculate difference
      const blurred = gray.gaussianBlur(new cv.Size(5, 5), 0);
      const noise = gray.absdiff(blurred);
      const stats = noise.meanStdDev();
      const noiseLevel = stats.mean[0];

      gray.release();
      blurred.release();
      noise.release();

      let level;
      if (noiseLevel <= this.qualityThresholds.noise.clean) {
        level = 'clean';
      } else if (noiseLevel <= this.qualityThresholds.noise.acceptable) {
        level = 'acceptable';
      } else {
        level = 'noisy';
      }

      return {
        value: Math.round(noiseLevel * 100) / 100,
        level: level,
        needsDenoising: noiseLevel > this.qualityThresholds.noise.acceptable
      };
    } catch (error) {
      console.error('Noise assessment failed:', error.message);
      return { value: 0, level: 'unknown', needsDenoising: true };
    }
  }

  /**
   * Detect image skew/rotation using Hough line detection
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {Object} Skew detection results
   */
  async detectSkew(mat) {
    try {
      const gray = mat.channels === 3 ? mat.cvtColor(cv.COLOR_BGR2GRAY) : mat.clone();

      // Edge detection
      const edges = gray.canny(50, 150);

      // Hough line detection
      const lines = edges.houghLines(1, Math.PI / 180, 100);

      if (!lines || lines.rows === 0) {
        gray.release();
        edges.release();
        return { angle: 0, needsCorrection: false };
      }

      // Calculate most common angle
      const angles = [];
      for (let i = 0; i < Math.min(lines.rows, 100); i++) {
        const rho = lines.at(i, 0);
        const theta = lines.at(i, 1);
        const angle = (theta * 180 / Math.PI) - 90;
        angles.push(angle);
      }

      // Find dominant angle
      const sortedAngles = angles.sort((a, b) => a - b);
      const medianAngle = sortedAngles[Math.floor(sortedAngles.length / 2)];

      gray.release();
      edges.release();

      const needsCorrection = Math.abs(medianAngle) > 2; // 2-degree threshold

      return {
        angle: Math.round(medianAngle * 100) / 100,
        needsCorrection: needsCorrection
      };
    } catch (error) {
      console.error('Skew detection failed:', error.message);
      return { angle: 0, needsCorrection: false };
    }
  }

  /**
   * Assess lighting uniformity
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {Object} Lighting assessment
   */
  async assessLighting(mat) {
    try {
      const gray = mat.channels === 3 ? mat.cvtColor(cv.COLOR_BGR2GRAY) : mat.clone();

      // Divide image into regions and analyze brightness variation
      const regions = 3;
      const regionWidth = Math.floor(gray.cols / regions);
      const regionHeight = Math.floor(gray.rows / regions);

      const brightnesses = [];

      for (let i = 0; i < regions; i++) {
        for (let j = 0; j < regions; j++) {
          const roi = gray.getRegion(new cv.Rect(
            i * regionWidth,
            j * regionHeight,
            regionWidth,
            regionHeight
          ));
          const stats = roi.meanStdDev();
          brightnesses.push(stats.mean[0]);
          roi.release();
        }
      }

      const mean = brightnesses.reduce((a, b) => a + b) / brightnesses.length;
      const variance = brightnesses.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / brightnesses.length;
      const standardDeviation = Math.sqrt(variance);

      gray.release();

      const isUniform = standardDeviation < 30; // Threshold for uniform lighting

      return {
        uniformity: Math.round((1 - standardDeviation / 100) * 1000) / 1000,
        isUniform: isUniform,
        needsCorrection: !isUniform
      };
    } catch (error) {
      console.error('Lighting assessment failed:', error.message);
      return { uniformity: 1, isUniform: true, needsCorrection: false };
    }
  }

  /**
   * Detect potential text regions using morphological operations
   * @param {cv.Mat} mat - OpenCV matrix
   * @returns {Object} Text region detection results
   */
  async detectTextRegions(mat) {
    try {
      const gray = mat.channels === 3 ? mat.cvtColor(cv.COLOR_BGR2GRAY) : mat.clone();

      // Morphological operations to detect text regions
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      const morph = gray.morphologyEx(cv.MORPH_GRADIENT, kernel);

      // Find contours
      const contours = morph.findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      // Filter contours that could be text
      const textRegions = contours.filter(contour => {
        const rect = contour.boundingRect();
        const area = rect.width * rect.height;
        const aspectRatio = rect.width / rect.height;

        return area > 100 && area < (mat.rows * mat.cols * 0.1) &&
               aspectRatio > 0.5 && aspectRatio < 10;
      });

      gray.release();
      morph.release();

      return {
        count: textRegions.length,
        coverage: textRegions.length > 0 ? Math.min(textRegions.length / 10, 1) : 0,
        hasText: textRegions.length > 0
      };
    } catch (error) {
      console.error('Text region detection failed:', error.message);
      return { count: 0, coverage: 0, hasText: false };
    }
  }

  /**
   * Calculate overall quality score (0-100)
   * @param {Object} analysis - Quality analysis results
   * @returns {number} Overall quality score
   */
  calculateOverallScore(analysis) {
    try {
      let score = 100;

      // Deduct points for poor quality aspects
      if (analysis.blur.level === 'blurry') score -= 30;
      else if (analysis.blur.level === 'acceptable') score -= 10;

      if (analysis.contrast.level === 'low') score -= 25;
      else if (analysis.contrast.level === 'acceptable') score -= 5;

      if (analysis.brightness.level !== 'optimal') score -= 15;

      if (analysis.noise.level === 'noisy') score -= 20;
      else if (analysis.noise.level === 'acceptable') score -= 5;

      if (analysis.skew.needsCorrection) score -= 10;

      if (analysis.lighting.needsCorrection) score -= 15;

      // Bonus for high resolution
      if (analysis.dimensions.totalPixels > this.qualityThresholds.resolution.high) {
        score += 5;
      } else if (analysis.dimensions.totalPixels < this.qualityThresholds.resolution.low) {
        score -= 10;
      }

      return Math.max(0, Math.min(100, Math.round(score)));
    } catch (error) {
      console.error('Score calculation failed:', error.message);
      return 50; // Default neutral score
    }
  }

  /**
   * Recommend enhancement techniques based on quality analysis
   * @param {Object} analysis - Quality analysis results
   * @returns {Array} Array of recommended enhancement techniques
   */
  recommendEnhancements(analysis) {
    const recommendations = [];

    try {
      if (analysis.blur.needsSharpening) {
        recommendations.push('sharpen');
      }

      if (analysis.contrast.needsEnhancement) {
        recommendations.push('enhance_contrast');
      }

      if (analysis.brightness.needsAdjustment) {
        recommendations.push('adjust_brightness');
      }

      if (analysis.noise.needsDenoising) {
        recommendations.push('denoise');
      }

      if (analysis.skew.needsCorrection) {
        recommendations.push('deskew');
      }

      if (analysis.lighting.needsCorrection) {
        recommendations.push('correct_lighting');
      }

      // Resolution-based recommendations
      if (analysis.dimensions.totalPixels < this.qualityThresholds.resolution.low) {
        recommendations.push('upscale');
      }

      // If no specific issues, apply gentle enhancement
      if (recommendations.length === 0) {
        recommendations.push('gentle_enhance');
      }

      return recommendations;
    } catch (error) {
      console.error('Enhancement recommendation failed:', error.message);
      return ['enhance_all'];
    }
  }
}

// Export the appropriate analyzer based on OpenCV availability
if (useOpenCV) {
  module.exports = ImageQualityAnalyzer;
} else {
  const FallbackAnalyzer = require('./image-quality-fallback');
  module.exports = FallbackAnalyzer;
}