import { describe, expect, it } from 'vitest';

import { validateAgentCardOverrides } from '../dev/agentCard.js';

describe('validateAgentCardOverrides', () => {
  it('accepts empty object', () => {
    const result = validateAgentCardOverrides({});
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({});
  });

  it('rejects non-object input', () => {
    expect(validateAgentCardOverrides(null).valid).toBe(false);
    expect(validateAgentCardOverrides('hi').valid).toBe(false);
    expect(validateAgentCardOverrides([]).valid).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const result = validateAgentCardOverrides({ foo: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('$.foo'))).toBe(true);
  });

  it('rejects oversized description', () => {
    const result = validateAgentCardOverrides({ description: 'x'.repeat(501) });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('$.description') && e.includes('max'))).toBe(true);
  });

  it('rejects non-https documentationUrl', () => {
    const result = validateAgentCardOverrides({ documentationUrl: 'http://insecure.example.com' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('$.documentationUrl'))).toBe(true);
  });

  it('rejects malformed email', () => {
    expect(validateAgentCardOverrides({ contactEmail: 'no-at' }).valid).toBe(false);
    expect(validateAgentCardOverrides({ contactEmail: 'a@b' }).valid).toBe(false);
  });

  it('rejects lowercase token symbols', () => {
    const result = validateAgentCardOverrides({ supportedTokens: ['usdc'] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('supportedTokens[0]'))).toBe(true);
  });

  it('rejects bad skill id format', () => {
    const result = validateAgentCardOverrides({
      extraSkills: [{ id: 'Bad Id!', name: 'X', description: 'd' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('extraSkills[0].id'))).toBe(true);
  });

  it('rejects duplicate skill ids', () => {
    const result = validateAgentCardOverrides({
      extraSkills: [
        { id: 'dup', name: 'A', description: 'd' },
        { id: 'dup', name: 'B', description: 'd' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate id "dup"'))).toBe(true);
  });

  it('rejects too many extraSkills', () => {
    const skills = Array.from({ length: 17 }, (_, i) => ({
      id: `s.${i}`,
      name: `S${i}`,
      description: 'd',
    }));
    const result = validateAgentCardOverrides({ extraSkills: skills });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('$.extraSkills') && e.includes('max'))).toBe(true);
  });

  it('round-trips a valid overrides payload', () => {
    const input = {
      description: 'Custom description.',
      documentationUrl: 'https://example.com/docs',
      contactEmail: 'ops@example.com',
      supportedTokens: ['USDC', 'BONK'],
      extraSkills: [
        { id: 'extra.one', name: 'Extra One', description: 'Hello.', tags: ['custom'] },
        { id: 'extra.two', name: 'Extra Two', description: 'Hi.' },
      ],
    };
    const result = validateAgentCardOverrides(input);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.value).toEqual(input);
  });

  it('strips reference equality (returned arrays are copies)', () => {
    const tokens = ['USDC'];
    const input = { supportedTokens: tokens };
    const result = validateAgentCardOverrides(input);
    expect(result.valid).toBe(true);
    tokens.push('MUTATED');
    expect(result.value?.supportedTokens).toEqual(['USDC']);
  });
});
