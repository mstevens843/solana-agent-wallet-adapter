/**
 * Tests for the network_metric resolver — uses a stubbed Connection that returns the
 * shapes the resolver expects from each RPC method. Verifies:
 *   - TPS = numTransactions / samplePeriodSecs
 *   - slot_height returns the raw slot number
 *   - validator_jailed flags a specific vote pubkey when in the delinquent array
 *   - epoch_progress_pct = (slotIndex / slotsInEpoch) * 100
 *   - RPC errors fall through as `error` attempts
 *   - When no Connection is supplied, the dispatcher returns `missing`
 */

import { describe, expect, it } from 'vitest';

import { resolveAtom, type AgentAtom } from '@solana-agent-wallet-adapter/workflow';

import type { AgentWalletConfig } from '../../config.js';
import { createMcpCapabilityResolver } from '../index.js';

const STUB_CONFIG: AgentWalletConfig = {
  cluster: 'mainnet-beta',
  rpcUrl: 'https://api.mainnet-beta.solana.com',
} as unknown as AgentWalletConfig;

interface StubConnectionOverrides {
  recentPerformanceSamples?: Array<{ numTransactions: number; samplePeriodSecs: number; slot: number }>;
  slot?: number;
  voteAccounts?: { current: Array<{ votePubkey: string; nodePubkey: string }>; delinquent: Array<{ votePubkey: string; nodePubkey: string }> };
  epochInfo?: { epoch: number; slotIndex: number; slotsInEpoch: number };
  throwOnMethod?: 'getRecentPerformanceSamples' | 'getSlot' | 'getVoteAccounts' | 'getEpochInfo';
}

/** Build a stub object that quacks like @solana/web3.js Connection enough for the resolver. */
function stubConnection(overrides: StubConnectionOverrides = {}): unknown {
  const maybeThrow = (method: StubConnectionOverrides['throwOnMethod']): void => {
    if (overrides.throwOnMethod === method) throw new Error(`stub ${method} threw`);
  };
  return {
    async getRecentPerformanceSamples(_limit: number) {
      maybeThrow('getRecentPerformanceSamples');
      return overrides.recentPerformanceSamples ?? [];
    },
    async getSlot(_commitment: unknown) {
      maybeThrow('getSlot');
      return overrides.slot ?? 0;
    },
    async getVoteAccounts() {
      maybeThrow('getVoteAccounts');
      return overrides.voteAccounts ?? { current: [], delinquent: [] };
    },
    async getEpochInfo(_commitment: unknown) {
      maybeThrow('getEpochInfo');
      return overrides.epochInfo ?? { epoch: 0, slotIndex: 0, slotsInEpoch: 432_000 };
    },
  };
}

function networkMetricAtom(metric: 'tps' | 'slot_height' | 'validator_jailed' | 'epoch_progress_pct', extra: Partial<AgentAtom> = {}): AgentAtom {
  return {
    id: `atom.network_metric.${metric}.gt.0`,
    type: 'network_metric',
    rawText: `${metric} threshold`,
    metric,
    ...(metric !== 'validator_jailed' ? { op: 'gt', value: 0 } : {}),
    ...extra,
  } as AgentAtom;
}

describe('network_metric resolver (live Solana RPC)', () => {
  it('returns ok with TPS computed from getRecentPerformanceSamples', async () => {
    const connection = stubConnection({
      recentPerformanceSamples: [{ numTransactions: 6_000, samplePeriodSecs: 60, slot: 1 }],
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const result = await resolveAtom(networkMetricAtom('tps'), resolver, { retryDelayMs: 0 });
    expect(result.resolved?.source).toBe('rpc');
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(100);
  });

  it('returns ok with slot height from getSlot', async () => {
    const connection = stubConnection({ slot: 305_421_777 });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const result = await resolveAtom(networkMetricAtom('slot_height'), resolver, { retryDelayMs: 0 });
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(305_421_777);
  });

  it('flags validator_jailed=true when the named vote pubkey is in the delinquent list', async () => {
    const votePubkey = 'Vote111111111111111111111111111111111111111';
    const connection = stubConnection({
      voteAccounts: {
        current: [],
        delinquent: [{ votePubkey, nodePubkey: 'Node111' }],
      },
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const atom = networkMetricAtom('validator_jailed', { subject: votePubkey });
    const result = await resolveAtom(atom, resolver, { retryDelayMs: 0 });
    expect(result.resolved?.value).toMatchObject({ boolean: true, text: 'delinquent' });
  });

  it('returns boolean=false when the named validator is NOT delinquent', async () => {
    const connection = stubConnection({
      voteAccounts: {
        current: [{ votePubkey: 'Active1', nodePubkey: 'NodeA' }],
        delinquent: [{ votePubkey: 'Other1', nodePubkey: 'NodeB' }],
      },
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const atom = networkMetricAtom('validator_jailed', { subject: 'Active1' });
    const result = await resolveAtom(atom, resolver, { retryDelayMs: 0 });
    expect(result.resolved?.value).toMatchObject({ boolean: false, text: 'active' });
  });

  it('returns network-wide delinquency count when no subject is provided', async () => {
    const connection = stubConnection({
      voteAccounts: {
        current: [{ votePubkey: 'A', nodePubkey: 'a' }, { votePubkey: 'B', nodePubkey: 'b' }],
        delinquent: [{ votePubkey: 'C', nodePubkey: 'c' }],
      },
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const result = await resolveAtom(networkMetricAtom('validator_jailed'), resolver, { retryDelayMs: 0 });
    expect(result.resolved?.value).toMatchObject({ boolean: true, numeric: 1 });
  });

  it('returns epoch progress percentage from getEpochInfo', async () => {
    const connection = stubConnection({
      epochInfo: { epoch: 500, slotIndex: 108_000, slotsInEpoch: 432_000 },
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const result = await resolveAtom(networkMetricAtom('epoch_progress_pct'), resolver, { retryDelayMs: 0 });
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(25);
  });

  it('falls through to web when the RPC throws', async () => {
    const connection = stubConnection({ throwOnMethod: 'getSlot' });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const result = await resolveAtom(networkMetricAtom('slot_height'), resolver, { retryDelayMs: 0 });
    // First tier (rpc) errored; chain falls through to web which defers to research pass.
    expect(result.attempts[0]!.status).toBe('error');
    expect(result.attempts[0]!.detail).toContain('getSlot');
    // Web tier is the last in the chain — also returns missing (deferred to research pass).
    expect(result.exhausted).toBe(true);
  });

  it('returns missing with a helpful message when no Connection is wired', async () => {
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG });
    const result = await resolveAtom(networkMetricAtom('tps'), resolver, { retryDelayMs: 0 });
    expect(result.attempts[0]!.status).toBe('missing');
    expect(result.attempts[0]!.detail).toMatch(/No Solana Connection wired/);
  });

  it('returns missing when getRecentPerformanceSamples returns an empty array', async () => {
    const connection = stubConnection({ recentPerformanceSamples: [] });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const result = await resolveAtom(networkMetricAtom('tps'), resolver, { retryDelayMs: 0 });
    expect(result.attempts[0]!.status).toBe('missing');
    expect(result.attempts[0]!.detail).toMatch(/No recent performance samples/);
  });
});
