// Live mainnet integration test for the Kamino SDK wiring. Opt-in via env var so
// it doesn't run in CI by default (it makes real RPC calls and downloads ~1MB of
// Kamino Main Market state). Run with:
//
//   AGENT_WALLET_KAMINO_LIVE=1 SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
//     pnpm -F @solana-agent-wallet-adapter/mcp-server test -- --run sdkClient.live
//
// What this proves: the exact code path that fires when a user clicks "Approve
// and send" on a Kamino SOL deposit in production — buildKaminoSdkClient →
// KaminoMarket.load → KaminoAction.buildDepositTxns → kit→web3.js conversion →
// Transaction ready for wallet signing. If this test passes, the prod approve
// flow returns real signable bytes instead of throwing "SDK is not wired."

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { buildKaminoSdkClient } from '../sdkClient.js';
import { KAMINO_KNOWN_RESERVES, KLEND_PROGRAM_ID } from '../constants.js';

const LIVE = process.env.AGENT_WALLET_KAMINO_LIVE === '1';
const RPC_URL = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';

// A funded mainnet wallet with no obligation is fine — KaminoAction.buildDepositTxns
// produces an init-obligation ix automatically when the wallet has no existing
// Kamino position. We never sign or submit the tx here.
const TEST_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

const describeLive = LIVE ? describe : describe.skip;

describeLive('buildKaminoSdkClient — live mainnet integration', () => {
  const client = buildKaminoSdkClient({ rpcUrl: RPC_URL });
  const connection = new Connection(RPC_URL, 'confirmed');
  const solReserve = KAMINO_KNOWN_RESERVES.find((entry) => entry.symbol === 'SOL');

  it('has the SOL reserve in its known list', () => {
    expect(solReserve).toBeDefined();
    expect(solReserve?.mint).toBe('So11111111111111111111111111111111111111112');
  });

  it('loads the Main Market and returns a real reserve snapshot for SOL', async () => {
    const snapshot = await client.getReserveSnapshot(connection, solReserve!.mint);
    expect(snapshot.reserveMint).toBe(solReserve!.mint);
    expect(snapshot.reserveSymbol).toBe('SOL');
    expect(snapshot.decimals).toBe(9);
    // reserveAddress must be a real base58 pubkey (32 bytes).
    expect(() => new PublicKey(snapshot.reserveAddress)).not.toThrow();
  }, 60_000);

  it('lists every known reserve (SOL/USDC/JitoSOL/mSOL/bSOL) after loading the market', async () => {
    const snapshots = await client.listReserveSnapshots(connection);
    const mints = new Set(snapshots.map((entry) => entry.reserveMint));
    for (const known of KAMINO_KNOWN_RESERVES) {
      expect(mints.has(known.mint)).toBe(true);
    }
  }, 60_000);

  it('builds a signable web3.js Transaction for a 0.01 SOL deposit', async () => {
    const amountRaw = 10_000_000n; // 0.01 SOL in lamports
    const result = await client.buildDepositTransaction(connection, {
      walletAddress: TEST_WALLET,
      reserveMint: solReserve!.mint,
      amountRaw,
    });

    // Shape: returned an actual web3.js Transaction with a feePayer + blockhash.
    expect(result.transaction).toBeInstanceOf(Transaction);
    expect(result.transaction.feePayer?.toBase58()).toBe(TEST_WALLET);
    expect(typeof result.transaction.recentBlockhash).toBe('string');
    expect((result.transaction.recentBlockhash as string).length).toBeGreaterThan(20);

    // At least one instruction in the tx targets the Kamino Lend program — this
    // confirms the SDK actually emitted Klend ixs (not e.g. only ATA setup).
    const programIds = result.transaction.instructions.map((ix) => ix.programId.toBase58());
    expect(programIds).toContain(KLEND_PROGRAM_ID.toBase58());

    // Serialize → base64 → deserialize round-trip works (this is exactly what
    // the prepare-transaction endpoint hands back to the browser for signing).
    const bytes = result.transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
    const base64 = bytes.toString('base64');
    expect(base64.length).toBeGreaterThan(100);
    const decoded = Transaction.from(Buffer.from(base64, 'base64'));
    expect(decoded.feePayer?.toBase58()).toBe(TEST_WALLET);
    expect(decoded.instructions.length).toBe(result.transaction.instructions.length);

    // Metadata we expose to the UI is filled in.
    expect(result.reserveSymbol).toBe('SOL');
    expect(result.decimals).toBe(9);
    expect(result.amountUi).toBe('0.01');
    expect(() => new PublicKey(result.reserveAddress)).not.toThrow();
  }, 120_000);
});
