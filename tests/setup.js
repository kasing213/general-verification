// Test setup file
process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-api-key';
process.env.LEARNING_API_KEY = 'test-learning-key';

// Suppress console logs during tests
if (process.env.SUPPRESS_LOGS !== 'false') {
  global.console = {
    ...console,
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn()
  };
}
