import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildAgenticAgentCard } from '../builder.js';
import { defaultAgenticCapabilities } from '../defaultCapabilities.js';
import { validateAgentCard } from '../validator.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleCard = JSON.parse(readFileSync(resolve(here, 'fixtures/sample-card.json'), 'utf8'));

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

describe('validateAgentCard', () => {
  it('accepts a hand-written fixture (independent of the builder)', () => {
    const result = validateAgentCard(sampleCard);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.value).toBeDefined();
  });

  it('accepts a builder-produced card with default capabilities', () => {
    const card = buildAgenticAgentCard({
      walletAddress: DEV_WALLET,
      baseUrl: 'https://agentic-signer.com',
      supportedTokens: ['USDC', 'USDT', 'SOL'],
      capabilities: defaultAgenticCapabilities,
    });
    const result = validateAgentCard(card);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validateAgentCard(null).valid).toBe(false);
    expect(validateAgentCard('not a card').valid).toBe(false);
    expect(validateAgentCard([]).valid).toBe(false);
  });

  it('reports missing required A2A fields with JSON paths', () => {
    const result = validateAgentCard({});
    expect(result.valid).toBe(false);
    const joined = result.errors.join('\n');
    expect(joined).toMatch(/\$\.name/);
    expect(joined).toMatch(/\$\.description/);
    expect(joined).toMatch(/\$\.url/);
    expect(joined).toMatch(/\$\.capabilities/);
    expect(joined).toMatch(/\$\.skills/);
    expect(joined).toMatch(/\$\.walletAddress/);
    expect(joined).toMatch(/\$\.supportedProtocols/);
    expect(joined).toMatch(/\$\.supportedTokens/);
    expect(joined).toMatch(/\$\.paymentMethods/);
    expect(joined).toMatch(/\$\.serviceEndpoint/);
  });

  it('rejects duplicate skill ids', () => {
    const broken = {
      ...sampleCard,
      skills: [
        { id: 'dup', name: 'A', description: 'd', tags: [] },
        { id: 'dup', name: 'B', description: 'd', tags: [] },
      ],
    };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate skill id "dup"'))).toBe(true);
  });

  it('rejects bad URLs', () => {
    const broken = { ...sampleCard, url: 'ftp://nope.example.com' };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('$.url'))).toBe(true);
  });

  it('allows http://localhost for dev', () => {
    const dev = {
      ...sampleCard,
      url: 'http://localhost:8787',
      serviceEndpoint: 'http://localhost:8787',
    };
    const result = validateAgentCard(dev);
    expect(result.errors.filter((e) => /url|serviceEndpoint/.test(e))).toEqual([]);
  });

  it('rejects bad wallet address (too short)', () => {
    const broken = { ...sampleCard, walletAddress: 'tooShort' };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('walletAddress'))).toBe(true);
  });

  it('rejects non-base58 chars in wallet address', () => {
    const broken = { ...sampleCard, walletAddress: '0OIl' + 'a'.repeat(32) };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('walletAddress'))).toBe(true);
  });

  it('rejects unknown supportedProtocols values', () => {
    const broken = { ...sampleCard, supportedProtocols: ['ap2', 'evil'] };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('supportedProtocols[1]') && e.includes('evil')),
    ).toBe(true);
  });

  it('rejects unknown paymentMethod protocol', () => {
    const broken = {
      ...sampleCard,
      paymentMethods: [{ protocol: 'bitcoin-lightning' }],
    };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('paymentMethods[0].protocol'))).toBe(true);
  });

  it('tolerates unknown top-level extension keys', () => {
    const extended = { ...sampleCard, __agenticPrivateExt: { foo: 'bar' } };
    expect(validateAgentCard(extended).valid).toBe(true);
  });

  it('rejects malformed email in contactEmail', () => {
    const broken = { ...sampleCard, contactEmail: 'not-an-email' };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('contactEmail'))).toBe(true);
  });

  it('rejects empty supportedProtocols', () => {
    const broken = { ...sampleCard, supportedProtocols: [] };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('$.supportedProtocols'))).toBe(true);
  });

  it('rejects duplicate supportedTokens (case-insensitive)', () => {
    const broken = { ...sampleCard, supportedTokens: ['USDC', 'usdc'] };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate token'))).toBe(true);
  });

  it('rejects provider with non-https url', () => {
    const broken = {
      ...sampleCard,
      provider: { organization: 'Agentic Signer', url: 'ftp://example.com' },
    };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('$.provider.url'))).toBe(true);
  });

  it('rejects provider with missing organization', () => {
    const broken = {
      ...sampleCard,
      provider: { organization: '', url: 'https://agentic-signer.com' },
    };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('$.provider.organization'))).toBe(true);
  });

  it('rejects walletAddress at 31 chars (below min)', () => {
    const broken = { ...sampleCard, walletAddress: '4fTq' + 'a'.repeat(27) }; // 31 total
    const result = validateAgentCard(broken);
    expect(broken.walletAddress.length).toBe(31);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('walletAddress'))).toBe(true);
  });

  it('accepts walletAddress at 32 chars (min boundary)', () => {
    const card = {
      ...sampleCard,
      walletAddress: '4fTq' + 'a'.repeat(28), // 32 total, all base58
    };
    expect(card.walletAddress.length).toBe(32);
    const result = validateAgentCard(card);
    expect(result.errors.filter((e) => e.includes('walletAddress'))).toEqual([]);
  });

  it('rejects walletAddress at 45 chars (above max)', () => {
    const broken = { ...sampleCard, walletAddress: '4fTq' + 'a'.repeat(41) }; // 45 total
    const result = validateAgentCard(broken);
    expect(broken.walletAddress.length).toBe(45);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('walletAddress'))).toBe(true);
  });

  it('rejects malformed skill.examples (non-string array)', () => {
    const broken = {
      ...sampleCard,
      skills: [
        { id: 's.one', name: 'One', description: 'd', tags: ['t'], examples: 'not-an-array' },
      ],
    };
    const result = validateAgentCard(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('skills[0].examples'))).toBe(true);
  });
});
