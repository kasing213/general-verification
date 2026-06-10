'use strict';

const sharp = require('sharp');
const Jimp = require('jimp');

/**
 * Bank Template Matcher
 * Identifies bank apps and extracts data using template matching and position-based extraction
 */
class BankTemplateMatcher {
  constructor() {
    this.bankTemplates = {
      'ABA': {
        name: 'ABA Bank',
        colorProfile: {
          primary: [27, 45, 67], // Dark blue RGB
          secondary: [255, 255, 255], // White
          success: [76, 175, 80] // Green
        },
        logoFeatures: {
          position: 'top_center',
          text: ['ABA', 'Bank'],
          colors: ['white_on_dark']
        },
        successIndicators: {
          checkmark: { position: 'center', color: 'green' },
          text: ['ជោគជ័យ', 'Success', 'completed']
        },
        amountPosition: {
          relative: { x: 0.1, y: 0.4, width: 0.8, height: 0.3 },
          indicators: ['-', 'KHR', 'USD', 'CT']
        },
        recipientPosition: {
          relative: { x: 0.1, y: 0.6, width: 0.8, height: 0.2 },
          indicators: ['To:', 'Account', 'Name']
        },
        transactionIdPosition: {
          relative: { x: 0.1, y: 0.8, width: 0.8, height: 0.2 },
          indicators: ['Trx.', 'ID', 'Transaction']
        }
      },
      'ACLEDA': {
        name: 'ACLEDA Bank',
        colorProfile: {
          primary: [0, 51, 102], // Navy blue
          secondary: [255, 255, 255],
          success: [76, 175, 80]
        },
        logoFeatures: {
          position: 'top_left',
          text: ['ACLEDA', 'mobile'],
          colors: ['white_on_dark', 'blue']
        },
        successIndicators: {
          checkmark: { position: 'center_top', color: 'green' },
          text: ['រួចរាល់', 'ជោគជ័យ', 'Success']
        },
        amountPosition: {
          relative: { x: 0.1, y: 0.3, width: 0.8, height: 0.2 }
        },
        recipientPosition: {
          relative: { x: 0.1, y: 0.5, width: 0.8, height: 0.3 }
        }
      },
      'Wing': {
        name: 'Wing Bank',
        colorProfile: {
          primary: [255, 87, 34], // Orange
          secondary: [76, 175, 80], // Green
          background: [250, 250, 250]
        },
        logoFeatures: {
          position: 'top_center',
          text: ['Wing'],
          colors: ['orange', 'green']
        },
        successIndicators: {
          checkmark: { position: 'center', color: 'green' },
          text: ['Success', 'ជោគជ័យ']
        }
      }
    };

    this.genericPatterns = {
      amounts: [
        /[-]?\d{1,3}(?:,\d{3})*(?:\.\d{2})?\s*(KHR|USD|៛|\$)/gi,
        /CT[\s\S]*?(-?\d{1,3}(?:,\d{3})*)\s*(KHR|USD)/gi
      ],
      transactionIds: [
        /(?:Trx\.?\s*ID|Transaction\s*ID|TXN\s*ID)[\s:]*([A-Z0-9]{6,})/gi,
        /ID[\s:]*([0-9]{8,})/gi
      ],
      recipients: [
        /(?:To|Recipient|Account\s*Name)[\s:]*([A-Z][A-Z\s\.&]{5,})/gi,
        /([A-Z]{2,}\s+[A-Z]\.?\s*&?\s*[A-Z]{2,}\s+[A-Z]\.?)/gi
      ],
      accounts: [
        /(?:To\s*account|Account)[\s:]*([0-9\s\-]{8,})/gi,
        /\b(\d{3}\s*\d{3}\s*\d{3,})\b/gi
      ]
    };
  }

  /**
   * Analyze image and attempt template matching
   * @param {Buffer} imageBuffer
   * @returns {Promise<Object>}
   */
  async analyzeImage(imageBuffer) {
    const startTime = Date.now();

    try {
      console.log('🏦 Starting bank template analysis...');

      // Get image metadata
      const metadata = await sharp(imageBuffer).metadata();

      // Detect bank type
      const bankDetection = await this.detectBankType(imageBuffer);

      // Extract data using generic patterns
      const extractedData = await this.extractWithGenericPatterns(imageBuffer);

      const processingTime = Date.now() - startTime;

      return {
        bankDetected: bankDetection.bank,
        confidence: Math.max(bankDetection.confidence, extractedData.confidence),
        extractedData: extractedData,
        templateMatch: bankDetection.confidence > 0.6,
        processingTime: processingTime,
        imageInfo: {
          width: metadata.width,
          height: metadata.height,
          aspectRatio: metadata.width / metadata.height
        }
      };

    } catch (error) {
      console.error('❌ Template analysis failed:', error.message);
      return {
        bankDetected: null,
        confidence: 0,
        extractedData: null,
        templateMatch: false,
        error: error.message,
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Detect bank type using color analysis and text detection
   * @param {Buffer} imageBuffer
   * @returns {Promise<Object>}
   */
  async detectBankType(imageBuffer) {
    try {
      // Create analysis version
      const analysisBuffer = await sharp(imageBuffer)
        .resize(400, 600, { fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();

      // Convert to Jimp for pixel analysis
      const image = await Jimp.read(analysisBuffer);
      const { width, height } = image.bitmap;

      // Analyze top portion for bank identification (first 30% of image)
      const topHeight = Math.floor(height * 0.3);
      let colorCounts = {};
      let totalPixels = 0;

      for (let y = 0; y < topHeight; y++) {
        for (let x = 0; x < width; x++) {
          const color = image.getPixelColor(x, y);
          const { r, g, b } = Jimp.intToRGBA(color);
          const colorKey = `${Math.floor(r/20)*20},${Math.floor(g/20)*20},${Math.floor(b/20)*20}`;
          colorCounts[colorKey] = (colorCounts[colorKey] || 0) + 1;
          totalPixels++;
        }
      }

      // Find dominant colors
      const sortedColors = Object.entries(colorCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3);

      let bestMatch = null;
      let bestScore = 0;

      // Check each bank template
      for (const [bankCode, template] of Object.entries(this.bankTemplates)) {
        let score = 0;
        const primary = template.colorProfile.primary;

        // Check if primary color is present in dominant colors
        for (const [colorStr, count] of sortedColors) {
          const [r, g, b] = colorStr.split(',').map(Number);
          const distance = Math.sqrt(
            Math.pow(r - primary[0], 2) +
            Math.pow(g - primary[1], 2) +
            Math.pow(b - primary[2], 2)
          );

          if (distance < 60) { // Color match threshold
            score += (count / totalPixels) * 100;
          }
        }

        // Additional checks could be added here (logo detection, text analysis)

        if (score > bestScore) {
          bestScore = score;
          bestMatch = bankCode;
        }
      }

      return {
        bank: bestMatch,
        confidence: Math.min(bestScore / 10, 1.0), // Normalize to 0-1
        dominantColors: sortedColors.slice(0, 2),
        analysis: `Detected ${bestMatch} with ${Math.round(bestScore)}% color match`
      };

    } catch (error) {
      console.error('Bank detection failed:', error.message);
      return {
        bank: null,
        confidence: 0,
        error: error.message
      };
    }
  }

  /**
   * Extract data using generic pattern matching
   * @param {Buffer} imageBuffer
   * @returns {Promise<Object>}
   */
  async extractWithGenericPatterns(imageBuffer) {
    try {
      console.log('🔍 Using generic pattern extraction...');

      // For now, return a placeholder structure
      // This would typically use a simple OCR engine to get text, then apply patterns
      return {
        bank: 'Unknown',
        confidence: 0.3,
        amount: null,
        currency: null,
        recipient: null,
        transactionId: null,
        account: null,
        extractionMethod: 'generic_patterns',
        needsFullOCR: true // Flag indicating full OCR is needed
      };

    } catch (error) {
      console.error('Generic pattern extraction failed:', error.message);
      return {
        bank: 'Unknown',
        confidence: 0,
        extractionMethod: 'failed',
        error: error.message
      };
    }
  }

  /**
   * Check if image looks like a banking app screenshot
   * @param {Buffer} imageBuffer
   * @returns {Promise<Object>}
   */
  async isBankingApp(imageBuffer) {
    try {
      const metadata = await sharp(imageBuffer).metadata();
      const aspectRatio = metadata.width / metadata.height;

      // Mobile aspect ratios (portrait)
      const isMobileAspect = aspectRatio > 0.4 && aspectRatio < 0.8;

      // Check for common banking UI elements
      const bankDetection = await this.detectBankType(imageBuffer);

      return {
        isBankingApp: isMobileAspect && (bankDetection.confidence > 0.3),
        confidence: bankDetection.confidence,
        bankDetected: bankDetection.bank,
        aspectRatio: aspectRatio,
        isMobileLayout: isMobileAspect
      };

    } catch (error) {
      return {
        isBankingApp: false,
        confidence: 0,
        error: error.message
      };
    }
  }
}

module.exports = BankTemplateMatcher;