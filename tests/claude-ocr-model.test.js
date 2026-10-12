'use strict';

// Model selection + request shape for the Claude 3-agent OCR path.
// The SDK is mocked: no network, no API spend.

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
);

const ENV_KEYS = [
  'CLAUDE_OCR_MODEL',
  'CLAUDE_OCR_MODEL_DATE',
  'CLAUDE_OCR_MODEL_AMOUNT',
  'CLAUDE_OCR_MODEL_META',
  'CLAUDE_OCR_MAX_TOKENS',
  'CLAUDE_OCR_EFFORT',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY'
];

function reply(json, extra = {}) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(json) }],
    usage: { input_tokens: 1600, output_tokens: 40 },
    ...extra
  };
}

function mockAgents() {
  mockCreate.mockImplementation(async (req) => {
    const prompt = req.messages[0].content[1].text;
    if (prompt.includes('transaction date/time')) return reply({ dateRaw: '១២ ឧសភា ២០២៦ | 03:15 ល្ងាច' });
    if (prompt.includes('amount fields')) return reply({ amount: 26000, currency: 'KHR' });
    return reply({
      isBankStatement: true,
      isPaid: true,
      confidence: 'high',
      transactionId: 'FT26132ABCDEF1234',
      toAccount: '000***123',
      recipientName: 'CHAN K. & SOK D.',
      bankName: 'ABA'
    });
  });
}

let saved;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  mockCreate.mockReset();
  jest.resetModules();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

function load() {
  return require('../src/services/claude-ocr');
}

describe('model selection', () => {
  test('defaults all three agents to Claude Haiku 4.5', async () => {
    mockAgents();
    const ocr = load();
    expect(ocr._internals.DEFAULT_MODEL).toBe('claude-haiku-4-5-20251001');
    await ocr.extractWithClaude(Buffer.from('img'));
    expect(mockCreate).toHaveBeenCalledTimes(3);
    for (const [req] of mockCreate.mock.calls) {
      expect(req.model).toBe('claude-haiku-4-5-20251001');
      expect(req.max_tokens).toBe(600);
      // Haiku 4.5 rejects effort and needs no thinking config.
      expect(req.output_config).toBeUndefined();
      expect(req.thinking).toBeUndefined();
      expect(req.temperature).toBeUndefined();
    }
  });

  test('rollback is env-only: CLAUDE_OCR_MODEL=claude-sonnet-4-6', async () => {
    process.env.CLAUDE_OCR_MODEL = 'claude-sonnet-4-6';
    mockAgents();
    const ocr = load();
    expect(ocr._internals.ROLLBACK_MODEL).toBe('claude-sonnet-4-6');
    await ocr.extractWithClaude(Buffer.from('img'));
    for (const [req] of mockCreate.mock.calls) {
      expect(req.model).toBe('claude-sonnet-4-6');
      expect(req.max_tokens).toBe(600);
      expect(req.output_config).toBeUndefined();
    }
  });

  test('per-agent override applies to that agent only', async () => {
    process.env.CLAUDE_OCR_MODEL_DATE = 'claude-sonnet-4-6';
    mockAgents();
    const ocr = load();
    await ocr.extractWithClaude(Buffer.from('img'));
    const byPrompt = Object.fromEntries(mockCreate.mock.calls.map(([req]) => {
      const p = req.messages[0].content[1].text;
      const label = p.includes('transaction date/time') ? 'DATE' : p.includes('amount fields') ? 'AMOUNT' : 'META';
      return [label, req.model];
    }));
    expect(byPrompt).toEqual({
      DATE: 'claude-sonnet-4-6',
      AMOUNT: 'claude-haiku-4-5-20251001',
      META: 'claude-haiku-4-5-20251001'
    });
  });

  test('blank env value falls back to the default', () => {
    process.env.CLAUDE_OCR_MODEL = '   ';
    expect(load()._internals.resolveModel('META')).toBe('claude-haiku-4-5-20251001');
  });
});

describe('request options', () => {
  test('adaptive-by-default models get low effort and room for thinking', () => {
    const { requestOptionsFor } = load()._internals;
    expect(requestOptionsFor('claude-haiku-5-5')).toEqual({ max_tokens: 4000, output_config: { effort: 'low' } });
    expect(requestOptionsFor('claude-haiku-4-5-20251001')).toEqual({ max_tokens: 600 });
    expect(requestOptionsFor('claude-sonnet-4-6')).toEqual({ max_tokens: 600 });
  });

  test('CLAUDE_OCR_MAX_TOKENS and CLAUDE_OCR_EFFORT override', () => {
    process.env.CLAUDE_OCR_MAX_TOKENS = '1200';
    process.env.CLAUDE_OCR_EFFORT = 'medium';
    const { requestOptionsFor } = load()._internals;
    expect(requestOptionsFor('claude-haiku-5-5')).toEqual({ max_tokens: 1200, output_config: { effort: 'medium' } });
    expect(requestOptionsFor('claude-haiku-4-5-20251001')).toEqual({ max_tokens: 1200 });
  });
});

describe('response handling', () => {
  test('extracts fields unchanged and skips leading thinking blocks', async () => {
    mockAgents();
    const base = mockCreate.getMockImplementation();
    mockCreate.mockImplementation(async (req) => {
      const r = await base(req);
      return { ...r, content: [{ type: 'thinking', thinking: '', signature: 'x' }, ...r.content] };
    });
    const out = await load().extractWithClaude(Buffer.from('img'));
    expect(out).toMatchObject({
      isBankStatement: true,
      isPaid: true,
      amount: 26000,
      currency: 'KHR',
      transactionId: 'FT26132ABCDEF1234',
      dateRaw: '១២ ឧសភា ២០២៦ | 03:15 ល្ងាច',
      recipientName: 'CHAN K. & SOK D.',
      bankName: 'ABA'
    });
    expect(Object.keys(out)).not.toContain('_usage');
  });

  test('a refusal on one agent degrades that agent only', async () => {
    mockAgents();
    const base = mockCreate.getMockImplementation();
    mockCreate.mockImplementation(async (req) => {
      if (req.messages[0].content[1].text.includes('amount fields')) {
        return { stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 0 } };
      }
      return base(req);
    });
    const out = await load().extractWithClaude(Buffer.from('img'));
    expect(out.amount).toBeNull();
    expect(out.currency).toBeNull();
    expect(out.transactionId).toBe('FT26132ABCDEF1234');
  });

  test('cost estimate uses published per-MTok prices', () => {
    const { estimateCostUsd } = load()._internals;
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(estimateCostUsd('claude-haiku-4-5-20251001', usage)).toBeCloseTo(6.0);
    expect(estimateCostUsd('claude-sonnet-4-6', usage)).toBeCloseTo(18.0);
    expect(estimateCostUsd('claude-haiku-5-5', usage)).toBeCloseTo(0.6);
    expect(estimateCostUsd('some-unknown-model', usage)).toBeNull();
  });
});
