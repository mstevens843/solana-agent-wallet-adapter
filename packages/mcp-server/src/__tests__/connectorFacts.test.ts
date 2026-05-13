import { describe, expect, it } from 'vitest';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { AgentWalletActionService } from '../actionService.js';
import { createMockBackend } from '../mockBackend.js';
import { DEFAULT_CONFIG } from '../config.js';
import {
  fact,
  factsFromJupiterOrderPreview,
  factsFromKaminoReserveSnapshot,
} from '../connectorFacts.js';

describe('connector fact normalization', () => {
  it('maps Kamino reserve snapshots into stable connector facts', () => {
    const facts = factsFromKaminoReserveSnapshot({
      reserveAddress: 'KaminoReserve111111111111111111111111111111',
      reserveMint: 'So11111111111111111111111111111111111111112',
      reserveSymbol: 'SOL',
      decimals: 9,
      supplyApy: 5.4,
      borrowApy: 9.8,
      utilization: 68,
      totalSupply: '1000',
      totalBorrow: '680',
      depositLimit: '2000',
      depositLimitRemaining: '1000',
      withdrawalDelaySec: 0,
      withdrawAvailable: '500',
      lastUpdateSlot: 280000000,
    }, '2026-05-12T00:00:00.000Z');

    expect(facts.map((entry) => entry.label)).toEqual([
      'Reserve',
      'Supply APY',
      'Borrow APY',
      'Utilization',
      'Deposit capacity',
      'Withdraw available',
    ]);
    expect(facts[1]).toMatchObject({
      connectorId: 'kamino',
      value: '5.4%',
      tone: 'good',
      source: 'connector',
      checkedAt: '2026-05-12T00:00:00.000Z',
    });
  });

  it('maps Jupiter order previews into facts without exposing the transaction bytes', () => {
    const facts = factsFromJupiterOrderPreview({
      mode: 'ultra',
      router: 'jupiter',
      requestId: 'req-1',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      outAmount: '2500000',
      slippageBps: 50,
      priceImpact: '0.002',
      hasTransaction: true,
      transaction: 'base64-transaction-should-not-be-copied',
    }, '2026-05-12T00:00:00.000Z');

    expect(facts).toHaveLength(3);
    expect(facts[0]).toMatchObject({
      connectorId: 'jupiter',
      label: 'Jupiter preview',
      value: 'Expected output 2500000',
      tone: 'good',
      detail: {
        mode: 'ultra',
        router: 'jupiter',
        requestId: 'req-1',
        hasTransaction: true,
      },
    });
    expect(JSON.stringify(facts)).not.toContain('base64-transaction-should-not-be-copied');
  });

  it('tones Jupiter numeric string fields consistently', () => {
    const facts = factsFromJupiterOrderPreview({
      outAmount: '2500000',
      slippageBps: '250',
      priceImpact: '0.02',
    }, '2026-05-12T00:00:00.000Z');

    expect(facts.find((entry) => entry.label === 'Slippage')).toMatchObject({
      value: '250 bps',
      tone: 'warn',
    });
    expect(facts.find((entry) => entry.label === 'Price impact')).toMatchObject({
      value: '0.02',
      tone: 'warn',
    });
  });

  it('redacts secret detail fields before returning facts', () => {
    const redacted = fact({
      connectorId: 'jupiter',
      label: 'Provider',
      value: 'configured',
      detail: {
        apiKey: 'sk-secret123456789',
        nested: {
          authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
        },
      },
    });

    expect(redacted.detail).toMatchObject({
      apiKey: '[redacted]',
      nested: {
        authorization: 'Bearer [redacted]',
      },
    });
  });

  it('returns deterministic missing-capability errors for unavailable connector reads', async () => {
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: DEFAULT_CONFIG,
    });

    await expect(service.connectorReadFacts({ connectorId: 'meteora' })).rejects.toMatchObject({
      name: 'ProtocolError',
      code: 'unsupported_method',
      recoverable: false,
      message: expect.stringContaining('Meteora does not expose requested capability read capability'),
    });
  });

  it('preserves ProtocolError instances from connector reads', async () => {
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: DEFAULT_CONFIG,
    });

    await expect(service.connectorReadFacts({ connectorId: 'unknown-protocol' }))
      .rejects.toBeInstanceOf(ProtocolError);
  });
});
