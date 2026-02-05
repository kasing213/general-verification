'use strict';

/**
 * Language Detection Service
 * Detects and routes between Khmer and English text for appropriate OCR processing
 */
class LanguageDetector {
  constructor() {
    this.patterns = {
      // Khmer Unicode ranges
      khmer: {
        basic: /[\u1780-\u17FF]/g,           // Main Khmer block
        symbols: /[\u19E0-\u19FF]/g,        // Khmer symbols
        extendedA: /[\u1780-\u17DD]/g,      // Khmer consonants, vowels
        extendedB: /[\u17E0-\u17EF]/g,      // Khmer digits
        punctuation: /[\u17F0-\u17FF]/g     // Khmer punctuation
      },

      // English patterns
      english: {
        letters: /[A-Za-z]/g,
        numbers: /[0-9]/g,
        common: /\b(the|and|or|is|are|was|were|have|has|had|will|would|could|should|may|might|can|to|from|with|for|of|in|on|at|by|about|over|under|through|between)\b/gi
      },

      // Numbers and currencies (universal)
      universal: {
        amounts: /[-]?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g,
        currencies: /\b(USD|KHR|\$|៛|CT)\b/gi,
        dates: /\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}/g,
        times: /\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM))?/gi
      },

      // Common banking terms
      banking: {
        english: ['transfer', 'payment', 'account', 'balance', 'transaction', 'recipient', 'amount', 'success', 'completed', 'failed'],
        khmer: ['ប្រាក់', 'គណនី', 'ផ្ទេរ', 'ជោគជ័យ', 'រួចរាល់', 'បានបញ្ចប់', 'ទទួល', 'ចេញ']
      }
    };

    this.thresholds = {
      khmer: {
        high: 0.3,      // >30% Khmer characters = definitely Khmer
        medium: 0.15,   // >15% Khmer characters = likely Khmer
        low: 0.05       // >5% Khmer characters = possibly Khmer
      },
      english: {
        high: 0.7,      // >70% English characters = definitely English
        medium: 0.5,    // >50% English characters = likely English
        low: 0.3        // >30% English characters = possibly English
      }
    };
  }

  /**
   * Analyze text and detect primary language
   * @param {string} text - Input text to analyze
   * @returns {Object} Language analysis result
   */
  detectLanguage(text) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return this.createEmptyResult();
    }

    const cleanText = text.trim();
    const totalChars = cleanText.replace(/\s+/g, '').length;

    if (totalChars === 0) {
      return this.createEmptyResult();
    }

    // Count character types
    const khmerChars = this.countMatches(cleanText, this.patterns.khmer.basic);
    const englishChars = this.countMatches(cleanText, this.patterns.english.letters);
    const numberChars = this.countMatches(cleanText, this.patterns.english.numbers);

    // Calculate ratios
    const khmerRatio = khmerChars / totalChars;
    const englishRatio = englishChars / totalChars;
    const numberRatio = numberChars / totalChars;

    // Detect banking terms
    const bankingTerms = this.detectBankingTerms(cleanText);

    // Determine primary language
    const languageScores = this.calculateLanguageScores({
      khmerRatio,
      englishRatio,
      numberRatio,
      bankingTerms,
      totalChars
    });

    // Extract structured data
    const extractedData = this.extractUniversalData(cleanText);

    return {
      primaryLanguage: languageScores.primary,
      confidence: languageScores.confidence,
      languages: languageScores.languages,

      // Character analysis
      analysis: {
        totalCharacters: totalChars,
        khmerChars: khmerChars,
        englishChars: englishChars,
        numberChars: numberChars,
        khmerRatio: Math.round(khmerRatio * 1000) / 10, // Percentage with 1 decimal
        englishRatio: Math.round(englishRatio * 1000) / 10,
        numberRatio: Math.round(numberRatio * 1000) / 10
      },

      // Banking context
      banking: bankingTerms,

      // Extracted universal data
      extractedData: extractedData,

      // Routing recommendations
      routing: this.getRoutingRecommendations(languageScores, bankingTerms)
    };
  }

  /**
   * Detect multiple languages in text and segment them
   * @param {string} text
   * @returns {Object}
   */
  segmentLanguages(text) {
    const segments = [];
    const sentences = text.split(/[.!?។]/);

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i].trim();
      if (sentence.length > 3) {
        const detection = this.detectLanguage(sentence);
        segments.push({
          text: sentence,
          language: detection.primaryLanguage,
          confidence: detection.confidence,
          index: i
        });
      }
    }

    // Group consecutive segments of the same language
    const grouped = [];
    let currentGroup = null;

    for (const segment of segments) {
      if (!currentGroup || currentGroup.language !== segment.language) {
        if (currentGroup) grouped.push(currentGroup);
        currentGroup = {
          language: segment.language,
          text: segment.text,
          segments: [segment],
          confidence: segment.confidence
        };
      } else {
        currentGroup.text += ' ' + segment.text;
        currentGroup.segments.push(segment);
        currentGroup.confidence = Math.max(currentGroup.confidence, segment.confidence);
      }
    }

    if (currentGroup) grouped.push(currentGroup);

    return {
      segments: grouped,
      hasMultipleLanguages: grouped.length > 1 &&
        grouped.some(g => g.language === 'khmer') &&
        grouped.some(g => g.language === 'english')
    };
  }

  /**
   * Count pattern matches in text
   * @param {string} text
   * @param {RegExp} pattern
   * @returns {number}
   */
  countMatches(text, pattern) {
    const matches = text.match(pattern);
    return matches ? matches.length : 0;
  }

  /**
   * Detect banking terminology in different languages
   * @param {string} text
   * @returns {Object}
   */
  detectBankingTerms(text) {
    const englishTerms = [];
    const khmerTerms = [];

    // Check English banking terms
    for (const term of this.patterns.banking.english) {
      const regex = new RegExp(`\\b${term}\\b`, 'gi');
      if (regex.test(text)) {
        englishTerms.push(term);
      }
    }

    // Check Khmer banking terms
    for (const term of this.patterns.banking.khmer) {
      if (text.includes(term)) {
        khmerTerms.push(term);
      }
    }

    return {
      english: englishTerms,
      khmer: khmerTerms,
      hasBankingContext: englishTerms.length > 0 || khmerTerms.length > 0,
      bankingLanguage: englishTerms.length > khmerTerms.length ? 'english' : 'khmer'
    };
  }

  /**
   * Calculate language scores and determine primary language
   * @param {Object} metrics
   * @returns {Object}
   */
  calculateLanguageScores(metrics) {
    const { khmerRatio, englishRatio, numberRatio, bankingTerms } = metrics;

    let khmerScore = 0;
    let englishScore = 0;

    // Base scores from character ratios
    if (khmerRatio >= this.thresholds.khmer.high) {
      khmerScore += 40;
    } else if (khmerRatio >= this.thresholds.khmer.medium) {
      khmerScore += 25;
    } else if (khmerRatio >= this.thresholds.khmer.low) {
      khmerScore += 10;
    }

    if (englishRatio >= this.thresholds.english.high) {
      englishScore += 40;
    } else if (englishRatio >= this.thresholds.english.medium) {
      englishScore += 25;
    } else if (englishRatio >= this.thresholds.english.low) {
      englishScore += 10;
    }

    // Bonus for numbers (usually indicates structured data)
    if (numberRatio > 0.1) {
      englishScore += 10; // Numbers slightly favor English processing
    }

    // Banking terms bonus
    if (bankingTerms.hasBankingContext) {
      if (bankingTerms.english.length > 0) {
        englishScore += 15;
      }
      if (bankingTerms.khmer.length > 0) {
        khmerScore += 15;
      }
    }

    // Determine primary language and confidence
    let primaryLanguage = 'mixed';
    let confidence = 0;

    if (khmerScore > englishScore && khmerScore > 30) {
      primaryLanguage = 'khmer';
      confidence = Math.min(khmerScore / 50, 1.0);
    } else if (englishScore > khmerScore && englishScore > 30) {
      primaryLanguage = 'english';
      confidence = Math.min(englishScore / 50, 1.0);
    } else if (khmerScore > 15 || englishScore > 15) {
      primaryLanguage = 'mixed';
      confidence = Math.min((khmerScore + englishScore) / 80, 0.8);
    } else {
      primaryLanguage = 'unknown';
      confidence = 0.1;
    }

    return {
      primary: primaryLanguage,
      confidence: Math.round(confidence * 100) / 100,
      languages: {
        khmer: {
          score: khmerScore,
          ratio: khmerRatio,
          present: khmerScore > 0
        },
        english: {
          score: englishScore,
          ratio: englishRatio,
          present: englishScore > 0
        },
        mixed: khmerScore > 10 && englishScore > 10
      }
    };
  }

  /**
   * Extract universal data (numbers, dates, amounts)
   * @param {string} text
   * @returns {Object}
   */
  extractUniversalData(text) {
    return {
      amounts: this.extractMatches(text, this.patterns.universal.amounts),
      currencies: this.extractMatches(text, this.patterns.universal.currencies),
      dates: this.extractMatches(text, this.patterns.universal.dates),
      times: this.extractMatches(text, this.patterns.universal.times)
    };
  }

  /**
   * Extract all matches for a pattern
   * @param {string} text
   * @param {RegExp} pattern
   * @returns {Array}
   */
  extractMatches(text, pattern) {
    const matches = text.match(pattern);
    return matches ? [...new Set(matches)] : []; // Remove duplicates
  }

  /**
   * Get OCR engine routing recommendations
   * @param {Object} languageScores
   * @param {Object} bankingTerms
   * @returns {Object}
   */
  getRoutingRecommendations(languageScores, bankingTerms) {
    const recommendations = {
      primary: [],
      fallback: [],
      strategy: 'unknown'
    };

    if (languageScores.primary === 'khmer') {
      recommendations.primary = ['openai-vision'];
      recommendations.fallback = ['easyocr'];
      recommendations.strategy = 'khmer-focused';
    } else if (languageScores.primary === 'english') {
      recommendations.primary = ['tesseract', 'easyocr'];
      recommendations.fallback = ['openai-vision'];
      recommendations.strategy = 'english-focused';
    } else if (languageScores.primary === 'mixed') {
      recommendations.primary = ['easyocr', 'openai-vision'];
      recommendations.fallback = ['tesseract'];
      recommendations.strategy = 'multilingual';
    } else {
      recommendations.primary = ['easyocr', 'tesseract'];
      recommendations.fallback = ['openai-vision'];
      recommendations.strategy = 'general';
    }

    // Add template matching for banking context
    if (bankingTerms.hasBankingContext) {
      recommendations.primary.unshift('template');
      recommendations.strategy += '-banking';
    }

    return recommendations;
  }

  /**
   * Create empty result for invalid input
   * @returns {Object}
   */
  createEmptyResult() {
    return {
      primaryLanguage: 'unknown',
      confidence: 0,
      languages: {
        khmer: { score: 0, ratio: 0, present: false },
        english: { score: 0, ratio: 0, present: false },
        mixed: false
      },
      analysis: {
        totalCharacters: 0,
        khmerChars: 0,
        englishChars: 0,
        numberChars: 0,
        khmerRatio: 0,
        englishRatio: 0,
        numberRatio: 0
      },
      banking: {
        english: [],
        khmer: [],
        hasBankingContext: false,
        bankingLanguage: 'unknown'
      },
      extractedData: {
        amounts: [],
        currencies: [],
        dates: [],
        times: []
      },
      routing: {
        primary: ['easyocr'],
        fallback: ['tesseract'],
        strategy: 'default'
      }
    };
  }

  /**
   * Check if text is primarily numbers/symbols (receipts, invoices)
   * @param {string} text
   * @returns {boolean}
   */
  isStructuredData(text) {
    const cleanText = text.replace(/\s+/g, '');
    const numberSymbolChars = cleanText.match(/[0-9.,:\-$₹€£¥₦₱₩₡₪₫₨₴₦]/g) || [];
    return numberSymbolChars.length / cleanText.length > 0.4;
  }

  /**
   * Get processing recommendations for specific text
   * @param {string} text
   * @returns {Object}
   */
  getProcessingRecommendations(text) {
    const detection = this.detectLanguage(text);
    const isStructured = this.isStructuredData(text);

    return {
      ...detection,
      isStructuredData: isStructured,
      processingHints: {
        useTemplateMatching: detection.banking.hasBankingContext,
        preferHighDPI: isStructured,
        useLanguageSpecificOCR: detection.confidence > 0.7,
        requiresMultipass: detection.languages.mixed
      }
    };
  }
}

module.exports = LanguageDetector;