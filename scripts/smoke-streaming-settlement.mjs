#!/usr/bin/env node
/**
 * Phase 5.11 — devnet precheck for the streaming-payment session primitive.
 * It verifies wallet, token account, and operator env readiness before the
 * manual runbook drives the authorized render-web session steps.
 *
 * Full runbook target:
 *
 *   1. Spawns a local render-web server against an in-memory store (no
 *      Postgres needed; the smoke is about the API + on-chain pieces).
 *   2. Generates a wallet keypair, requests a devnet airdrop, and creates a
 *      devnet USDC token account funded with a tiny stash (operator must
 *      have a pre-funded USDC source — see env vars below).
 *   3. POSTs `/api/streaming/sessions` to create a session with a small cap.
 *   4. Signs the returned approveTx with the wallet keypair, submits it via
 *      the devnet RPC, then POSTs `/api/streaming/sessions/:id/grant-signed`.
 *   5. Posts 3 voucher-relay requests to spend within the cap.
 *   6. Invokes the `streaming-settle` CLI entry to materialize settlement.
 *   7. Polls the devnet RPC for the settlement txid; verifies confirmation.
 *   8. POSTs `/api/streaming/sessions/:id/revoke`, signs + submits the
 *      revoke tx, verifies subsequent vouchers are rejected.
 *
 * Required env (set these or the script will tell you what's missing):
 *
 *   STREAMING_SESSION_ENCRYPTION_KEY        — base64-32 (`openssl rand -base64 32`)
 *   STREAMING_SETTLEMENT_FEE_PAYER_SECRET_KEY — JSON array of 64 uint8s; account must hold devnet SOL
 *   STREAMING_SMOKE_USDC_MINT               — devnet USDC mint (default: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU)
 *   STREAMING_SMOKE_WALLET_SECRET_KEY       — JSON array of 64 uint8s for the user wallet
 *   STREAMING_SMOKE_SOURCE_ATA              — pre-funded USDC ATA for the wallet (script can derive)
 *   STREAMING_SMOKE_RECIPIENT_PUBKEY        — recipient pubkey to send vouchers to
 *   AGENTIC_RPC_URL                         — devnet RPC (default: https://api.devnet.solana.com)
 *
 * Pre-mainnet release gate: this must pass cleanly before flipping streaming
 * sessions on for any mainnet wallet (P5.11 in the plan).
 *
 * Usage:
 *   node scripts/smoke-streaming-settlement.mjs --vouchers 3 --cap 0.30
 *   node scripts/smoke-streaming-settlement.mjs --help
 */

import { parseArgs } from 'node:util';

const DEFAULT_RPC = 'https://api.devnet.solana.com';
const DEFAULT_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const { values: args, positionals: _positionals } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h' },
    vouchers: { type: 'string' },
    cap: { type: 'string' },
    'voucher-amount': { type: 'string' },
    'render-port': { type: 'string' },
    'skip-cron': { type: 'boolean' },
  },
  allowPositionals: true,
});

if (args.help) {
  console.log(`Usage: node scripts/smoke-streaming-settlement.mjs [options]

Options:
  --vouchers <N>           Number of vouchers to spend (default: 3)
  --cap <DECIMAL>          Session cap in USDC (default: 0.30)
  --voucher-amount <DEC>   Per-voucher amount (default: cap / vouchers)
  --render-port <N>        Local render-web port (default: 3030)
  --skip-cron              Don't invoke streaming-settle; leave settlement to operator
  --help                   Print this message and exit

Environment (all required unless noted):
  STREAMING_SESSION_ENCRYPTION_KEY                base64-32
  STREAMING_SETTLEMENT_FEE_PAYER_SECRET_KEY       JSON array of 64 uint8s
  STREAMING_SMOKE_WALLET_SECRET_KEY               JSON array of 64 uint8s
  STREAMING_SMOKE_RECIPIENT_PUBKEY                base58 pubkey
  STREAMING_SMOKE_USDC_MINT                       default: ${DEFAULT_USDC_MINT}
  AGENTIC_RPC_URL                                 default: ${DEFAULT_RPC}
`);
  process.exit(0);
}

const required = [
  'STREAMING_SESSION_ENCRYPTION_KEY',
  'STREAMING_SETTLEMENT_FEE_PAYER_SECRET_KEY',
  'STREAMING_SMOKE_WALLET_SECRET_KEY',
  'STREAMING_SMOKE_RECIPIENT_PUBKEY',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error('Missing required env vars:');
  for (const name of missing) console.error(`  - ${name}`);
  console.error('\nRun with --help for the full env list.');
  process.exit(2);
}

const voucherCount = Number(args.vouchers ?? '3');
const capAmount = args.cap ?? '0.30';
const voucherAmount = args['voucher-amount'] ?? (Number(capAmount) / voucherCount).toFixed(6);
const renderPort = Number(args['render-port'] ?? '3030');
const usdcMint = process.env.STREAMING_SMOKE_USDC_MINT ?? DEFAULT_USDC_MINT;
const rpcUrl = process.env.AGENTIC_RPC_URL ?? DEFAULT_RPC;

if (!Number.isInteger(voucherCount) || voucherCount <= 0) {
  console.error(`--vouchers must be a positive integer; got ${args.vouchers}`);
  process.exit(2);
}
if (!/^\d+(?:\.\d+)?$/.test(capAmount) || Number(capAmount) <= 0) {
  console.error(`--cap must be a positive decimal; got ${args.cap}`);
  process.exit(2);
}

console.log(`[streaming-smoke] start  rpc=${rpcUrl}  mint=${usdcMint}  cap=${capAmount}  vouchers=${voucherCount}@${voucherAmount}`);

// The runtime imports happen lazily below so `--help` doesn't have to wait
// for Solana SDK / render-web compilation.

const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} = await import('@solana/web3.js');
const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
const bs58 = (await import('bs58')).default;

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.STREAMING_SMOKE_WALLET_SECRET_KEY)));
const recipient = new PublicKey(process.env.STREAMING_SMOKE_RECIPIENT_PUBKEY);
const connection = new Connection(rpcUrl, 'confirmed');

console.log(`[streaming-smoke] wallet=${wallet.publicKey.toBase58()}  recipient=${recipient.toBase58()}`);

const sourceAta = getAssociatedTokenAddressSync(new PublicKey(usdcMint), wallet.publicKey);
console.log(`[streaming-smoke] source ATA=${sourceAta.toBase58()}`);

// Verify the wallet has enough USDC to cover the cap.
const balance = await connection.getTokenAccountBalance(sourceAta).catch(() => null);
if (!balance) {
  console.error(`[streaming-smoke] wallet has no USDC ATA at ${sourceAta.toBase58()}. Fund it on devnet first.`);
  process.exit(3);
}
const uiBalance = balance.value.uiAmount ?? 0;
if (uiBalance < Number(capAmount)) {
  console.error(`[streaming-smoke] wallet USDC balance ${uiBalance} < cap ${capAmount}. Fund more on devnet.`);
  process.exit(3);
}

// ----------------------------------------------------------------------------
// This script is intentionally a precheck driver. The authorized render-web
// session steps remain in docs/smoke/streaming-settlement.md because they
// require an operator-held session cookie and devnet funding.
// ----------------------------------------------------------------------------

console.log(`
[streaming-smoke] PRECHECK PASSED.

The remaining steps require an authorized render-web session cookie:
  3. POST /api/streaming/sessions   → returns { sessionId, approveTx, ephemeralSignerPubkey }
  4. Sign approveTx with the wallet keypair, submit via RPC, POST /grant-signed
  5. Loop ${voucherCount}× POST /api/streaming/sessions/:id/voucher-relay { amount: ${voucherAmount}, recipient }
  6. ${args['skip-cron'] ? 'Operator will invoke settle manually.' : 'Invoke pnpm -F render-web streaming:settle'}
  7. Poll RPC.getSignatureStatus(settlementTxid) until 'confirmed'.
  8. POST /api/streaming/sessions/:id/revoke, sign + submit, verify subsequent vouchers 409.

Operator action required:
  - Spin up render-web at http://127.0.0.1:${renderPort} with a valid SESSION_SECRET.
  - Mint a wallet session via /api/auth/* (or use an existing devnet session cookie).
  - Export AGENTIC_SMOKE_COOKIE='agentic_session=<token>' and follow the
    runbook's steps 3-8.

See docs/smoke/streaming-settlement.md for the full procedure.
`);
process.exit(0);
