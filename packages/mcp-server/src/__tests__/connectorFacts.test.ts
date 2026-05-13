import { describe, expect, it } from 'vitest';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { AgentWalletActionService } from '../actionService.js';
import { createMockBackend } from '../mockBackend.js';
import { DEFAULT_CONFIG } from '../config.js';
import {
  fact,
  factsFromJupiterOrderPreview,
  factsFromKaminoReserveSnapshot,
  factsFromMarginfiAccountDetail,
  factsFromMarginfiBankSnapshot,
  factsFromMarginfiHealthPreview,
  factsFromOrcaPositionDetail,
  factsFromOrcaWhirlpoolSnapshot,
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
      otherAmountThreshold: '2400000',
      slippageBps: 50,
      priceImpact: '0.002',
      routePlan: [{ label: 'Meteora DLMM', percent: 100 }],
      feeBps: 2,
      hasTransaction: true,
      transaction: 'base64-transaction-should-not-be-copied',
    }, '2026-05-12T00:00:00.000Z');

    expect(facts).toHaveLength(6);
    expect(facts[0]).toMatchObject({
      connectorId: 'jupiter',
      label: 'Jupiter Swap API v2 preview',
      value: 'Expected output 2500000',
      tone: 'good',
      detail: {
        mode: 'ultra',
        router: 'jupiter',
        requestId: 'req-1',
        hasTransaction: true,
      },
    });
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Minimum output', value: '2400000', tone: 'good' }),
      expect.objectContaining({ label: 'Fees', value: '2 bps' }),
    ]));
    expect(JSON.stringify(facts)).not.toContain('base64-transaction-should-not-be-copied');
  });

  it('maps Orca Whirlpool snapshots into stable connector facts', () => {
    const facts = factsFromOrcaWhirlpoolSnapshot({
      whirlpoolAddress: '11111111111111111111111111111111',
      programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      configAddress: '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ',
      tokenMintA: 'So11111111111111111111111111111111111111112',
      tokenMintB: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tickSpacing: 8,
      feeRateBps: 30,
      currentTickIndex: 64,
      currentPrice: '150',
      sqrtPrice: '123456',
      liquidity: '100000',
    }, '2026-05-12T00:00:00.000Z');

    expect(facts.map((entry) => entry.label)).toEqual([
      'Orca Whirlpool',
      'Current tick',
      'Liquidity',
    ]);
    expect(facts[0]).toMatchObject({
      connectorId: 'orca',
      tone: 'good',
      source: 'connector',
      checkedAt: '2026-05-12T00:00:00.000Z',
    });
  });

  it('maps Orca position detail into range and rewards facts', () => {
    const facts = factsFromOrcaPositionDetail({
      positionMint: 'So11111111111111111111111111111111111111112',
      whirlpoolAddress: '11111111111111111111111111111111',
      tickLowerIndex: 56,
      tickUpperIndex: 80,
      currentTickIndex: 90,
      inRange: false,
      liquidity: '5000',
      feesOwed: [{ mint: 'So11111111111111111111111111111111111111112', amount: '0.001', symbol: 'SOL' }],
      rewardsOwed: [{ mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', amount: '2', symbol: 'JUP' }],
      warnings: ['Current Whirlpool tick is outside the selected position range.'],
    }, '2026-05-12T00:00:00.000Z');

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.stringContaining('Position'), tone: 'warn' }),
      expect.objectContaining({ label: 'Claimable fees', value: '0.001 SOL' }),
      expect.objectContaining({ label: 'Claimable rewards', value: '2 JUP' }),
      expect.objectContaining({ label: 'Position warnings', tone: 'warn' }),
    ]));
  });

  it('maps MarginFi bank snapshots into stable connector facts', () => {
    const facts = factsFromMarginfiBankSnapshot({
      bankAddress: 'Bank111111111111111111111111111111111111111',
      bankMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tokenSymbol: 'USDC',
      decimals: 6,
      depositApy: 4.2,
      borrowApr: 7.1,
      utilization: 62,
      totalAssets: '1000',
      totalLiabilities: '620',
      depositCapacity: '500',
      borrowCapacity: '200',
    }, '2026-05-12T00:00:00.000Z');

    expect(facts.map((entry) => entry.label)).toEqual([
      'MarginFi bank',
      'Deposit APY',
      'Borrow APR',
      'Utilization',
      'Deposit capacity',
      'Borrow capacity',
    ]);
    expect(facts[1]).toMatchObject({
      connectorId: 'marginfi',
      value: '4.2%',
      tone: 'good',
      source: 'connector',
      checkedAt: '2026-05-12T00:00:00.000Z',
    });
  });

  it('maps MarginFi account details into position and health facts', () => {
    const facts = factsFromMarginfiAccountDetail({
      marginfiAccount: '11111111111111111111111111111111',
      authority: 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV',
      activeBalances: 1,
      health: {
        assets: '100',
        liabilities: '40',
        netValue: '60',
        healthRatio: 2.5,
        healthRatioText: '2.5',
        healthy: true,
      },
      positions: [{
        bankAddress: 'Bank111111111111111111111111111111111111111',
        bankMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        tokenSymbol: 'USDC',
        decimals: 6,
        suppliedAmount: '5',
        borrowedAmount: '2',
        suppliedUsd: '5',
        borrowedUsd: '2',
      }],
    }, '2026-05-12T00:00:00.000Z');

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectorId: 'marginfi', label: 'MarginFi account', tone: 'good' }),
      expect.objectContaining({ label: 'USDC position', value: '5 supplied · 2 borrowed · 5 supplied USD · 2 borrowed USD', tone: 'warn' }),
    ]));
  });

  it('marks blocked MarginFi health previews as failing facts', () => {
    const facts = factsFromMarginfiHealthPreview({
      operation: 'borrow',
      marginfiAccount: '11111111111111111111111111111111',
      bankAddress: 'Bank111111111111111111111111111111111111111',
      bankMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tokenSymbol: 'USDC',
      amount: '10',
      amountRaw: '10000000',
      before: {
        assets: '100',
        liabilities: '40',
        netValue: '60',
        healthRatio: 2.5,
        healthRatioText: '2.5',
        healthy: true,
      },
      after: {
        assets: '100',
        liabilities: '95',
        netValue: '5',
        healthRatio: 1.05,
        healthRatioText: '1.05',
        healthy: true,
      },
      minHealthRatio: 1.1,
      blocked: true,
      warnings: ['Projected health ratio is below policy.'],
      simulatedAt: '2026-05-12T00:00:00.000Z',
    }, '2026-05-12T00:00:00.000Z');

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'MarginFi health preview', tone: 'fail' }),
      expect.objectContaining({ label: 'Health after', tone: 'fail' }),
      expect.objectContaining({ label: 'Health warnings', tone: 'fail' }),
    ]));
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

    await expect(service.connectorReadFacts({ connectorId: 'jupiter', capability: 'positions' })).rejects.toMatchObject({
      name: 'ProtocolError',
      code: 'unsupported_method',
      recoverable: false,
      message: expect.stringContaining('Jupiter does not expose positions read capability'),
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
