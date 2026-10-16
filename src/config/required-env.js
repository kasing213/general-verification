/**
 * Startup environment check.
 *
 * OPENAI_API_KEY is NOT required: Claude does the reading, and every OpenAI
 * path (GPT fallback, escalation) already checks for a missing client. Making
 * it required crash-looped a staging deploy that had no OpenAI key.
 */
const REQUIRED = ['MONGO_URL', 'API_KEY'];

function missingRequiredEnv(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  // JWT secret may be supplied under either name (see merchant-auth.js).
  if (!env.JWT_SECRET && !env.SERVICE_JWT_SECRET) {
    missing.push('JWT_SECRET (or SERVICE_JWT_SECRET)');
  }
  return missing;
}

function optionalEnvWarnings(env = process.env) {
  const warnings = [];
  if (!env.OPENAI_API_KEY) {
    warnings.push('OPENAI_API_KEY not set: GPT fallback and escalation are disabled');
  }
  return warnings;
}

module.exports = { missingRequiredEnv, optionalEnvWarnings };
