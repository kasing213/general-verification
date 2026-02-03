'use strict';

const sharp = require('sharp');

/**
 * Fallback Image Quality Assessment using Sharp
 * Provides basic quality analysis without OpenCV dependency
 */
class ImageQualityAnalyzer {
  constructor() {
    this.qualityThresholds = {
      blur: {
        sharp: 100,
        acceptable: 50,
        blurry: 10
      },
      contrast: {
        high: 0.8,
        acceptable: 0.4,
        low: 0.2
      },
      brightness: {
        dark: 50,
        optimal: 128,
        bright: 200
      },
      noise: {
        clean: 5,
        acceptable: 15,
        noisy: 30
      },
      resolution: {
        low: 300000,
        medium: 1000000,
        high: 2000000
      }
    };
  }

  /**
   * Analyze image quality using Sharp
   * @param {Buffer} imageBuffer - Image buffer
   * @returns {Promise<Object>} Quality analysis results
   */
  async analyzeQuality(imageBuffer) {
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
   * Assess blur using Sharp statistics (approximation)
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
   * Assess contrast using Sharp statistics
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
   * Assess brightness using Sharp statistics
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
   * Assess noise using Sharp statistics (approximation)
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
   * Assess lighting uniformity (basic approximation)
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

      if (analysis.lighting.needsCorrection) score -= 15;

      // Bonus for high resolution
      if (analysis.dimensions.totalPixels > this.qualityThresholds.resolution.high) {
        score += 5;
      } else if (analysis.dimensions.totalPixels < this.qualityThresholds.resolution.low) {
        score -= 10;
      }

      return Math.max(0, Math.min(100, Math.round(score)));
    } catch (error) {
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
      return ['enhance_all'];
    }
  }
}

module.exports = ImageQualityAnalyzer;