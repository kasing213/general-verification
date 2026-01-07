'use strict';

/**
 * Khmer Date Parser
 * Parses dates containing Khmer numerals and month names
 */

// Khmer numeral to Arabic numeral mapping
const KHMER_NUMERALS = {
  '\u17E0': '0', '\u17E1': '1', '\u17E2': '2', '\u17E3': '3', '\u17E4': '4',
  '\u17E5': '5', '\u17E6': '6', '\u17E7': '7', '\u17E8': '8', '\u17E9': '9'
};

// Khmer month names to month number (1-12)
const KHMER_MONTHS = {
  '\u1798\u1780\u179A\u17B6': 1,      // January - មករា
  '\u1780\u17BB\u1798\u17D2\u1797\u17C8': 2,     // February - កុម្ភៈ
  '\u1798\u17B8\u1793\u17B6': 3,      // March - មីនា
  '\u1798\u17C1\u179F\u17B6': 4,      // April - មេសា
  '\u17A7\u179F\u1797\u17B6': 5,      // May - ឧសភា
  '\u1798\u17B7\u1790\u17BB\u1793\u17B6': 6,    // June - មិថុនា
  '\u1780\u1780\u17D2\u1780\u178A\u17B6': 7,    // July - កក្កដា
  '\u179F\u17B8\u17A0\u17B6': 8,      // August - សីហា
  '\u1780\u1789\u17D2\u1789\u17B6': 9,     // September - កញ្ញា
  '\u178F\u17BB\u179B\u17B6': 10,     // October - តុលា
  '\u179C\u17B7\u1785\u17D2\u1786\u17B7\u1780\u17B6': 11,  // November - វិច្ឆិកា
  '\u1792\u17D2\u1793\u17BC': 12       // December - ធ្នូ
};

// Alternative Khmer month spellings (shorter forms)
const KHMER_MONTHS_ALT = {
  '\u1798\u1780\u179A': 1,       // January (short) - មករ
  '\u1780\u17BB\u1798\u17D2\u1797': 2,      // February (short) - កុម្ភ
  '\u1798\u17B7\u1793\u17B6': 3       // March (alt) - មិនា
};

/**
 * Converts Khmer numerals to Arabic numerals
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

/**
 * Parses Khmer date string to JavaScript Date object
 * Supports formats:
 * - "០៦ មករា ២០២៦" (pure Khmer)
 * - "06 មករា 2026" (mixed)
 * - "៦ មករorg ២០២៦ ១៣:៣៥" (with time)
 * - "06/01/2026" or "06-01-2026" (standard with Khmer numerals)
 *
 * @param {string} dateStr - Date string potentially containing Khmer
 * @returns {Date|null} - Parsed Date object or null if failed
 */
function parseKhmerDate(dateStr) {
  if (!dateStr) return null;

  try {
    // First, try standard ISO parsing
    const isoDate = new Date(dateStr);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }

    // Convert any Khmer numerals to Arabic
    let normalized = convertKhmerNumerals(dateStr);

    // Try standard parsing after numeral conversion
    const afterNumerals = new Date(normalized);
    if (!isNaN(afterNumerals.getTime())) {
      return afterNumerals;
    }

    // Try to find Khmer month name
    let month = null;
    let monthMatch = null;

    // Check for full Khmer month names
    for (const [khmerMonth, monthNum] of Object.entries(KHMER_MONTHS)) {
      if (normalized.includes(khmerMonth)) {
        month = monthNum;
        monthMatch = khmerMonth;
        break;
      }
    }

    // If no match, try alternative spellings
    if (!month) {
      for (const [khmerMonth, monthNum] of Object.entries(KHMER_MONTHS_ALT)) {
        if (normalized.includes(khmerMonth)) {
          month = monthNum;
          monthMatch = khmerMonth;
          break;
        }
      }
    }

    if (month && monthMatch) {
      // Extract numbers from the string
      const withoutMonth = normalized.replace(monthMatch, ' MONTH ');
      const numbers = withoutMonth.match(/\d+/g);

      if (numbers && numbers.length >= 2) {
        let day, year, hour = 0, minute = 0;

        // Determine which number is day vs year
        if (parseInt(numbers[0]) > 31) {
          year = parseInt(numbers[0]);
          day = parseInt(numbers[1]);
        } else if (parseInt(numbers[1]) > 31) {
          day = parseInt(numbers[0]);
          year = parseInt(numbers[1]);
        } else if (numbers.length >= 2) {
          day = parseInt(numbers[0]);
          year = parseInt(numbers[numbers.length >= 3 ? 2 : 1]);
          if (year < 100) year += 2000;
        }

        // Check for time (hour:minute)
        if (numbers.length >= 4) {
          hour = parseInt(numbers[numbers.length - 2]) || 0;
          minute = parseInt(numbers[numbers.length - 1]) || 0;
          if (hour > 23) hour = 0;
          if (minute > 59) minute = 0;
        }

        // Validate and create date
        if (day && month && year && day >= 1 && day <= 31 && year >= 2020 && year <= 2100) {
          const date = new Date(year, month - 1, day, hour, minute);
          if (!isNaN(date.getTime())) {
            return date;
          }
        }
      }
    }

    // Try common date formats with converted numerals
    // Format: DD/MM/YYYY or DD-MM-YYYY
    const slashMatch = normalized.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (slashMatch) {
      let day = parseInt(slashMatch[1]);
      let monthNum = parseInt(slashMatch[2]);
      let year = parseInt(slashMatch[3]);
      if (year < 100) year += 2000;

      // Handle both DD/MM/YYYY and MM/DD/YYYY (assume DD/MM for Cambodian context)
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
  KHMER_NUMERALS,
  KHMER_MONTHS
};
