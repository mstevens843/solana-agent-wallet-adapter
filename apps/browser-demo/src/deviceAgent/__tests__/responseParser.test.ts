// Ported from
// apps/android-twa/app/src/test/java/com/agentic/wallet/agent/provider/ProviderResponseParserTest.kt.
// Mirrors the OpenAI / Anthropic extraction precedence and the parseModelJson
// candidate order (direct → code fence → balanced-brace extraction).

import { describe, expect, it } from 'vitest';

import { ProviderHttpError } from '../provider/errorCodes.js';
import {
  extractAnthropicText,
  extractOpenAiText,
  parseModelJson,
} from '../provider/responseParser.js';

describe('extractOpenAiText', () => {
  it('prefers output_text when present and non-empty', () => {
    expect(extractOpenAiText({ output_text: 'hello world' })).toBe('hello world');
  });

  it('falls back to choices[0].message.content', () => {
    const payload = { choices: [{ message: { content: 'from message' } }] };
    expect(extractOpenAiText(payload)).toBe('from message');
  });

  it('falls back to choices[0].text when message is absent', () => {
    const payload = { choices: [{ text: 'direct text' }] };
    expect(extractOpenAiText(payload)).toBe('direct text');
  });

  it('returns empty when nothing matches', () => {
    expect(extractOpenAiText({})).toBe('');
  });

  it('treats non-string output_text as missing and falls through to choices[]', () => {
    const payload = {
      output_text: 42,
      choices: [{ message: { content: 'fallback' } }],
    };
    expect(extractOpenAiText(payload)).toBe('fallback');
  });

  it('returns empty for non-object payloads', () => {
    expect(extractOpenAiText(null)).toBe('');
    expect(extractOpenAiText('string')).toBe('');
    expect(extractOpenAiText([1, 2, 3])).toBe('');
  });
});

describe('extractAnthropicText', () => {
  it('joins multiple text blocks with newlines and skips non-text entries', () => {
    const payload = {
      content: [
        { type: 'text', text: 'alpha' },
        { type: 'tool_use', id: 'tool1' },
        { type: 'text', text: 'beta' },
      ],
    };
    expect(extractAnthropicText(payload)).toBe('alpha\nbeta');
  });

  it('returns empty when there are no text blocks', () => {
    const payload = { content: [{ type: 'tool_use', id: 'tool1' }] };
    expect(extractAnthropicText(payload)).toBe('');
  });

  it('works without a type field (matches planner.ts behavior)', () => {
    const payload = { content: [{ text: 'alpha' }, { text: 'beta' }] };
    expect(extractAnthropicText(payload)).toBe('alpha\nbeta');
  });

  it('skips entries where text is not a string', () => {
    const payload = {
      content: [
        { type: 'text', text: 42 },
        { type: 'text', text: 'ok' },
      ],
    };
    expect(extractAnthropicText(payload)).toBe('ok');
  });
});

describe('parseModelJson', () => {
  it('accepts a bare JSON object', () => {
    const parsed = parseModelJson('{"intent":"swap","route":"jupiter"}');
    expect(parsed.intent).toBe('swap');
    expect(parsed.route).toBe('jupiter');
  });

  it('accepts code-fenced JSON with a language tag', () => {
    const parsed = parseModelJson('```json\n{"intent":"swap"}\n```');
    expect(parsed.intent).toBe('swap');
  });

  it('accepts code-fenced JSON without a language tag', () => {
    const parsed = parseModelJson('```\n{"intent":"swap"}\n```');
    expect(parsed.intent).toBe('swap');
  });

  it('case-insensitive fence detection (```JSON)', () => {
    const parsed = parseModelJson('```JSON\n{"intent":"swap"}\n```');
    expect(parsed.intent).toBe('swap');
  });

  it('accepts JSON embedded in narrative text via balanced-brace extraction', () => {
    const text = [
      'Here is the plan:',
      '{"intent":"transfer SOL","route":"system","risk":"low","approval":"once","safeguards":["confirm recipient"]}',
      'Let me know.',
    ].join('\n');
    const parsed = parseModelJson(text);
    expect(parsed.intent).toBe('transfer SOL');
    const safeguards = parsed.safeguards as unknown[];
    expect(Array.isArray(safeguards)).toBe(true);
    expect(safeguards.length).toBeGreaterThan(0);
  });

  it('throws ProviderHttpError(provider_invalid_response) on non-JSON input', () => {
    let captured: unknown = null;
    try {
      parseModelJson('not json at all');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_invalid_response');
  });

  it('throws on blank input', () => {
    let captured: unknown = null;
    try {
      parseModelJson('   ');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_invalid_response');
  });
});
