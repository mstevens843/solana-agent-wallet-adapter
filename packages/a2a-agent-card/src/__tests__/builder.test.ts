import { describe, expect, it } from 'vitest';

import { buildAgenticAgentCard } from '../builder.js';
import { defaultAgenticCapabilities } from '../defaultCapabilities.js';
import { validateAgentCard } from '../validator.js';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

describe('buildAgenticAgentCard', () => {
  it('produces a card that validates against the A2A schema', () => {
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

  it('mirrors serviceEndpoint and url, trimming trailing slashes', () => {
    const card = buildAgenticAgentCard({
      walletAddress: DEV_WALLET,
      baseUrl: 'https://agentic-signer.com/',
      supportedTokens: ['USDC'],
      capabilities: [],
    });
    expect(card.url).toBe('https://agentic-signer.com');
    expect(card.serviceEndpoint).toBe('https://agentic-signer.com');
  });

  it('declares all master-plan-required fields', () => {
    const card = buildAgenticAgentCard({
      walletAddress: DEV_WALLET,
      baseUrl: 'https://agentic-signer.com',
      supportedTokens: ['USDC', 'USDT', 'SOL'],
      capabilities: defaultAgenticCapabilities,
    });
    expect(card.name).toBeTruthy();
    expect(card.description).toBeTruthy();
    expect(card.version).toBeTruthy();
    expect(card.serviceEndpoint).toBeTruthy();
    expect(card.supportedProtocols).toEqual(['ap2', 'acp', 'a2a']);
    expect(card.supportedTokens).toEqual(['USDC', 'USDT', 'SOL']);
    expect(card.paymentMethods.length).toBeGreaterThan(0);
    expect(card.walletAddress).toBe(DEV_WALLET);
    expect(card.skills.length).toBe(defaultAgenticCapabilities.length);
  });

  it('maps every capability to a skill, preserving optional arrays', () => {
    const card = buildAgenticAgentCard({
      walletAddress: DEV_WALLET,
      baseUrl: 'https://agentic-signer.com',
      supportedTokens: ['USDC'],
      capabilities: [
        {
          id: 'custom.one',
          name: 'Custom One',
          description: 'A custom capability.',
          tags: ['custom'],
          examples: ['Example A'],
          inputModes: ['application/json'],
          outputModes: ['application/json'],
        },
      ],
    });
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]).toEqual({
      id: 'custom.one',
      name: 'Custom One',
      description: 'A custom capability.',
      tags: ['custom'],
      examples: ['Example A'],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
    });
  });

  it('builds default payment methods from baseUrl and supportedTokens', () => {
    const card = buildAgenticAgentCard({
      walletAddress: DEV_WALLET,
      baseUrl: 'https://agentic-signer.com',
      supportedTokens: ['USDC', 'SOL'],
      capabilities: [],
    });
    const ap2 = card.paymentMethods.find((m) => m.protocol === 'ap2-inbound');
    const acp = card.paymentMethods.find((m) => m.protocol === 'acp-outbound');
    const spl = card.paymentMethods.find((m) => m.protocol === 'spl-transfer');
    expect(ap2?.endpoint).toBe('https://agentic-signer.com/api/ap2/inbound');
    expect(acp?.endpoint).toBe('https://agentic-signer.com/api/acp/cart/preview');
    expect(spl?.tokens).toEqual(['USDC', 'SOL']);
    expect(spl?.network).toBe('solana-mainnet');
  });

  it('honours supplied overrides', () => {
    const card = buildAgenticAgentCard({
      walletAddress: DEV_WALLET,
      baseUrl: 'https://agentic-signer.com',
      supportedTokens: ['USDC'],
      capabilities: [],
      name: 'Override Wallet',
      description: 'Override description.',
      version: '1.2.3',
      protocolVersion: '0.2.6',
      documentationUrl: 'https://agentic-signer.com/docs',
      contactEmail: 'team@agentic-signer.com',
      provider: { organization: 'Agentic Signer', url: 'https://agentic-signer.com' },
      supportedProtocols: ['ap2', 'acp'],
      paymentMethods: [{ protocol: 'spl-transfer', tokens: ['USDC'], network: 'solana-mainnet' }],
    });
    expect(card.name).toBe('Override Wallet');
    expect(card.description).toBe('Override description.');
    expect(card.version).toBe('1.2.3');
    expect(card.protocolVersion).toBe('0.2.6');
    expect(card.documentationUrl).toBe('https://agentic-signer.com/docs');
    expect(card.contactEmail).toBe('team@agentic-signer.com');
    expect(card.provider).toEqual({ organization: 'Agentic Signer', url: 'https://agentic-signer.com' });
    expect(card.supportedProtocols).toEqual(['ap2', 'acp']);
    expect(card.paymentMethods).toEqual([
      { protocol: 'spl-transfer', tokens: ['USDC'], network: 'solana-mainnet' },
    ]);
  });

  it('preserves unknown token symbols verbatim', () => {
    const card = buildAgenticAgentCard({
      walletAddress: DEV_WALLET,
      baseUrl: 'https://agentic-signer.com',
      supportedTokens: ['USDC', 'BONK', 'JUP', 'JTO'],
      capabilities: [],
    });
    expect(card.supportedTokens).toEqual(['USDC', 'BONK', 'JUP', 'JTO']);
  });

  it('does not share array references with the input (no aliasing)', () => {
    const tokens = ['USDC'];
    const card = buildAgenticAgentCard({
      walletAddress: DEV_WALLET,
      baseUrl: 'https://agentic-signer.com',
      supportedTokens: tokens,
      capabilities: [],
    });
    tokens.push('MUTATED');
    expect(card.supportedTokens).toEqual(['USDC']);
  });
});
