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
  'CLAUDE_OCR_THINKING',
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
  test('defaults all three agents to Claude Haiku 5.5, thinking off, effort low', async () => {
    mockAgents();
    const ocr = load();
    expect(ocr._internals.DEFAULT_MODEL).toBe('claude-haiku-5-5');
    await ocr.extractWithClaude(Buffer.from('img'));
    expect(mockCreate).toHaveBeenCalledTimes(3);
    for (const [req] of mockCreate.mock.calls) {
      expect(req.model).toBe('claude-haiku-5-5');
      expect(req.max_tokens).toBe(1000);
      expect(req.thinking).toEqual({ type: 'disabled' });
      expect(req.output_config).toEqual({ effort: 'low' });
      // 400 on Haiku 5.5: never send sampling params or a prefill.
      expect(req.temperature).toBeUndefined();
      expect(req.top_p).toBeUndefined();
      expect(req.top_k).toBeUndefined();
      expect(req.messages[req.messages.length - 1].role).toBe('user');
    }
  });

  test('fallback is env-only: CLAUDE_OCR_MODEL=claude-haiku-4-5-20251001', async () => {
    process.env.CLAUDE_OCR_MODEL = 'claude-haiku-4-5-20251001';
    mockAgents();
    const ocr = load();
    expect(ocr._internals.FALLBACK_MODEL).toBe('claude-haiku-4-5-20251001');
    await ocr.extractWithClaude(Buffer.from('img'));
    for (const [req] of mockCreate.mock.calls) {
      expect(req.model).toBe('claude-haiku-4-5-20251001');
      expect(req.max_tokens).toBe(600);
      // Haiku 4.5 rejects effort and needs no thinking config.
      expect(req.output_config).toBeUndefined();
      expect(req.thinking).toBeUndefined();
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
      AMOUNT: 'claude-haiku-5-5',
      META: 'claude-haiku-5-5'
    });
  });

  test('blank env value falls back to the default', () => {
    process.env.CLAUDE_OCR_MODEL = '   ';
    expect(load()._internals.resolveModel('META')).toBe('claude-haiku-5-5');
  });
});

describe('request options', () => {
  test('per-model shapes', () => {
    const { requestOptionsFor } = load()._internals;
    expect(requestOptionsFor('claude-haiku-5-5'))
      .toEqual({ max_tokens: 1000, thinking: { type: 'disabled' }, output_config: { effort: 'low' } });
    expect(requestOptionsFor('claude-haiku-4-5-20251001')).toEqual({ max_tokens: 600 });
    expect(requestOptionsFor('claude-sonnet-4-6')).toEqual({ max_tokens: 600 });
    // Opus 5.5 rejects thinking "disabled" at every effort: adaptive + effort only.
    expect(requestOptionsFor('claude-opus-5-5')).toEqual({ max_tokens: 4000, output_config: { effort: 'low' } });
  });

  test('CLAUDE_OCR_THINKING=adaptive lets Haiku 5.5 think, with room for it', () => {
    process.env.CLAUDE_OCR_THINKING = 'adaptive';
    const { requestOptionsFor } = load()._internals;
    expect(requestOptionsFor('claude-haiku-5-5')).toEqual({ max_tokens: 4000, output_config: { effort: 'low' } });
  });

  test('thinking stays adaptive at xhigh/max, where "disabled" would 400', () => {
    process.env.CLAUDE_OCR_EFFORT = 'xhigh';
    const { requestOptionsFor } = load()._internals;
    expect(requestOptionsFor('claude-haiku-5-5')).toEqual({ max_tokens: 4000, output_config: { effort: 'xhigh' } });
  });

  test('CLAUDE_OCR_MAX_TOKENS and CLAUDE_OCR_EFFORT override', () => {
    process.env.CLAUDE_OCR_MAX_TOKENS = '1200';
    process.env.CLAUDE_OCR_EFFORT = 'medium';
    const { requestOptionsFor } = load()._internals;
    expect(requestOptionsFor('claude-haiku-5-5'))
      .toEqual({ max_tokens: 1200, thinking: { type: 'disabled' }, output_config: { effort: 'medium' } });
    expect(requestOptionsFor('claude-haiku-4-5-20251001')).toEqual({ max_tokens: 1200 });
  });
});

describe('image media type', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary');

  async function sentMediaTypes(input, options) {
    mockAgents();
    await load().extractWithClaude(input, options);
    return mockCreate.mock.calls.map(([req]) => req.messages[0].content[0].source.media_type);
  }

  // A PNG labelled image/jpeg is a 400 on all 3 agents -> empty fields ->
  // NOT_BANK_STATEMENT on a real receipt (staging, 2026-10-19).
  test('a PNG buffer is sent as image/png', async () => {
    expect(await sentMediaTypes(PNG)).toEqual(['image/png', 'image/png', 'image/png']);
  });

  test('a base64 PNG string is sent as image/png', async () => {
    expect(await sentMediaTypes(PNG.toString('base64'))).toEqual(['image/png', 'image/png', 'image/png']);
  });

  test('JPEG and WEBP are detected from their bytes', async () => {
    expect(await sentMediaTypes(JPEG)).toEqual(['image/jpeg', 'image/jpeg', 'image/jpeg']);
    mockCreate.mockReset();
    expect(await sentMediaTypes(WEBP)).toEqual(['image/webp', 'image/webp', 'image/webp']);
  });

  test('the bytes win over a wrong caller-supplied mediaType', async () => {
    expect(await sentMediaTypes(PNG, { mediaType: 'image/jpeg' }))
      .toEqual(['image/png', 'image/png', 'image/png']);
  });
});

describe('response handling', () => {
  test('extractJson tolerates prose and stray braces around the JSON', () => {
    const { extractJson } = load()._internals;
    expect(extractJson('{"amount": 26000, "currency": "KHR"}')).toEqual({ amount: 26000, currency: 'KHR' });
    expect(extractJson('Reading the header {big number}. Answer:\n{"amount": 26000, "currency": "KHR"}'))
      .toEqual({ amount: 26000, currency: 'KHR' });
    expect(extractJson('{"recipientName": "A } B", "bankName": "ABA"}'))
      .toEqual({ recipientName: 'A } B', bankName: 'ABA' });
    expect(extractJson('no json here')).toBeNull();
  });

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
    expect(estimateCostUsd('claude-haiku-5-5', { input_tokens: 5000, output_tokens: 100 })).toBeCloseTo(0.00055, 6);
    // Over 100k prompt tokens Haiku 5.5 bills the long-prompt tier ($0.50 / $2.50).
    expect(estimateCostUsd('claude-haiku-5-5', usage)).toBeCloseTo(3.0);
    expect(estimateCostUsd('some-unknown-model', usage)).toBeNull();
  });
});
