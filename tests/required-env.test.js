const { missingRequiredEnv, optionalEnvWarnings } = require('../src/config/required-env');

const base = { MONGO_URL: 'mongodb://x', API_KEY: 'k', SERVICE_JWT_SECRET: 's' };

describe('startup env check', () => {
  test('OpenAI key is optional', () => {
    expect(missingRequiredEnv(base)).toEqual([]);
    expect(optionalEnvWarnings(base)).toHaveLength(1);
  });

  test('still requires Mongo, API key and a JWT secret', () => {
    expect(missingRequiredEnv({})).toEqual([
      'MONGO_URL', 'API_KEY', 'JWT_SECRET (or SERVICE_JWT_SECRET)',
    ]);
  });

  test('no warning when the OpenAI key is set', () => {
    expect(optionalEnvWarnings({ ...base, OPENAI_API_KEY: 'sk' })).toEqual([]);
  });
});
