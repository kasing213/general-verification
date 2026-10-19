'use strict';

/**
 * Read each image once.
 *
 * Customers resend the same screenshot, often several times within seconds.
 * Every send used to run the full pipeline - 3 Claude agents each - and the
 * resends then collided on the transactionId and came back with a different
 * verdict than the first send. An image is now identified by the sha256 of
 * its bytes; the same bytes, for the same tenant and the same expected
 * payment, are answered from the first run instead of being read again.
 *
 * Two layers:
 *  - Mongo: the scoped key is stored on the payment record (`imageKey`), so a
 *    resend within the window is answered from the stored result, across
 *    restarts and across instances.
 *  - In-process: a send arriving while the first is still being read waits for
 *    that run instead of starting a second one. Per instance only - two
 *    replicas receiving the same image at the same instant can still both
 *    read it, and the transactionId collision then decides the second answer.
 */

const crypto = require('crypto');

const DEFAULT_WINDOW_HOURS = 24;

// imageKey -> Promise of the run currently reading that image
const inFlight = new Map();

function hashImage(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * The image hash scoped to who is asking and what they are asking about. The
 * same receipt checked against a different invoice or expected payment is a
 * different question and must be judged again, and one tenant must never be
 * handed another tenant's stored result.
 */
function imageKey(imageHash, { merchantId, invoiceId, expectedPayment } = {}) {
  const ep = expectedPayment || {};
  const scope = JSON.stringify([
    merchantId == null ? null : String(merchantId),
    invoiceId == null ? null : String(invoiceId),
    ep.amount ?? null,
    ep.currency ?? null,
    ep.toAccount ?? null,
    ep.recipientNames ?? null,
    ep.tolerancePercent ?? null
  ]);
  return crypto.createHash('sha256').update(`${imageHash}|${scope}`).digest('hex');
}

/**
 * How far back a stored result is reused, in ms. IMAGE_DEDUPE_WINDOW_HOURS
 * (default 24). 0 turns the stored-result lookup off; concurrent sends are
 * still coalesced.
 */
function windowMs() {
  const raw = process.env.IMAGE_DEDUPE_WINDOW_HOURS;
  const hours = raw === undefined || raw === '' ? DEFAULT_WINDOW_HOURS : Number(raw);
  if (!Number.isFinite(hours)) return DEFAULT_WINDOW_HOURS * 3600 * 1000;
  return hours > 0 ? hours * 3600 * 1000 : 0;
}

/**
 * Run `fn` for `key` unless a run for the same key is already in flight, in
 * which case wait for that one. Returns { value, joined }; joined is true for
 * every caller that did not start the run. A failed run fails its waiters too.
 */
async function runOnce(key, fn) {
  const running = inFlight.get(key);
  if (running) return { value: await running, joined: true };

  const run = Promise.resolve().then(fn);
  inFlight.set(key, run);
  try {
    return { value: await run, joined: false };
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);
  }
}

module.exports = {
  hashImage,
  imageKey,
  windowMs,
  runOnce,
  DEFAULT_WINDOW_HOURS,
  _inFlight: inFlight
};
