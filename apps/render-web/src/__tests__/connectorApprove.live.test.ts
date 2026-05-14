// Live mainnet end-to-end test for the Approve and send flow.
//
// What this proves: the real HTTP request the browser fires when a user clicks
// "Approve and send" on a Kamino SOL deposit ALREADY-FUNDED on Render returns a
// real, signable web3.js Transaction. We boot the actual render-web HTTP server
// (no preparer stubs, no mocks) — `ensureKaminoConfigured()` wires the real
// klend-sdk client against mainnet — POST exactly the JSON the browser POSTs to
// `/api/connector/prepare-transaction`, then decode the returned base64 and
// verify it carries a real KLend instruction.
//
// Opt-in via env so CI without internet doesn't trip:
//
//   AGENT_WALLET_KAMINO_LIVE=1 SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
//     pnpm -F @solana-agent-wallet-adapter/render-web test -- --run connectorApprove.live

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

import { describe, expect, it } from 'vitest';
import { PublicKey, Transaction } from '@solana/web3.js';

import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { createRenderWebServer } from '../server.js';

const LIVE = process.env.AGENT_WALLET_KAMINO_LIVE === '1';
const RPC_URL = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';

// Real funded mainnet wallet — used as the prepare wallet, never signed against.
// KaminoAction.buildDepositTxns emits init-obligation instructions automatically
// when the wallet has no existing Kamino position, which is exactly the path a
// first-time user hits.
const TEST_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

// Canonical SOL mint — matches `KAMINO_KNOWN_RESERVES['SOL'].mint` and resolves
// via Kamino Main Market.
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const KLEND_PROGRAM_ID = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';

const describeLive = LIVE ? describe : describe.skip;

describeLive('Approve and send → /api/connector/prepare-transaction (live mainnet)', () => {
  it('returns a signable Kamino SOL deposit Transaction when the browser POSTs Approve', async () => {
    // Ensure the SDK client picks up the same RPC URL the browser flow would.
    process.env.SOLANA_RPC_URL = RPC_URL;

    await withServer(async (port) => {
      const response = await postJson(port, '/api/connector/prepare-transaction', {
        kind: 'kamino_deposit',
        params: { token: 'SOL', amount: '0.01' },
        walletAddress: TEST_WALLET,
        cluster: 'mainnet-beta',
      });

      // Surface server-side error context to the developer if the live SDK call
      // failed — much more useful than a bare status assertion.
      if (response.status !== 200) {
        throw new Error(`Expected 200 but got ${response.status}: ${JSON.stringify(response.body)}`);
      }

      const body = response.body as {
        transactionBase64?: string;
        summary?: string;
        cluster?: string;
        preview?: Record<string, unknown>;
      };
      expect(typeof body.transactionBase64).toBe('string');
      expect(typeof body.summary).toBe('string');
      expect(body.cluster).toBe('mainnet-beta');
      expect(body.summary).toMatch(/Deposit .* SOL .* Kamino/i);

      // Decode the base64 the browser would hand to the wallet. The tx must:
      //  • have our wallet as fee payer (so the wallet recognizes the action),
      //  • carry a real recent blockhash (so it can actually land on-chain),
      //  • contain at least one Klend program instruction (so it really does what
      //    the summary claims and not, say, a stale stub).
      const tx = Transaction.from(Buffer.from(body.transactionBase64!, 'base64'));
      expect(tx.feePayer?.toBase58()).toBe(TEST_WALLET);
      expect(typeof tx.recentBlockhash).toBe('string');
      expect((tx.recentBlockhash as string).length).toBeGreaterThan(20);

      const programIds = tx.instructions.map((ix) => ix.programId.toBase58());
      expect(programIds).toContain(KLEND_PROGRAM_ID);

      // Sanity-check the preview enrichment too — the inbox renders `reserveSymbol`
      // and `reserveAddress` in the approval card; they must be present after a
      // real KaminoMarket.load + reserve resolution.
      expect(body.preview).toMatchObject({ reserveSymbol: 'SOL' });
      const reserveAddress = (body.preview as { reserveAddress?: unknown })?.reserveAddress;
      expect(typeof reserveAddress).toBe('string');
      expect(() => new PublicKey(reserveAddress as string)).not.toThrow();
    });
  }, 180_000);

  it('emits the same SOL deposit tx shape when the browser POSTs the underlying mint instead of the symbol', async () => {
    process.env.SOLANA_RPC_URL = RPC_URL;
    await withServer(async (port) => {
      const response = await postJson(port, '/api/connector/prepare-transaction', {
        kind: 'kamino_deposit',
        params: { token: SOL_MINT, amount: '0.01' },
        walletAddress: TEST_WALLET,
        cluster: 'mainnet-beta',
      });
      if (response.status !== 200) {
        throw new Error(`Expected 200 but got ${response.status}: ${JSON.stringify(response.body)}`);
      }
      const body = response.body as { transactionBase64?: string };
      expect(typeof body.transactionBase64).toBe('string');
      const tx = Transaction.from(Buffer.from(body.transactionBase64!, 'base64'));
      expect(tx.instructions.map((ix) => ix.programId.toBase58())).toContain(KLEND_PROGRAM_ID);
    });
  }, 180_000);
});

async function withServer(callback: (port: number) => Promise<void>): Promise<void> {
  const staticDir = await mkdtemp(join(tmpdir(), 'agentic-render-kamino-live-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(staticDir, 'app'));
  await writeFile(join(staticDir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');
  // Real router. No stubs — the createCloudApiRouter constructor invokes
  // ensureKaminoConfigured(), which wires the live SDK client. This is the exact
  // boot path render-web takes on Render.
  const server = createRenderWebServer({
    staticDir,
    store: new MemoryWorkflowStore(),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : {},
          });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
