'use strict';

/**
 * Bank-name matching for the (informational) bank check.
 *
 * The check used to be `read.toLowerCase().includes(expected.toLowerCase())`.
 * A shop that saved "ABA " (trailing space) or "ABA Bank" failed against a
 * receipt the reader returned as plain "ABA", so a correct ABA payment showed
 * a red "Bank: did not match" (staging 2026-10-22). Both sides are now reduced
 * to a canonical bank code first; unknown names fall back to a whitespace and
 * punctuation-insensitive containment check in either direction.
 */

const BANK_ALIASES = [
  ['ABA', [/\baba\b/, /advanced bank of asia/]],
  ['ACLEDA', [/\bacleda\b/]],
  ['WING', [/\bwing\b/]],
  ['CANADIA', [/\bcanadia\b/]],
  ['PRINCE', [/\bprince\b/]],
  ['SATHAPANA', [/\bsathapana\b/]],
  ['CHIP MONG', [/\bchip ?mong\b/]],
  ['WOORI', [/\bwoori\b/]],
  ['HATTHA', [/\bhattha\b/]],
  ['AMK', [/\bamk\b/]],
  ['BAKONG', [/\bbakong\b/]],
  ['TRUEMONEY', [/\btrue ?money\b/]],
  ['PIPAY', [/\bpi ?pay\b/]],
];

function clean(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9ក-៿]+/g, ' ')
    .trim();
}

function canonicalBank(name) {
  const text = clean(name);
  if (!text) return null;
  for (const [code, patterns] of BANK_ALIASES) {
    if (patterns.some((p) => p.test(text))) return code;
  }
  return null;
}

function banksMatch(expected, read) {
  const a = clean(expected);
  const b = clean(read);
  if (!a || !b) return false;
  const ca = canonicalBank(a);
  const cb = canonicalBank(b);
  if (ca && cb) return ca === cb;
  return a.includes(b) || b.includes(a);
}

module.exports = { canonicalBank, banksMatch };
