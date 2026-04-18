'use strict';

/**
 * Khmer Date Parser
 * Comprehensive month lookup table + position-aware day/year parsing.
 * Handles: full Khmer, short Khmer, consonant skeleton, English, mixed formats.
 */

// Khmer numeral to Arabic numeral mapping
const KHMER_NUMERALS = {
  '\u17E0': '0', '\u17E1': '1', '\u17E2': '2', '\u17E3': '3', '\u17E4': '4',
  '\u17E5': '5', '\u17E6': '6', '\u17E7': '7', '\u17E8': '8', '\u17E9': '9'
};

// ── Comprehensive month lookup table ──────────────────────────────
// Every way each month can appear: full Khmer, short Khmer,
// consonant skeleton (vowels stripped), English full, English abbrev.
// Sorted longest-first per month to avoid partial matches.

const MONTH_LOOKUP = {
  // ── January (1) ──
  '\u1798\u1780\u179A\u17B6': 1,                  // មករorg (full)
  '\u1798\u1780\u179A': 1,                         // org org org (short)
  'January': 1, 'january': 1, 'Jan': 1, 'jan': 1, 'JAN': 1, 'JANUARY': 1,

  // ── February (2) ──
  '\u1780\u17BB\u1798\u17D2\u1797\u17C8': 2,      // org org org org org (full)
  '\u1780\u17BB\u1798\u17D2\u1797': 2,             // org org org (short)
  '\u1780\u17BB\u1798': 2,                          // org org org (skeleton)
  'February': 2, 'february': 2, 'Feb': 2, 'feb': 2, 'FEB': 2, 'FEBRUARY': 2,

  // ── March (3) ──
  '\u1798\u17B8\u1793\u17B6': 3,                   // org org org org (full)
  '\u1798\u17B7\u1793\u17B6': 3,                   // org org org org (alt vowel - common OCR confusion)
  '\u1798\u17B8\u1793': 3,                          // org org org (short)
  '\u1798\u17B7\u1793': 3,                          // org org org (short alt)
  'March': 3, 'march': 3, 'Mar': 3, 'mar': 3, 'MAR': 3, 'MARCH': 3,

  // ── April (4) ──
  '\u1798\u17C1\u179F\u17B6': 4,                   // org org org org (full)
  '\u1798\u17C1\u179F': 4,                          // org org org (short)
  'April': 4, 'april': 4, 'Apr': 4, 'apr': 4, 'APR': 4, 'APRIL': 4,

  // ── May (5) ──
  '\u17A7\u179F\u1797\u17B6': 5,                   // org org org org (full)
  '\u17A7\u179F\u1797': 5,                          // org org org (short)
  '\u17A7\u179F': 5,                                // org org (skeleton)
  'May': 5, 'may': 5, 'MAY': 5,

  // ── June (6) ──
  '\u1798\u17B7\u1790\u17BB\u1793\u17B6': 6,      // org org org org org org (full)
  '\u1798\u17B7\u1790\u17BB\u1793': 6,             // org org org org org (short)
  '\u1798\u17B7\u1790': 6,                          // org org org (skeleton)
  'June': 6, 'june': 6, 'Jun': 6, 'jun': 6, 'JUN': 6, 'JUNE': 6,

  // ── July (7) ──
  '\u1780\u1780\u17D2\u1780\u178A\u17B6': 7,      // org org org org org org (full)
  '\u1780\u1780\u17D2\u1780\u178A': 7,             // org org org org org (short)
  '\u1780\u1780\u17D2\u1780': 7,                    // org org org org (skeleton)
  'July': 7, 'july': 7, 'Jul': 7, 'jul': 7, 'JUL': 7, 'JULY': 7,

  // ── August (8) ──
  '\u179F\u17B8\u17A0\u17B6': 8,                   // org org org org (full)
  '\u179F\u17B8\u17A0': 8,                          // org org org (short)
  'August': 8, 'august': 8, 'Aug': 8, 'aug': 8, 'AUG': 8, 'AUGUST': 8,

  // ── September (9) ──
  '\u1780\u1789\u17D2\u1789\u17B6': 9,             // org org org org org (full)
  '\u1780\u1789\u17D2\u1789': 9,                    // org org org org (short)
  '\u1780\u1789': 9,                                // org org (skeleton)
  'September': 9, 'september': 9, 'Sep': 9, 'sep': 9, 'SEP': 9, 'SEPTEMBER': 9,
  'Sept': 9, 'sept': 9, 'SEPT': 9,

  // ── October (10) ──
  '\u178F\u17BB\u179B\u17B6': 10,                  // org org org org (full)
  '\u178F\u17BB\u179B': 10,                         // org org org (short)
  'October': 10, 'october': 10, 'Oct': 10, 'oct': 10, 'OCT': 10, 'OCTOBER': 10,

  // ── November (11) ──
  '\u179C\u17B7\u1785\u17D2\u1786\u17B7\u1780\u17B6': 11, // org org org org org org org org (full)
  '\u179C\u17B7\u1785\u17D2\u1786\u17B7\u1780': 11,       // org org org org org org org (short)
  '\u179C\u17B7\u1785': 11,                                 // org org org (skeleton)
  'November': 11, 'november': 11, 'Nov': 11, 'nov': 11, 'NOV': 11, 'NOVEMBER': 11,

  // ── December (12) ──
  '\u1792\u17D2\u1793\u17BC': 12,                  // org org org org (full)
  '\u1792\u17D2\u1793': 12,                         // org org org (short)
  'December': 12, 'december': 12, 'Dec': 12, 'dec': 12, 'DEC': 12, 'DECEMBER': 12,
};

// Pre-sort keys by length descending so longest match wins
const MONTH_KEYS_SORTED = Object.keys(MONTH_LOOKUP)
  .sort((a, b) => b.length - a.length);

/**
 * Converts Khmer numerals to Arabic numerals (kept for backward compat)
 * @param {string} str - String containing Khmer numerals
 * @returns {string} - String with Arabic numerals
 */
function convertKhmerNumerals(str) {
  if (!str) return str;
  let result = str;
  for (const [khmer, arabic] of Object.entries(KHMER_NUMERALS)) {
    result = result.replace(new RegExp(khmer, 'g'), arabic);
  }
  return result;
}

// Regex that matches a sequence of digits in EITHER Arabic (0-9) or Khmer (០-៉)
const DIGIT_PATTERN = /[\d\u17E0-\u17E9]+/g;

/**
 * Extract all number sequences from text, reading both Arabic and Khmer digits directly.
 * No conversion step — each character is mapped to its numeric value on the spot.
 * @param {string} str - Text containing Arabic and/or Khmer digits
 * @returns {number[]} - Array of extracted numbers
 */
function extractNumbers(str) {
  if (!str) return [];
  const matches = str.match(DIGIT_PATTERN);
  if (!matches) return [];

  return matches.map(seq => {
    let num = 0;
    for (const ch of seq) {
      const code = ch.charCodeAt(0);
      let digit;
      if (code >= 0x30 && code <= 0x39) {
        digit = code - 0x30;        // Arabic 0-9
      } else if (code >= 0x17E0 && code <= 0x17E9) {
        digit = code - 0x17E0;      // Khmer org-org
      } else {
        continue;
      }
      num = num * 10 + digit;
    }
    return num;
  });
}

/**
 * Find a month name in text using comprehensive lookup table.
 * Tries longest keys first to avoid partial matches.
 * @param {string} text - Raw text to search (handles Khmer and English directly)
 * @returns {{ month: number, match: string, index: number } | null}
 */
function findMonth(text) {
  if (!text) return null;

  for (const key of MONTH_KEYS_SORTED) {
    const idx = text.indexOf(key);
    if (idx !== -1) {
      return { month: MONTH_LOOKUP[key], match: key, index: idx };
    }
  }
  return null;
}

/**
 * Extract day and year from text using month position as anchor.
 * Position-aware: numbers before month vs after month.
 * @param {string} text - Full date string
 * @param {number} monthIdx - Position of month match in text
 * @param {number} matchLen - Length of month match string
 * @returns {{ day: number, year: number, hour: number, minute: number } | null}
 */
function extractDayYear(text, monthIdx, matchLen) {
  const beforeMonth = text.substring(0, monthIdx);
  const afterMonth = text.substring(monthIdx + matchLen);

  // Read both Arabic (0-9) and Khmer digits directly — no conversion needed
  const numsBefore = extractNumbers(beforeMonth);
  const numsAfter = extractNumbers(afterMonth);

  let day, year, hour = 0, minute = 0;

  // Pattern: "18 [month] 2025" — day before, year after
  if (numsBefore.length > 0 && numsAfter.length > 0) {
    day = numsBefore[numsBefore.length - 1];  // last number before month
    year = numsAfter[0];                       // first number after month

    // Check for time after year (e.g. "2025 13:35")
    if (numsAfter.length >= 3) {
      hour = numsAfter[1] || 0;
      minute = numsAfter[2] || 0;
    }
  }
  // Pattern: "[month] 18 2025" — both numbers after month
  else if (numsAfter.length >= 2) {
    day = numsAfter[0];
    year = numsAfter[1];

    if (numsAfter.length >= 4) {
      hour = numsAfter[2] || 0;
      minute = numsAfter[3] || 0;
    }
  }
  // Pattern: "2025 18 [month]" — both numbers before month
  else if (numsBefore.length >= 2) {
    // Larger number is likely year
    if (numsBefore[0] > 31) {
      year = numsBefore[0];
      day = numsBefore[1];
    } else {
      day = numsBefore[numsBefore.length - 2];
      year = numsBefore[numsBefore.length - 1];
    }
  }
  // Only one number found total
  else if (numsAfter.length === 1) {
    // Could be day or year — guess based on value
    const n = numsAfter[0];
    if (n > 31) { year = n; day = 1; }
    else { day = n; year = new Date().getFullYear(); }
  }
  else if (numsBefore.length === 1) {
    const n = numsBefore[0];
    if (n > 31) { year = n; day = 1; }
    else { day = n; year = new Date().getFullYear(); }
  }
  else {
    return null;
  }

  // Swap if day looks like a year
  if (day > 31 && year <= 31) {
    [day, year] = [year, day];
  }
  if (year < 100) year += 2000;
  if (hour > 23) hour = 0;
  if (minute > 59) minute = 0;

  // Validate
  if (!day || !year || day < 1 || day > 31 || year < 2020 || year > 2100) {
    return null;
  }

  return { day, year, hour, minute };
}

/**
 * Parses Khmer/English/mixed date string to JavaScript Date object.
 * Pipeline:
 *   1. Try ISO/standard parsing
 *   2. Convert Khmer numerals, try again
 *   3. Find month name via MONTH_LOOKUP, extract day/year by position
 *   4. Try DD/MM/YYYY or DD-MM-YYYY regex
 *
 * @param {string} dateStr - Date string (Khmer, English, or mixed)
 * @returns {Date|null} - Parsed Date object or null
 */
function parseKhmerDate(dateStr) {
  if (!dateStr) return null;

  try {
    // Step 1: Try standard ISO parsing (works for "2025-03-18" etc.)
    const isoDate = new Date(dateStr);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }

    // Step 2: Find month name in raw text (Khmer or English)
    const monthResult = findMonth(dateStr);

    if (monthResult) {
      // Extract day/year from around the month — reads both Khmer and Arabic digits
      const dayYear = extractDayYear(dateStr, monthResult.index, monthResult.match.length);

      if (dayYear) {
        const date = new Date(dayYear.year, monthResult.month - 1, dayYear.day, dayYear.hour, dayYear.minute);
        if (!isNaN(date.getTime())) {
          return date;
        }
      }
    }

    // Step 3: Try DD/MM/YYYY or DD-MM-YYYY with separators
    // Match digit sequences (Arabic or Khmer) separated by / or -
    const sepPattern = /([\d\u17E0-\u17E9]{1,4})[\/\-]([\d\u17E0-\u17E9]{1,2})[\/\-]([\d\u17E0-\u17E9]{2,4})/;
    const slashMatch = dateStr.match(sepPattern);
    if (slashMatch) {
      // Read each group directly (handles Khmer digits natively)
      const nums = [slashMatch[1], slashMatch[2], slashMatch[3]].map(s => {
        const arr = extractNumbers(s);
        return arr.length > 0 ? arr[0] : 0;
      });

      let day = nums[0];
      let monthNum = nums[1];
      let year = nums[2];
      if (year < 100) year += 2000;

      // Assume DD/MM for Cambodian context; swap if month > 12
      if (monthNum > 12 && day <= 12) {
        [day, monthNum] = [monthNum, day];
      }

      if (day >= 1 && day <= 31 && monthNum >= 1 && monthNum <= 12) {
        const date = new Date(year, monthNum - 1, day);
        if (!isNaN(date.getTime())) {
          return date;
        }
      }
    }

    return null;
  } catch (error) {
    console.error(`Khmer date parsing error: ${error.message}`);
    return null;
  }
}

module.exports = {
  parseKhmerDate,
  convertKhmerNumerals,
  extractNumbers,
  findMonth,
  KHMER_NUMERALS,
  MONTH_LOOKUP
};
