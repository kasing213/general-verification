'use strict';

const stringSimilarity = require('string-similarity');
const { getDb } = require('../db/mongo');

/**
 * Rule-Based Name Intelligence Service
 * Handles recipient name verification with OCR error correction
 * NO ML guessing - only deterministic rules
 */
class NameIntelligenceService {
  constructor() {
    // OCR character confusions (deterministic mappings)
    this.ocrCorrections = new Map([
      ['0', 'O'],
      ['O', '0'],
      ['1', 'I'],
      ['I', '1'],
      ['l', '1'],
      ['|', 'I'],
      ['5', 'S'],
      ['S', '5'],
      ['8', 'B'],
      ['B', '8'],
      ['6', 'G'],
      ['G', '6'],
      ['2', 'Z'],
      ['Z', '2'],
      ['.', ','],
      [',', '.'],
      ['rn', 'm'],  // Common OCR confusion
      ['ni', 'm'],
      ['cl', 'd'],
      ['d', 'cl']
    ]);

    // Configuration
    this.config = {
      strictThreshold: parseInt(process.env.NAME_MATCH_STRICT_THRESHOLD) || 85,
      gptThreshold: parseInt(process.env.NAME_MATCH_GPT_THRESHOLD) || 70,
      maxLevenshteinDistance: parseInt(process.env.MAX_LEVENSHTEIN_DISTANCE) || 2,
      enableOCRCorrection: process.env.ENABLE_OCR_CORRECTION !== 'false',
      enableInitialMatching: process.env.ENABLE_INITIAL_MATCHING !== 'false'
    };
  }

  /**
   * Analyze name match with rule-based intelligence
   * @param {string} extracted - Name from OCR
   * @param {Array|string} expected - Expected names
   * @param {Array} allowedAliases - Tenant-specific aliases
   * @returns {object} - Match analysis result
   */
  async analyzeMatch(extracted, expected, allowedAliases = []) {
    if (!extracted || !expected) {
      return this.createResult(0, 'no_match', 'Missing extracted or expected name');
    }

    // Normalize expected to array
    const expectedNames = Array.isArray(expected) ? expected : [expected];

    // Try each expected name
    for (const expectedName of expectedNames) {
      const result = await this.analyzeNamePair(extracted, expectedName, allowedAliases);
      if (result.confidence >= this.config.gptThreshold) {
        return result;
      }
    }

    // No good match found
    return this.createResult(0, 'no_match', `No match found for: ${extracted}`);
  }

  /**
   * Analyze a single name pair
   * @param {string} extracted - OCR extracted name
   * @param {string} expected - Expected name
   * @param {Array} allowedAliases - Tenant aliases
   * @returns {object} - Match result
   */
  async analyzeNamePair(extracted, expected, allowedAliases) {
    const steps = [];

    // Step 1: Exact match
    if (this.exactMatch(extracted, expected)) {
      return this.createResult(100, 'exact', 'Exact match', { steps: ['exact_match'] });
    }
    steps.push('exact_match_failed');

    // Step 2: Normalize and try again
    const normalizedExtracted = this.normalizeText(extracted);
    const normalizedExpected = this.normalizeText(expected);

    if (normalizedExtracted === normalizedExpected) {
      return this.createResult(98, 'normalized', 'Match after normalization', {
        steps: [...steps, 'normalized_match'],
        normalization: `"${extracted}" → "${normalizedExtracted}"`
      });
    }
    steps.push('normalized_match_failed');

    // Step 3: OCR error correction
    if (this.config.enableOCRCorrection) {
      const correctedExtracted = this.applyOCRCorrections(normalizedExtracted);
      if (correctedExtracted !== normalizedExtracted && correctedExtracted === normalizedExpected) {
        return this.createResult(95, 'ocr_corrected', 'Match after OCR correction', {
          steps: [...steps, 'ocr_corrected'],
          correction: `"${normalizedExtracted}" → "${correctedExtracted}"`
        });
      }
      steps.push('ocr_correction_failed');
    }

    // Step 4: Token matching
    const tokenScore = this.tokenMatch(normalizedExtracted, normalizedExpected);
    if (tokenScore >= 85) {
      return this.createResult(tokenScore, 'token_match', 'High token similarity', {
        steps: [...steps, 'token_match'],
        tokenScore
      });
    }
    steps.push(`token_match_failed_${tokenScore}`);

    // Step 5: Initial/prefix matching
    if (this.config.enableInitialMatching) {
      const initialScore = this.initialMatch(normalizedExtracted, normalizedExpected);
      if (initialScore >= 80) {
        return this.createResult(initialScore, 'initial_match', 'Initial/prefix match', {
          steps: [...steps, 'initial_match'],
          initialScore
        });
      }
      steps.push(`initial_match_failed_${initialScore}`);
    }

    // Step 6: Levenshtein distance
    const distance = this.levenshteinDistance(normalizedExtracted, normalizedExpected);
    if (distance <= this.config.maxLevenshteinDistance) {
      const score = Math.max(70, 90 - (distance * 10));
      return this.createResult(score, 'fuzzy', `Levenshtein distance: ${distance}`, {
        steps: [...steps, 'levenshtein_match'],
        distance
      });
    }
    steps.push(`levenshtein_failed_${distance}`);

    // Step 7: Tenant-specific aliases
    const aliasResult = await this.checkAliases(normalizedExtracted, normalizedExpected, allowedAliases);
    if (aliasResult.score > 0) {
      return this.createResult(aliasResult.score, 'alias_match', aliasResult.reason, {
        steps: [...steps, 'alias_match'],
        alias: aliasResult.alias
      });
    }
    steps.push('alias_match_failed');

    // No match found
    return this.createResult(0, 'no_match', 'All matching strategies failed', { steps });
  }

  /**
   * Exact string match (case-insensitive)
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {boolean} - Match result
   */
  exactMatch(str1, str2) {
    if (!str1 || !str2) return false;
    return str1.toLowerCase().trim() === str2.toLowerCase().trim();
  }

  /**
   * Normalize text for comparison
   * @param {string} text - Input text
   * @returns {string} - Normalized text
   */
  normalizeText(text) {
    if (!text) return '';

    return text
      .toUpperCase()                    // Convert to uppercase
      .replace(/[^\w\s]/g, '')         // Remove punctuation
      .replace(/\s+/g, ' ')            // Normalize whitespace
      .trim();                         // Remove leading/trailing space
  }

  /**
   * Apply OCR error corrections
   * @param {string} text - Text to correct
   * @returns {string} - Corrected text
   */
  applyOCRCorrections(text) {
    if (!text) return '';

    let corrected = text;

    // Apply character-level corrections
    for (const [wrong, right] of this.ocrCorrections) {
      corrected = corrected.replace(new RegExp(wrong, 'g'), right);
    }

    return corrected;
  }

  /**
   * Token-based matching
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} - Match score (0-100)
   */
  tokenMatch(str1, str2) {
    if (!str1 || !str2) return 0;

    const tokens1 = str1.split(/\s+/).filter(t => t.length > 0);
    const tokens2 = str2.split(/\s+/).filter(t => t.length > 0);

    if (tokens1.length === 0 || tokens2.length === 0) return 0;

    let matches = 0;
    const totalTokens = Math.max(tokens1.length, tokens2.length);

    // Check each token from str1 against all tokens in str2
    for (const token1 of tokens1) {
      const bestMatch = Math.max(...tokens2.map(token2 =>
        stringSimilarity.compareTwoStrings(token1, token2)
      ));
      if (bestMatch >= 0.8) matches++;
    }

    return Math.round((matches / totalTokens) * 100);
  }

  /**
   * Initial/prefix matching (K. ↔ KANHA)
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} - Match score (0-100)
   */
  initialMatch(str1, str2) {
    if (!str1 || !str2) return 0;

    const tokens1 = str1.split(/\s+/);
    const tokens2 = str2.split(/\s+/);

    let score = 0;
    const maxTokens = Math.max(tokens1.length, tokens2.length);

    for (let i = 0; i < maxTokens; i++) {
      const t1 = tokens1[i] || '';
      const t2 = tokens2[i] || '';

      if (!t1 || !t2) continue;

      // Check if one is initial of the other
      if (this.isInitialOf(t1, t2) || this.isInitialOf(t2, t1)) {
        score += 90; // High score for initial match
      } else if (t1 === t2) {
        score += 100; // Perfect token match
      } else if (t1.startsWith(t2) || t2.startsWith(t1)) {
        score += 70; // Prefix match
      }
    }

    return Math.min(100, Math.round(score / maxTokens));
  }

  /**
   * Check if one token is an initial of another
   * @param {string} short - Short token (potential initial)
   * @param {string} long - Long token (potential full name)
   * @returns {boolean} - Is initial
   */
  isInitialOf(short, long) {
    if (!short || !long) return false;

    // Remove dots and check
    const cleanShort = short.replace(/\./g, '');

    // Must be 1-2 characters to be an initial
    if (cleanShort.length > 2) return false;

    // Must match the beginning of the long token
    return long.toUpperCase().startsWith(cleanShort.toUpperCase());
  }

  /**
   * Calculate Levenshtein distance
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} - Edit distance
   */
  levenshteinDistance(str1, str2) {
    if (!str1 || !str2) return Math.max(str1?.length || 0, str2?.length || 0);

    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Check tenant-specific aliases
   * @param {string} extracted - Extracted name
   * @param {string} expected - Expected name
   * @param {Array} allowedAliases - Tenant aliases
   * @returns {object} - Alias match result
   */
  async checkAliases(extracted, expected, allowedAliases) {
    if (!allowedAliases || allowedAliases.length === 0) {
      return { score: 0, reason: 'No aliases configured', alias: null };
    }

    for (const aliasGroup of allowedAliases) {
      if (!aliasGroup.primary || !aliasGroup.aliases) continue;

      // Check if expected is the primary name
      if (this.normalizeText(aliasGroup.primary) === this.normalizeText(expected)) {
        // Check if extracted matches any alias
        for (const alias of aliasGroup.aliases) {
          const aliasScore = this.calculateAliasScore(extracted, alias);
          if (aliasScore >= 80) {
            return {
              score: aliasScore,
              reason: `Matched alias: ${alias}`,
              alias: alias
            };
          }
        }
      }
    }

    return { score: 0, reason: 'No alias match found', alias: null };
  }

  /**
   * Calculate alias matching score
   * @param {string} extracted - Extracted name
   * @param {string} alias - Alias to check
   * @returns {number} - Match score
   */
  calculateAliasScore(extracted, alias) {
    const normalizedExtracted = this.normalizeText(extracted);
    const normalizedAlias = this.normalizeText(alias);

    // Exact match
    if (normalizedExtracted === normalizedAlias) return 95;

    // Token match
    const tokenScore = this.tokenMatch(normalizedExtracted, normalizedAlias);
    if (tokenScore >= 85) return tokenScore;

    // Fuzzy match
    const similarity = stringSimilarity.compareTwoStrings(normalizedExtracted, normalizedAlias);
    return Math.round(similarity * 100);
  }

  /**
   * Learn OCR error pattern (not name variations)
   * @param {string} ocrRead - What OCR read
   * @param {string} actualValue - What it should have been
   * @param {string} tenantId - Tenant ID for isolation
   * @returns {Promise<boolean>} - Learning success
   */
  async learnOCRError(ocrRead, actualValue, tenantId) {
    try {
      if (!ocrRead || !actualValue || ocrRead === actualValue) return false;

      const db = getDb();

      // Only learn character-level errors, not name variations
      if (this.isCharacterLevelError(ocrRead, actualValue)) {
        await db.collection('ocr_corrections').updateOne(
          {
            incorrect: ocrRead,
            correct: actualValue,
            tenantId: tenantId
          },
          {
            $inc: { frequency: 1 },
            $set: {
              lastSeen: new Date(),
              errorType: 'character_level'
            }
          },
          { upsert: true }
        );

        console.log(`📚 Learned OCR error: "${ocrRead}" → "${actualValue}" (Tenant: ${tenantId})`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('Error learning OCR pattern:', error);
      return false;
    }
  }

  /**
   * Check if this is a character-level OCR error (not a name variation)
   * @param {string} ocrRead - OCR reading
   * @param {string} actualValue - Actual value
   * @returns {boolean} - Is character error
   */
  isCharacterLevelError(ocrRead, actualValue) {
    const distance = this.levenshteinDistance(ocrRead, actualValue);

    // Only 1-2 character differences allowed
    if (distance > 2) return false;

    // Must be similar length (not completely different words)
    const lengthDiff = Math.abs(ocrRead.length - actualValue.length);
    if (lengthDiff > 2) return false;

    return true;
  }

  /**
   * Create standardized result object
   * @param {number} confidence - Confidence score (0-100)
   * @param {string} matchType - Type of match found
   * @param {string} reason - Explanation
   * @param {object} details - Additional details
   * @returns {object} - Result object
   */
  createResult(confidence, matchType, reason, details = {}) {
    return {
      confidence,
      matchType,
      reason,
      isMatch: confidence >= this.config.gptThreshold,
      requiresGPTJudgment: confidence >= this.config.gptThreshold && confidence < this.config.strictThreshold,
      details
    };
  }

  /**
   * Get service configuration
   * @returns {object} - Configuration
   */
  getConfig() {
    return { ...this.config };
  }
}

module.exports = NameIntelligenceService;