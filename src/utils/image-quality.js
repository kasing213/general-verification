'use strict';

// Try to load OpenCV, fallback to Sharp if not available
let cv;
const sharp = require('sharp');

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
    if (!useOpenCV) {
      return this._analyzeQualitySharp(imageBuffer);
    }

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
        recommendedEnhancements: ['enhance_all'],
        dimensions: { width: 0, height: 0, channels: 0, totalPixels: 0 },
        blur: { variance: 0, level: 'unknown', needsSharpening: true },
        contrast: { value: 0, level: 'unknown', needsEnhancement: true },
        brightness: { value: 128, level: 'unknown', needsAdjustment: true },
        noise: { value: 0, level: 'unknown', needsDenoising: true },
        skew: { angle: 0, needsCorrection: false },
        lighting: { uniformity: 1, isUniform: true, needsCorrection: false },
        textRegions: { count: 0, coverage: 0, hasText: false }
      };
    }
  }

  /**
   * Analyze image quality using Sharp (fallback path)
   * @param {Buffer} imageBuffer - Image buffer
   * @returns {Promise<Object>} Quality analysis results
   */
  async _analyzeQualitySharp(imageBuffer) {
    try {
      const image = sharp(imageBuffer);
      const metadata = await image.metadata();
      const stats = await image.stats();

      const analysis = {
        dimensions: {
          width: metadata.width,
          height: metadata.height,
          channels: metadata.channels,
          totalPixels: metadata.width * metadata.height
        },
        blur: this.assessBlurFromStats(stats, metadata),
        contrast: this.assessContrastFromStats(stats),
        brightness: this.assessBrightnessFromStats(stats),
        noise: this.assessNoiseFromStats(stats),
        skew: { angle: 0, needsCorrection: false }, // Not detectable with Sharp alone
        lighting: this.assessLightingFromStats(stats),
        textRegions: { count: 0, coverage: 0, hasText: false }, // Not detectable with Sharp alone
        overallScore: 0,
        recommendedEnhancements: []
      };

      // Calculate overall quality score
      analysis.overallScore = this.calculateOverallScore(analysis);

      // Recommend enhancements
      analysis.recommendedEnhancements = this.recommendEnhancements(analysis);

      return analysis;

    } catch (error) {
      console.error('Image quality analysis failed:', error.message);
      return {
        error: error.message,
        overallScore: 0,
        recommendedEnhancements: ['enhance_all'],
        dimensions: { width: 0, height: 0, channels: 0, totalPixels: 0 },
        blur: { variance: 0, level: 'unknown', needsSharpening: true },
        contrast: { value: 0, level: 'unknown', needsEnhancement: true },
        brightness: { value: 128, level: 'unknown', needsAdjustment: true },
        noise: { value: 0, level: 'unknown', needsDenoising: true },
        skew: { angle: 0, needsCorrection: false },
        lighting: { uniformity: 1, isUniform: true, needsCorrection: false },
        textRegions: { count: 0, coverage: 0, hasText: false }
      };
    }
  }

  /**
   * Assess image blur using Laplacian variance (OpenCV path)
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
   * Assess image contrast using standard deviation (OpenCV path)
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
   * Assess image brightness (OpenCV path)
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
   * Assess image noise using local standard deviation (OpenCV path)
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
   * Detect image skew/rotation using Hough line detection (OpenCV path)
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
   * Assess lighting uniformity (OpenCV path)
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
   * Detect potential text regions using morphological operations (OpenCV path)
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
   * Assess blur using Sharp statistics (approximation, fallback path)
   * @param {Object} stats - Sharp image statistics
   * @param {Object} metadata - Image metadata
   * @returns {Object} Blur assessment
   */
  assessBlurFromStats(stats, metadata) {
    try {
      // Use entropy as a proxy for sharpness
      // Higher entropy generally indicates more detail/sharpness
      let avgEntropy = 0;
      if (stats.channels && stats.channels.length > 0) {
        avgEntropy = stats.channels.reduce((sum, channel) => sum + (channel.entropy || 0), 0) / stats.channels.length;
      }

      // Scale entropy to variance-like values for compatibility
      const variance = avgEntropy * 15; // Rough approximation

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
      return { variance: 0, level: 'unknown', needsSharpening: true };
    }
  }

  /**
   * Assess contrast using Sharp statistics (fallback path)
   * @param {Object} stats - Sharp image statistics
   * @returns {Object} Contrast assessment
   */
  assessContrastFromStats(stats) {
    try {
      // Use standard deviation as a proxy for contrast
      let avgStdDev = 0;
      if (stats.channels && stats.channels.length > 0) {
        avgStdDev = stats.channels.reduce((sum, channel) => sum + (channel.std || 0), 0) / stats.channels.length;
      }

      const contrast = avgStdDev / 255.0; // Normalize to 0-1

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
      return { value: 0, level: 'unknown', needsEnhancement: true };
    }
  }

  /**
   * Assess brightness using Sharp statistics (fallback path)
   * @param {Object} stats - Sharp image statistics
   * @returns {Object} Brightness assessment
   */
  assessBrightnessFromStats(stats) {
    try {
      // Use mean values across channels
      let avgMean = 128; // Default middle brightness
      if (stats.channels && stats.channels.length > 0) {
        avgMean = stats.channels.reduce((sum, channel) => sum + (channel.mean || 128), 0) / stats.channels.length;
      }

      let level;
      if (avgMean < this.qualityThresholds.brightness.dark) {
        level = 'dark';
      } else if (avgMean > this.qualityThresholds.brightness.bright) {
        level = 'bright';
      } else {
        level = 'optimal';
      }

      return {
        value: Math.round(avgMean),
        level: level,
        needsAdjustment: level !== 'optimal'
      };
    } catch (error) {
      return { value: 128, level: 'unknown', needsAdjustment: true };
    }
  }

  /**
   * Assess noise using Sharp statistics (approximation, fallback path)
   * @param {Object} stats - Sharp image statistics
   * @returns {Object} Noise assessment
   */
  assessNoiseFromStats(stats) {
    try {
      // Noise estimation based on variance vs entropy ratio
      let noiseLevel = 10; // Default moderate noise
      if (stats.channels && stats.channels.length > 0) {
        const avgStd = stats.channels.reduce((sum, channel) => sum + (channel.std || 0), 0) / stats.channels.length;
        const avgEntropy = stats.channels.reduce((sum, channel) => sum + (channel.entropy || 7), 0) / stats.channels.length;

        // High std with low entropy might indicate noise
        if (avgEntropy > 0) {
          noiseLevel = (avgStd / avgEntropy) * 3; // Rough approximation
        }
      }

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
      return { value: 0, level: 'unknown', needsDenoising: true };
    }
  }

  /**
   * Assess lighting uniformity (basic approximation, fallback path)
   * @param {Object} stats - Sharp image statistics
   * @returns {Object} Lighting assessment
   */
  assessLightingFromStats(stats) {
    try {
      // Basic uniformity assessment based on std deviation
      let uniformity = 1;
      if (stats.channels && stats.channels.length > 0) {
        const avgStd = stats.channels.reduce((sum, channel) => sum + (channel.std || 0), 0) / stats.channels.length;
        uniformity = Math.max(0, 1 - (avgStd / 100)); // Rough approximation
      }

      const isUniform = uniformity > 0.7;

      return {
        uniformity: Math.round(uniformity * 1000) / 1000,
        isUniform: isUniform,
        needsCorrection: !isUniform
      };
    } catch (error) {
      return { uniformity: 1, isUniform: true, needsCorrection: false };
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

module.exports = ImageQualityAnalyzer;
