import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WALLET_BALANCE_SOL_MINT,
  WALLET_BALANCE_USDC_MINT,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';
import { PublicKey } from '@solana/web3.js';

import { AgentWalletActionService } from '../actionService.js';
import { DEFAULT_CONFIG } from '../config.js';

const WALLET_ADDRESS = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

describe('AgentWalletActionService wallet balance summary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('loads SOL and canonical USDC independently of configured token allowlist', async () => {
    vi.stubEnv('BIRDEYE_API_KEY', 'birdeye-test-key');
    const originalFetch = globalThis.fetch;
    const upstreamUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.hostname === 'public-api.birdeye.so') {
        upstreamUrls.push(url.toString());
        return new Response(JSON.stringify({
          data: {
            So11111111111111111111111111111111111111112: { value: 150 },
            [WALLET_BALANCE_USDC_MINT]: { value: 1 },
          },
        }), { headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(input);
    }) as typeof fetch);

    const service = new AgentWalletActionService({
      backend: testBackend(),
      config: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        tokens: [],
      },
      connection: fakeConnection({
        solLamports: 2_000_000_000,
        usdcRawAmount: '25500000',
      }),
    });

    const snapshot = await service.walletBalanceSummary({ mode: 'primary' });

    expect(snapshot.coverage).toBe('primary');
    expect(snapshot.walletAddress).toBe(WALLET_ADDRESS);
    expect(snapshot.sol.amount).toBe(2);
    expect(snapshot.usdc.amount).toBe(25.5);
    expect(snapshot.totalUsd).toBe(325.5);
    expect(snapshot.priceStatus).toBe('ready');
    expect(upstreamUrls[0]).toContain('include_liquidity=true');
  });

  it('falls back to Jupiter Lite prices when Birdeye is unavailable', async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.hostname === 'lite-api.jup.ag') {
        expect(url.pathname).toBe('/price/v3');
        expect(url.searchParams.get('ids')).toContain(WALLET_BALANCE_SOL_MINT);
        return new Response(JSON.stringify({
          [WALLET_BALANCE_SOL_MINT]: { usdPrice: 150, liquidity: 7_000_000_000 },
          [WALLET_BALANCE_USDC_MINT]: { usdPrice: 1, liquidity: 500_000_000 },
        }), { headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(input);
    }) as typeof fetch);

    const service = new AgentWalletActionService({
      backend: testBackend(),
      config: {
        ...DEFAULT_CONFIG,
        cluster: 'mainnet-beta',
        tokens: [],
      },
      connection: fakeConnection({
        solLamports: 2_000_000_000,
        usdcRawAmount: '25500000',
      }),
    });

    const snapshot = await service.walletBalanceSummary({ mode: 'primary' });

    expect(snapshot.totalUsd).toBe(325.5);
    expect(snapshot.priceStatus).toBe('ready');
    expect(snapshot.sol.priceSource).toBe('jupiter');
  });

  it('scans token and token-2022 accounts only in full mode', async () => {
    const jupMint = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    const service = new AgentWalletActionService({
      backend: testBackend(),
      config: {
        ...DEFAULT_CONFIG,
        cluster: 'devnet',
        tokens: [],
      },
      connection: fakeConnection({
        solLamports: 1_000_000_000,
        usdcRawAmount: '5000000',
        tokenProgramRows: [parsedTokenAccount(jupMint, '7000000', 6, '7')],
      }),
    });

    const snapshot = await service.walletBalanceSummary({ mode: 'full' });

    expect(snapshot.coverage).toBe('full');
    expect(snapshot.priceStatus).toBe('unavailable');
    expect(snapshot.usdc.amount).toBe(5);
    expect(snapshot.others.map((asset) => asset.mint)).toEqual([jupMint]);
  });
});

function testBackend(): WalletBackend {
  return {
    async capabilities() {
      return {
        backend: 'test',
        cluster: ['mainnet-beta', 'devnet'],
        address: WALLET_ADDRESS,
        supports: {
          signMessage: true,
          signTransaction: true,
          signAndSendTransaction: true,
          multiSign: false,
          simulationPreview: false,
        },
      };
    },
    async getAddress() {
      return WALLET_ADDRESS;
    },
    async submit() {
      throw new Error('not used');
    },
    async poll() {
      throw new Error('not used');
    },
  };
}

function fakeConnection(input: {
  solLamports: number;
  usdcRawAmount: string;
  tokenProgramRows?: unknown[];
  token2022Rows?: unknown[];
}) {
  return {
    async getBalance() {
      return input.solLamports;
    },
    async getParsedTokenAccountsByOwner(_owner: PublicKey, filter: { mint?: PublicKey; programId?: PublicKey }) {
      if (filter.mint) {
        return { value: [parsedTokenAccount(WALLET_BALANCE_USDC_MINT, input.usdcRawAmount, 6, rawToUi(input.usdcRawAmount, 6))] };
      }
      const program = filter.programId?.toBase58();
      if (program === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
        return { value: input.token2022Rows ?? [] };
      }
      return {
        value: [
          parsedTokenAccount(WALLET_BALANCE_USDC_MINT, input.usdcRawAmount, 6, rawToUi(input.usdcRawAmount, 6)),
          ...(input.tokenProgramRows ?? []),
        ],
      };
    },
  } as never;
}

function parsedTokenAccount(mint: string, amount: string, decimals: number, uiAmountString: string) {
  return {
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: {
              amount,
              decimals,
              uiAmountString,
            },
          },
        },
      },
    },
  };
}

function rawToUi(amount: string, decimals: number): string {
  return String(Number(amount) / 10 ** decimals);
}
