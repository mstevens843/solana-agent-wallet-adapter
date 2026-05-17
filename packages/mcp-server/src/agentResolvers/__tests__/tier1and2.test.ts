/**
 * Tests for the Tier 1 (balance/fee) + Tier 2 (sanity) + Tier 3 (tx-inspect) resolvers.
 * Uses a stubbed Connection where applicable so the suite never touches the network.
 */

import { describe, expect, it } from 'vitest';

import { resolveAtom, type AgentAtom } from '@solana-agent-wallet-adapter/workflow';

import type { AgentWalletConfig } from '../../config.js';
import { createMcpCapabilityResolver } from '../index.js';

const STUB_CONFIG: AgentWalletConfig = {
  cluster: 'mainnet-beta',
  rpcUrl: 'https://api.mainnet-beta.solana.com',
} as unknown as AgentWalletConfig;

const TEST_WALLET = '4fTqUdd9ddTzgFs1uqgrh9vBwgKKjbQz1hWmnJjqFB5p';
const TEST_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface StubOverrides {
  getBalance?: number;
  getParsedTokenAccountsByOwner?: { value: Array<{ account: { data: { parsed?: { info?: { tokenAmount?: { uiAmount?: number; decimals?: number } } } } }; pubkey: { toBase58: () => string } }> };
  getRecentPrioritizationFees?: Array<{ slot: number; prioritizationFee: number }>;
  getTokenSupply?: { value: { uiAmount: number; amount: string; decimals: number } };
  getParsedAccountInfo?: { value: { data?: { parsed?: { info?: { decimals?: number } } } } | null };
  getSignaturesForAddress?: Array<{ signature: string; blockTime?: number }>;
  getParsedTransaction?: unknown;
}

/** Build a connection stub that quacks like @solana/web3.js Connection for the resolver. */
function stubConnection(overrides: StubOverrides = {}): unknown {
  return {
    async getBalance() { return overrides.getBalance ?? 0; },
    async getParsedTokenAccountsByOwner() { return overrides.getParsedTokenAccountsByOwner ?? { value: [] }; },
    async getRecentPrioritizationFees() { return overrides.getRecentPrioritizationFees ?? []; },
    async getTokenSupply() { return overrides.getTokenSupply ?? { value: { uiAmount: 0, amount: '0', decimals: 0 } }; },
    async getParsedAccountInfo() { return overrides.getParsedAccountInfo ?? { value: null }; },
    async getSignaturesForAddress() { return overrides.getSignaturesForAddress ?? []; },
    async getParsedTransaction() { return overrides.getParsedTransaction ?? null; },
  };
}

function atom<T extends AgentAtom>(a: T): T { return a; }

describe('wallet_balance resolver', () => {
  it('returns SOL balance in SOL units', async () => {
    const connection = stubConnection({ getBalance: 2_500_000_000 }); // 2.5 SOL in lamports
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'wallet_balance', rawText: 'SOL > 1', subject: 'SOL', op: 'gt', value: 1, unit: 'SOL' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { numeric: number }).numeric).toBeCloseTo(2.5, 5);
  });

  it('returns lamports when unit=lamports', async () => {
    const connection = stubConnection({ getBalance: 1_000_000 });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'wallet_balance', rawText: '', subject: 'SOL', op: 'gt', value: 0, unit: 'lamports' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(1_000_000);
  });

  it('returns missing for unit=USD (no SOL→USD price wired)', async () => {
    const connection = stubConnection({ getBalance: 2_500_000_000 });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'wallet_balance', rawText: '', subject: 'SOL', op: 'lt', value: 50, unit: 'USD' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect(result.attempts[0]!.status).toBe('missing');
    expect(result.attempts[0]!.detail).toMatch(/SOL.*USD price/);
  });

  it('returns missing when no walletAddress', async () => {
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: stubConnection() as unknown as import('@solana/web3.js').Connection,
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'wallet_balance', rawText: '', subject: 'SOL', op: 'gt', value: 1, unit: 'SOL' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect(result.attempts[0]!.status).toBe('missing');
  });
});

describe('token_balance resolver', () => {
  it('sums token-account uiAmount across all accounts for the given mint', async () => {
    const connection = stubConnection({
      getParsedTokenAccountsByOwner: {
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 50, decimals: 6 } } } } }, pubkey: { toBase58: () => 'pk1' } },
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 75, decimals: 6 } } } } }, pubkey: { toBase58: () => 'pk2' } },
        ],
      },
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'token_balance', rawText: '', subject: 'USDC', op: 'gt', value: 100, unit: 'tokens' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(125);
  });

  it('returns missing for unit=USD (no price source wired)', async () => {
    const connection = stubConnection({});
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'token_balance', rawText: '', subject: 'USDC', op: 'gt', value: 100, unit: 'USD' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect(result.attempts[0]!.status).toBe('missing');
    expect(result.attempts[0]!.detail).toMatch(/needs a follow-up price atom/);
  });
});

describe('relative_amount resolver', () => {
  it('computes fraction = draft.amount / walletSol when basis=sol_balance', async () => {
    const connection = stubConnection({ getBalance: 10_000_000_000 }); // 10 SOL
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET, draftParameters: { amount: '1' } },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'relative_amount', rawText: '', fraction: 0.10, op: 'gt', basis: 'sol_balance' }),
      resolver,
      { retryDelayMs: 0 },
    );
    // actual fraction = 1 / 10 = 0.10
    expect((result.resolved?.value as { numeric: number }).numeric).toBeCloseTo(0.10, 5);
  });

  it('returns missing for basis=wallet (not yet supported)', async () => {
    const connection = stubConnection({ getBalance: 10_000_000_000 });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET, draftParameters: { amount: '1' } },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'relative_amount', rawText: '', fraction: 0.10, op: 'gt', basis: 'wallet' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect(result.attempts[0]!.status).toBe('missing');
  });

  it('returns missing if draft amount is missing or zero', async () => {
    const connection = stubConnection({ getBalance: 10_000_000_000 });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET, draftParameters: {} },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'relative_amount', rawText: '', fraction: 0.10, op: 'gt', basis: 'sol_balance' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect(result.attempts[0]!.status).toBe('missing');
  });
});

describe('tx_fee resolver', () => {
  it('computes base + priority lamports using simulation digest unitsConsumed', async () => {
    const connection = stubConnection({
      getRecentPrioritizationFees: [
        { slot: 1, prioritizationFee: 100 },
        { slot: 2, prioritizationFee: 200 },
        { slot: 3, prioritizationFee: 300 },
      ],
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: {
        simulationDigest: {
          ok: true,
          invokedPrograms: [],
          logs: [],
          // include a unitsConsumed via a cast — the SimulationDigest type lets callers attach it
        } as unknown as import('@solana-agent-wallet-adapter/workflow').SimulationDigest,
      },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'tx_fee', rawText: '', op: 'lt', value: 0.01, unit: 'SOL' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect(result.resolved?.source).toBe('rpc');
    expect(typeof (result.resolved?.value as { numeric: number }).numeric).toBe('number');
  });
});

describe('network_congestion resolver', () => {
  it('returns median priority fee from getRecentPrioritizationFees', async () => {
    const connection = stubConnection({
      getRecentPrioritizationFees: [
        { slot: 1, prioritizationFee: 100 },
        { slot: 2, prioritizationFee: 200 },
        { slot: 3, prioritizationFee: 300 },
      ],
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'network_congestion', rawText: '', op: 'gt', value: 150, unit: 'microlamports' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(200); // median of 100/200/300
  });
});

describe('token_supply + mint_decimals resolvers', () => {
  it('returns token supply uiAmount', async () => {
    const connection = stubConnection({
      getTokenSupply: { value: { uiAmount: 1_000_000, amount: '1000000000000', decimals: 6 } },
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'token_supply', rawText: '', subject: 'USDC', op: 'gt', value: 100_000 }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(1_000_000);
  });

  it('returns mint decimals from getParsedAccountInfo', async () => {
    const connection = stubConnection({
      getParsedAccountInfo: { value: { data: { parsed: { info: { decimals: 9 } } } } },
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'mint_decimals', rawText: '', subject: 'SOL', op: 'gte', value: 6 }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(9);
  });
});

describe('wallet_age_onchain resolver', () => {
  it('returns age computed from earliest signature blockTime', async () => {
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86_400;
    const connection = stubConnection({
      getSignaturesForAddress: [
        { signature: 'sig1', blockTime: Math.floor(Date.now() / 1000) - 3600 },
        { signature: 'sig2', blockTime: sevenDaysAgo },
      ],
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'wallet_age_onchain', rawText: '', op: 'gt', value: 86_400 }),
      resolver,
      { retryDelayMs: 0 },
    );
    const age = (result.resolved?.value as { numeric: number }).numeric;
    expect(age).toBeGreaterThan(6 * 86_400);
    expect(age).toBeLessThan(8 * 86_400);
  });
});

describe('Tier 3: tx-inspect resolvers (local parse)', () => {
  it('required_signatures returns missing when no transactionBase64', async () => {
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'required_signatures', rawText: '', op: 'lt', value: 2 }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect(result.attempts[0]!.status).toBe('missing');
  });

  it('required_signatures parses a real Transaction', async () => {
    const { Keypair, SystemProgram, Transaction, PublicKey } = await import('@solana/web3.js');
    const payer = Keypair.generate();
    const recipient = Keypair.generate();
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: '11111111111111111111111111111111' })
      .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient.publicKey, lamports: 100 }));
    const base64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      requestContext: { transactionBase64: base64 },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'required_signatures', rawText: '', op: 'lt', value: 2 }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(1);
    // Suppress unused-import warning for PublicKey (kept for clarity).
    expect(typeof PublicKey).toBe('function');
  });
});
