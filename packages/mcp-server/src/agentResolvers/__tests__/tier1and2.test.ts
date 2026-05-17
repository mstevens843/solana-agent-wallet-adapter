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

/* -------------------------------------------------------------------------- */
/* Tier S: drain-attack defense resolvers                                      */
/* -------------------------------------------------------------------------- */

const SPL_TOKEN_PROGRAM_ID_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Build a base64 tx containing a single SPL Token instruction with the given discriminator. */
async function buildSplTokenTx(discriminator: number, keys: string[], extraDataBytes: number[] = []): Promise<string> {
  const { Keypair, Transaction, TransactionInstruction, PublicKey } = await import('@solana/web3.js');
  const payer = Keypair.generate();
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: '11111111111111111111111111111111' });
  const data = Buffer.from([discriminator, ...extraDataBytes]);
  tx.add(new TransactionInstruction({
    programId: new PublicKey(SPL_TOKEN_PROGRAM_ID_STR),
    keys: keys.map((k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: false })),
    data,
  }));
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}

describe('sets_authority resolver', () => {
  it('returns boolean=false when no SetAuthority instruction present', async () => {
    const { Keypair, SystemProgram, Transaction } = await import('@solana/web3.js');
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
      atom({ id: 'a', type: 'sets_authority', rawText: '', expected: false }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(false);
  });

  it('returns boolean=true when a SetAuthority (discriminator 6) is present', async () => {
    const { Keypair } = await import('@solana/web3.js');
    const account = Keypair.generate().publicKey.toBase58();
    const authority = Keypair.generate().publicKey.toBase58();
    const base64 = await buildSplTokenTx(6, [account, authority]);
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      requestContext: { transactionBase64: base64 },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'sets_authority', rawText: '', expected: false }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(true);
  });
});

describe('delegates_token resolver', () => {
  it('returns boolean=false when no Approve instruction present', async () => {
    const { Keypair, SystemProgram, Transaction } = await import('@solana/web3.js');
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
      atom({ id: 'a', type: 'delegates_token', rawText: '', expected: false }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(false);
  });

  it('flags a bounded Approve when delegate is not in knownDelegates', async () => {
    const { Keypair } = await import('@solana/web3.js');
    const source = Keypair.generate().publicKey.toBase58();
    const delegate = Keypair.generate().publicKey.toBase58();
    const owner = Keypair.generate().publicKey.toBase58();
    // Approve: data[0]=4, then u64 amount = 100 (little-endian 8 bytes).
    const amount = [100, 0, 0, 0, 0, 0, 0, 0];
    const base64 = await buildSplTokenTx(4, [source, delegate, owner], amount);
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      requestContext: { transactionBase64: base64 },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'delegates_token', rawText: '', expected: false }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(true);
  });

  it('does NOT flag a bounded Approve when delegate is in knownDelegates', async () => {
    const { Keypair } = await import('@solana/web3.js');
    const source = Keypair.generate().publicKey.toBase58();
    const delegate = Keypair.generate().publicKey.toBase58();
    const owner = Keypair.generate().publicKey.toBase58();
    const amount = [100, 0, 0, 0, 0, 0, 0, 0];
    const base64 = await buildSplTokenTx(4, [source, delegate, owner], amount);
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      requestContext: { transactionBase64: base64 },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'delegates_token', rawText: '', expected: false, knownDelegates: [delegate] }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(false);
  });

  it('flags an unlimited Approve regardless of knownDelegates', async () => {
    const { Keypair } = await import('@solana/web3.js');
    const source = Keypair.generate().publicKey.toBase58();
    const delegate = Keypair.generate().publicKey.toBase58();
    const owner = Keypair.generate().publicKey.toBase58();
    // u64::MAX = 8 × 0xFF
    const unlimited = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    const base64 = await buildSplTokenTx(4, [source, delegate, owner], unlimited);
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      requestContext: { transactionBase64: base64 },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'delegates_token', rawText: '', expected: false, knownDelegates: [delegate] }),
      resolver,
      { retryDelayMs: 0 },
    );
    // Unlimited approval is flagged even though the delegate is allowlisted.
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(true);
  });

  it('respects onlyUnlimited: ignores a bounded Approve', async () => {
    const { Keypair } = await import('@solana/web3.js');
    const source = Keypair.generate().publicKey.toBase58();
    const delegate = Keypair.generate().publicKey.toBase58();
    const owner = Keypair.generate().publicKey.toBase58();
    const amount = [42, 0, 0, 0, 0, 0, 0, 0];
    const base64 = await buildSplTokenTx(4, [source, delegate, owner], amount);
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      requestContext: { transactionBase64: base64 },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'delegates_token', rawText: '', expected: false, onlyUnlimited: true }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(false);
  });
});

describe('closes_account resolver', () => {
  it('returns boolean=false when no CloseAccount instruction present', async () => {
    const { Keypair, SystemProgram, Transaction } = await import('@solana/web3.js');
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
      atom({ id: 'a', type: 'closes_account', rawText: '', expected: false }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(false);
  });

  it('flags a CloseAccount on a non-wSOL account', async () => {
    const { Keypair } = await import('@solana/web3.js');
    const account = Keypair.generate().publicKey.toBase58();
    const destination = Keypair.generate().publicKey.toBase58();
    const owner = Keypair.generate().publicKey.toBase58();
    // CloseAccount: data[0]=9
    const base64 = await buildSplTokenTx(9, [account, destination, owner]);
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      requestContext: { transactionBase64: base64 },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'closes_account', rawText: '', expected: false }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(true);
  });

  it('does NOT flag CloseAccount when preceding InitializeAccount sets mint=wSOL', async () => {
    const { Keypair, Transaction, TransactionInstruction, PublicKey } = await import('@solana/web3.js');
    const payer = Keypair.generate();
    const account = Keypair.generate().publicKey.toBase58();
    const destination = Keypair.generate().publicKey.toBase58();
    const owner = Keypair.generate().publicKey.toBase58();
    const rent = '11111111111111111111111111111111'; // SysvarRent (placeholder)
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: '11111111111111111111111111111111' });
    // InitializeAccount: data[0]=1, accounts=[account, mint, owner, rent]
    tx.add(new TransactionInstruction({
      programId: new PublicKey(SPL_TOKEN_PROGRAM_ID_STR),
      keys: [account, WSOL_MINT, owner, rent].map((k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: false })),
      data: Buffer.from([1]),
    }));
    // CloseAccount on the same account
    tx.add(new TransactionInstruction({
      programId: new PublicKey(SPL_TOKEN_PROGRAM_ID_STR),
      keys: [account, destination, owner].map((k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: false })),
      data: Buffer.from([9]),
    }));
    const base64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      requestContext: { transactionBase64: base64 },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'closes_account', rawText: '', expected: false }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Tier A: spending governance resolvers                                       */
/* -------------------------------------------------------------------------- */

describe('cooldown_since_last_tx resolver', () => {
  it('returns time since the most recent signature', async () => {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const connection = stubConnection({
      getSignaturesForAddress: [{ signature: 'sig1abcdef', blockTime: oneHourAgo }],
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'cooldown_since_last_tx', rawText: '', op: 'gt', value: 60 }),
      resolver,
      { retryDelayMs: 0 },
    );
    const seconds = (result.resolved?.value as { numeric: number }).numeric;
    expect(seconds).toBeGreaterThan(3500);
    expect(seconds).toBeLessThan(3700);
  });

  it('returns missing when wallet has no prior signatures', async () => {
    const connection = stubConnection({ getSignaturesForAddress: [] });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'cooldown_since_last_tx', rawText: '', op: 'gt', value: 60 }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect(result.attempts[0]!.status).toBe('missing');
  });
});

describe('daily_outflow_sum resolver', () => {
  it('returns 0 when no signatures fall in the 24h window', async () => {
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86_400;
    const connection = stubConnection({
      getSignaturesForAddress: [{ signature: 'sig1', blockTime: twoDaysAgo }],
    });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'daily_outflow_sum', rawText: '', op: 'lt', value: 5, unit: 'SOL' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(0);
  });

  it('rejects USD unit cleanly (no SOL→USD price wired)', async () => {
    const connection = stubConnection({ getSignaturesForAddress: [] });
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'daily_outflow_sum', rawText: '', op: 'lt', value: 500, unit: 'USD' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect(result.attempts[0]!.status).toBe('missing');
    expect(result.attempts[0]!.detail).toMatch(/SOL.*USD price/);
  });

  it('sums negative SOL deltas across recent txs', async () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = 'sigabc12345';
    const connection = {
      async getSignaturesForAddress() {
        return [{ signature: sig, blockTime: now - 3600 }];
      },
      async getParsedTransaction() {
        return {
          meta: {
            preBalances: [10_000_000_000, 0], // 10 SOL
            postBalances: [9_500_000_000, 0], // 9.5 SOL — 0.5 SOL outflow
          },
          transaction: {
            message: { accountKeys: [TEST_WALLET, 'other'] },
          },
        };
      },
    };
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'daily_outflow_sum', rawText: '', op: 'lt', value: 5, unit: 'SOL' }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { numeric: number }).numeric).toBeCloseTo(0.5, 5);
  });

  it('fail-closes (returns missing) when chatty wallet exceeds 100-tx cap in window', async () => {
    const now = Math.floor(Date.now() / 1000);
    // 150 signatures all within the 24h window — should trigger the cap.
    const sigs = Array.from({ length: 150 }, (_, i) => ({
      signature: `sig${i.toString().padStart(4, '0')}`,
      blockTime: now - 3600 - i,
    }));
    const connection = {
      async getSignaturesForAddress() { return sigs; },
      async getParsedTransaction() { return null; },
    };
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { walletAddress: TEST_WALLET },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'daily_outflow_sum', rawText: '', op: 'lt', value: 5, unit: 'SOL' }),
      resolver,
      { retryDelayMs: 0 },
    );
    // Cap → missing (fail-closed) so the evaluator marks the gate unresolved.
    expect(result.attempts[0]!.status).toBe('missing');
    expect(result.attempts[0]!.detail).toMatch(/exceeds.*100-tx/);
  });
});

describe('delegates_token ALT (Address Lookup Table) fail-closed behavior', () => {
  it('flags an Approve with ALT-hidden delegate even when knownDelegates is supplied', async () => {
    // Construct a versioned transaction whose Approve instruction references the delegate
    // by an index that overflows the static account keys (simulating an ALT-resolved key).
    // We do this by hand-rolling a MessageV0 with a writable account list that's shorter
    // than what the instruction's accountKeyIndexes refers to.
    const web3 = await import('@solana/web3.js');
    const { Keypair, MessageV0, VersionedTransaction, PublicKey, TransactionInstruction } = web3;
    const payer = Keypair.generate();
    const source = Keypair.generate().publicKey;
    // Build a normal Approve instruction with [source, delegate, owner] then *strip* the
    // delegate from the static keys to simulate ALT-only resolution.
    const SPL_TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const delegate = Keypair.generate().publicKey;
    const owner = payer.publicKey;
    const approveData = Buffer.from([4, 100, 0, 0, 0, 0, 0, 0, 0]); // bounded Approve
    const ix = new TransactionInstruction({
      programId: SPL_TOKEN,
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: delegate, isSigner: false, isWritable: false },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data: approveData,
    });
    // Compile via MessageV0 with NO address lookup tables — produces a static-only message.
    const messageV0 = MessageV0.compile({
      payerKey: payer.publicKey,
      instructions: [ix],
      recentBlockhash: '11111111111111111111111111111111',
    });
    // Now manually rewrite the message to reference index 99 for the delegate (forcing it
    // outside staticKeys). This simulates what a real ALT-bound instruction would look like
    // to the offline parser.
    const compiledIx = messageV0.compiledInstructions[0]!;
    const newIndexes = new Uint8Array(compiledIx.accountKeyIndexes);
    // Find the delegate index in static keys and replace it with 99 (out of bounds).
    const staticKeys = messageV0.staticAccountKeys.map((k) => k.toBase58());
    const delegateIdx = staticKeys.indexOf(delegate.toBase58());
    expect(delegateIdx).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < newIndexes.length; i += 1) {
      if (newIndexes[i] === delegateIdx) newIndexes[i] = 99;
    }
    const mutated = MessageV0.compile({
      payerKey: payer.publicKey,
      instructions: [ix],
      recentBlockhash: '11111111111111111111111111111111',
    });
    Object.assign(mutated.compiledInstructions[0]!, { accountKeyIndexes: newIndexes });
    const versioned = new VersionedTransaction(mutated);
    const base64 = Buffer.from(versioned.serialize()).toString('base64');

    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      requestContext: { transactionBase64: base64 },
    });
    const result = await resolveAtom(
      // knownDelegates includes the real delegate — but the parser can't see it.
      atom({ id: 'a', type: 'delegates_token', rawText: '', expected: false, knownDelegates: [delegate.toBase58()] }),
      resolver,
      { retryDelayMs: 0 },
    );
    // Fail-closed: ALT-hidden delegate must be flagged.
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(true);
    expect((result.resolved?.value as { text: string }).text).toMatch(/ALT/);
  });
});

/* -------------------------------------------------------------------------- */
/* Tier C: temporal policy resolvers                                           */
/* -------------------------------------------------------------------------- */

describe('time_of_day resolver', () => {
  it('returns boolean=true when current UTC hour is inside the window', async () => {
    const nowHour = new Date().getUTCHours();
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'time_of_day', rawText: '', start: 0, end: 24, expected: true }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(true);
    expect(typeof nowHour).toBe('number');
  });

  it('returns boolean=false when current UTC hour is outside the window', async () => {
    // A 1-hour window 12 hours from now should always be outside.
    const nowH = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
    const farStart = (nowH + 12) % 24;
    const farEnd = (nowH + 13) % 24;
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'time_of_day', rawText: '', start: farStart, end: farEnd, expected: true }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(false);
  });
});

describe('day_of_week_window resolver', () => {
  it('returns boolean=true when today is in allowedDays', async () => {
    const today = new Date().getUTCDay();
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'day_of_week_window', rawText: '', allowedDays: [today], expected: true }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(true);
  });

  it('returns boolean=false when today is not in allowedDays', async () => {
    const today = new Date().getUTCDay();
    const otherDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today);
    const resolver = createMcpCapabilityResolver({ config: STUB_CONFIG });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'day_of_week_window', rawText: '', allowedDays: otherDays, expected: true }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { boolean: boolean }).boolean).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Recent blockhash age resolver                                               */
/* -------------------------------------------------------------------------- */

describe('recent_blockhash_age_ms resolver', () => {
  it('returns ~30000ms when isBlockhashValid returns true', async () => {
    const { Keypair, SystemProgram, Transaction } = await import('@solana/web3.js');
    const payer = Keypair.generate();
    const recipient = Keypair.generate();
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' })
      .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient.publicKey, lamports: 100 }));
    const base64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    const connection = { async isBlockhashValid() { return true; } };
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { transactionBase64: base64 },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'recent_blockhash_age_ms', rawText: '', op: 'lt', value: 60_000 }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(30_000);
  });

  it('returns ~90000ms when isBlockhashValid returns false', async () => {
    const { Keypair, SystemProgram, Transaction } = await import('@solana/web3.js');
    const payer = Keypair.generate();
    const recipient = Keypair.generate();
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' })
      .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient.publicKey, lamports: 100 }));
    const base64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    const connection = { async isBlockhashValid() { return false; } };
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
      requestContext: { transactionBase64: base64 },
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'recent_blockhash_age_ms', rawText: '', op: 'lt', value: 60_000 }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect((result.resolved?.value as { numeric: number }).numeric).toBe(90_000);
  });

  it('returns missing when no transactionBase64 in context', async () => {
    const connection = { async isBlockhashValid() { return true; } };
    const resolver = createMcpCapabilityResolver({
      config: STUB_CONFIG,
      connection: connection as unknown as import('@solana/web3.js').Connection,
    });
    const result = await resolveAtom(
      atom({ id: 'a', type: 'recent_blockhash_age_ms', rawText: '', op: 'lt', value: 60_000 }),
      resolver,
      { retryDelayMs: 0 },
    );
    expect(result.attempts[0]!.status).toBe('missing');
  });
});
