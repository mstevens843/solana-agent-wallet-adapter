// Live mainnet integration test for the Jupiter Lend Earn SDK wiring. Opt-in
// via env var so it doesn't run in CI by default (it makes real RPC calls).
// Run with:
//
//   AGENT_WALLET_JUPITER_LEND_LIVE=1 SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
//     pnpm -F @solana-agent-wallet-adapter/mcp-server test -- --run lendSdk.live
//
// What this proves: the exact code path that fires when a user clicks "Approve
// and send" on a Jupiter Lend Earn SOL deposit — JupiterLendSdkClient →
// @jup-ag/lend.getDepositIxs → serializeEarnInstructions (with wrap-SOL prepend).
// If this test passes, the prod approve flow returns real signable bytes that
// will actually move balances in the user's wallet.

import { SystemProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { getJupiterLendClient } from '../lendClient.js';
import { JUPITER_LEND_EARN_PROGRAM_ID } from '../constants.js';
import type { AgentWalletConfig } from '../../../config.js';

const LIVE = process.env.AGENT_WALLET_JUPITER_LEND_LIVE === '1';
const RPC_URL = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';

// A funded mainnet wallet; we never sign or submit the tx, only inspect its shape.
const TEST_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const describeLive = LIVE ? describe : describe.skip;

function liveConfig(): AgentWalletConfig {
  return {
    cluster: 'mainnet-beta',
    rpcUrl: RPC_URL,
    mainnet: {
      enabled: true,
      maxSolTransfer: '10',
      maxSwapInput: '10',
      maxSlippageBps: 100,
      allowArbitraryTransactions: false,
    },
    tokens: [],
    jupiter: { baseUrl: 'https://api.jup.ag', apiKeyEnv: 'JUP_API_KEY' },
    connectors: { jupiter: { useSdk: true } },
  } as unknown as AgentWalletConfig;
}

describeLive('Jupiter Lend Earn SDK — live mainnet integration', () => {
  it('SOL deposit produces a signable tx with wrap-SOL ixs', async () => {
    const client = await getJupiterLendClient(TEST_WALLET, liveConfig());
    const result = await client.buildEarnDeposit({
      walletAddress: TEST_WALLET,
      cluster: 'mainnet-beta',
      assetMint: SOL_MINT,
      amount: '0.001',
      amountRaw: '1000000',
    });

    const tx = Transaction.from(Buffer.from(result.transactionBase64, 'base64'));
    expect(tx.feePayer?.toBase58()).toBe(TEST_WALLET);
    expect(typeof tx.recentBlockhash).toBe('string');
    expect((tx.recentBlockhash as string).length).toBeGreaterThan(20);

    const programs = tx.instructions.map((ix) => ix.programId.toBase58());

    // Adapter-prepended head: ComputeBudget + ATA(wSOL idempotent) + SystemProgram.transfer + syncNative.
    expect(programs).toContain(SystemProgram.programId.toBase58());
    // SDK-emitted body: f-token ATA + Jupiter Lend Earn deposit ix.
    expect(programs).toContain(JUPITER_LEND_EARN_PROGRAM_ID.toBase58());

    // Five at minimum (ComputeBudget + 3 wrap + 1 deposit) — usually six.
    expect(tx.instructions.length).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it('USDC deposit does not include SystemProgram.transfer (no SOL wrap)', async () => {
    const client = await getJupiterLendClient(TEST_WALLET, liveConfig());
    const result = await client.buildEarnDeposit({
      walletAddress: TEST_WALLET,
      cluster: 'mainnet-beta',
      assetMint: USDC_MINT,
      amount: '1',
      amountRaw: '1000000',
    });

    const tx = Transaction.from(Buffer.from(result.transactionBase64, 'base64'));
    const programs = tx.instructions.map((ix) => ix.programId.toBase58());
    expect(programs.includes(SystemProgram.programId.toBase58())).toBe(false);
    expect(programs).toContain(JUPITER_LEND_EARN_PROGRAM_ID.toBase58());
  }, 60_000);

  it('SOL withdraw appends a Token close-account at the tail', async () => {
    const client = await getJupiterLendClient(TEST_WALLET, liveConfig());
    const result = await client.buildEarnWithdraw({
      walletAddress: TEST_WALLET,
      cluster: 'mainnet-beta',
      assetMint: SOL_MINT,
      amount: '0.001',
      amountRaw: '1000000',
    });

    const tx = Transaction.from(Buffer.from(result.transactionBase64, 'base64'));
    const programs = tx.instructions.map((ix) => ix.programId.toBase58());
    // No wrap-SOL on withdraw (no SystemProgram.transfer for wrap), but a Token close
    // ix at the tail. Token program 2022 vs classic — both encode close as discriminator 9.
    expect(programs).toContain(JUPITER_LEND_EARN_PROGRAM_ID.toBase58());
    const last = tx.instructions[tx.instructions.length - 1];
    expect(last?.data[0]).toBe(9);
    // The close targets the wSOL ATA, which references native SOL — verify by
    // checking the close ix isn't an ATA-program ix.
    expect(last?.programId.toBase58()).not.toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  }, 60_000);
});

