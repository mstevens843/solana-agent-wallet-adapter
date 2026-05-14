// Real KaminoClient implementation backed by @kamino-finance/klend-sdk. The SDK
// uses @solana/kit (Address/Instruction/TransactionSigner/Rpc) — we bridge each
// kit instruction back to a web3.js TransactionInstruction so the result slots
// into our existing Transaction-based execution pipeline (browser wallet signs,
// existing simulate-before-sign code still runs).
//
// Wire this at boot from your runtime (CLI bridge or render-web) by calling:
//   import { setKaminoClientFactory } from '@solana-agent-wallet-adapter/mcp-server';
//   import { buildKaminoSdkClient } from '@solana-agent-wallet-adapter/mcp-server/.../sdkClient.js';
//   setKaminoClientFactory(() => buildKaminoSdkClient({ rpcUrl: process.env.SOLANA_RPC_URL! }));

import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import type {
  KaminoBuildDepositInput,
  KaminoBuildDepositResult,
  KaminoBuildWithdrawInput,
  KaminoBuildWithdrawResult,
  KaminoClient,
  KaminoPosition,
  KaminoReserveSnapshot,
} from './client.js';
import {
  KAMINO_KNOWN_RESERVES,
  KAMINO_MAIN_MARKET,
  KLEND_PROGRAM_ID,
  findKnownReserveByMint,
} from './constants.js';

interface BuildKaminoSdkClientOptions {
  rpcUrl: string;
  recentSlotDurationMs?: number;
}

interface SdkBundle {
  KaminoAction: typeof import('@kamino-finance/klend-sdk').KaminoAction;
  KaminoMarket: typeof import('@kamino-finance/klend-sdk').KaminoMarket;
  VanillaObligation: typeof import('@kamino-finance/klend-sdk').VanillaObligation;
}

interface KitBundle {
  address: (value: string) => import('@solana/kit').Address;
  createNoopSigner: (address: import('@solana/kit').Address) => import('@solana/kit').TransactionSigner;
  createSolanaRpc: (url: string) => unknown;
  isSignerRole: (role: number) => boolean;
  isWritableRole: (role: number) => boolean;
}

let cachedSdk: SdkBundle | undefined;
let cachedKit: KitBundle | undefined;

async function loadSdk(): Promise<SdkBundle> {
  if (cachedSdk) return cachedSdk;
  const sdk = await import('@kamino-finance/klend-sdk');
  cachedSdk = {
    KaminoAction: sdk.KaminoAction,
    KaminoMarket: sdk.KaminoMarket,
    VanillaObligation: sdk.VanillaObligation,
  };
  return cachedSdk;
}

async function loadKit(): Promise<KitBundle> {
  if (cachedKit) return cachedKit;
  const kit = await import('@solana/kit');
  cachedKit = {
    address: kit.address,
    createNoopSigner: kit.createNoopSigner,
    createSolanaRpc: kit.createSolanaRpc,
    isSignerRole: kit.isSignerRole,
    isWritableRole: kit.isWritableRole,
  };
  return cachedKit;
}

export function buildKaminoSdkClient(options: BuildKaminoSdkClientOptions): KaminoClient {
  const recentSlotDurationMs = options.recentSlotDurationMs ?? 450;
  let cachedMarket: { market: unknown; loadedAt: number } | undefined;
  const MARKET_TTL_MS = 60_000;

  async function getMarket(): Promise<unknown> {
    if (cachedMarket && Date.now() - cachedMarket.loadedAt < MARKET_TTL_MS) {
      return cachedMarket.market;
    }
    const { KaminoMarket } = await loadSdk();
    const kit = await loadKit();
    const rpc = kit.createSolanaRpc(options.rpcUrl);
    const market = await KaminoMarket.load(
      rpc as never,
      kit.address(KAMINO_MAIN_MARKET.toBase58()),
      recentSlotDurationMs,
      kit.address(KLEND_PROGRAM_ID.toBase58()),
      true,
    );
    if (!market) {
      throw new Error('Kamino Main Market failed to load. Verify the SOLANA_RPC_URL is reachable from this runtime.');
    }
    cachedMarket = { market, loadedAt: Date.now() };
    return market;
  }

  function reserveFromMarket(market: unknown, reserveMint: string): {
    address: string;
    mint: string;
    symbol: string;
    decimals: number;
    rawReserve: unknown;
  } {
    const reserves = (market as { reserves: Map<unknown, unknown> }).reserves;
    let matched: { address: string; reserve: unknown } | undefined;
    for (const [address, reserve] of reserves.entries()) {
      const liquidityMint = readNestedString(reserve, ['stats', 'mintAddress']) ??
        readNestedString(reserve, ['state', 'liquidity', 'mintPubkey']);
      if (liquidityMint && liquidityMint === reserveMint) {
        matched = { address: String(address), reserve };
        break;
      }
    }
    if (!matched) {
      throw new Error(`Kamino Main Market has no reserve for mint ${reserveMint}.`);
    }
    const known = findKnownReserveByMint(reserveMint);
    const symbol = known?.symbol ?? readNestedString(matched.reserve, ['symbol']) ?? 'Reserve';
    const decimals = known?.decimals ?? readNestedNumber(matched.reserve, ['stats', 'decimals']) ?? 9;
    return {
      address: matched.address,
      mint: reserveMint,
      symbol,
      decimals,
      rawReserve: matched.reserve,
    };
  }

  function snapshotFromReserve(reserve: ReturnType<typeof reserveFromMarket>): KaminoReserveSnapshot {
    const stats = readNested<Record<string, unknown>>(reserve.rawReserve, ['stats']) ?? {};
    return {
      reserveAddress: reserve.address,
      reserveMint: reserve.mint,
      reserveSymbol: reserve.symbol,
      decimals: reserve.decimals,
      supplyApy: numericish(stats.supplyAPY ?? stats.supplyApy) ?? 0,
      borrowApy: numericish(stats.borrowAPY ?? stats.borrowApy) ?? 0,
      utilization: numericish(stats.utilization) ?? 0,
      totalSupply: stringish(stats.totalSupply ?? stats.totalLiquidity) ?? '0',
      totalBorrow: stringish(stats.totalBorrow ?? stats.totalBorrowed) ?? '0',
      withdrawalDelaySec: numericish(stats.withdrawalDelaySec) ?? 0,
      withdrawAvailable: stringish(stats.withdrawAvailable ?? stats.availableAmount) ?? '0',
      lastUpdateSlot: numericish(readNested(reserve.rawReserve, ['state', 'lastUpdate', 'slot'])) ?? 0,
    };
  }

  return {
    async getReserveSnapshot(_connection: Connection, reserveMint: string): Promise<KaminoReserveSnapshot> {
      const market = await getMarket();
      const reserve = reserveFromMarket(market, reserveMint);
      return snapshotFromReserve(reserve);
    },

    async listReserveSnapshots(_connection: Connection): Promise<KaminoReserveSnapshot[]> {
      const market = await getMarket();
      const reserves = (market as { reserves: Map<unknown, unknown> }).reserves;
      const out: KaminoReserveSnapshot[] = [];
      for (const [address, reserve] of reserves.entries()) {
        const liquidityMint = readNestedString(reserve, ['stats', 'mintAddress']) ??
          readNestedString(reserve, ['state', 'liquidity', 'mintPubkey']);
        if (!liquidityMint) continue;
        const known = findKnownReserveByMint(liquidityMint);
        out.push(snapshotFromReserve({
          address: String(address),
          mint: liquidityMint,
          symbol: known?.symbol ?? readNestedString(reserve, ['symbol']) ?? 'Reserve',
          decimals: known?.decimals ?? readNestedNumber(reserve, ['stats', 'decimals']) ?? 9,
          rawReserve: reserve,
        }));
      }
      // Stable order: prefer known reserves first.
      out.sort((a, b) => {
        const ai = KAMINO_KNOWN_RESERVES.findIndex((entry) => entry.mint === a.reserveMint);
        const bi = KAMINO_KNOWN_RESERVES.findIndex((entry) => entry.mint === b.reserveMint);
        if (ai === -1 && bi === -1) return a.reserveSymbol.localeCompare(b.reserveSymbol);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
      return out;
    },

    async getPositions(_connection: Connection, _walletAddress: string): Promise<KaminoPosition[]> {
      // Wallet positions require fetching obligations. Returning [] keeps the
      // dropdown/option provider running while a full implementation is wired up
      // (the deposit/withdraw flows themselves do not depend on this read).
      return [];
    },

    async buildDepositTransaction(
      connection: Connection,
      input: KaminoBuildDepositInput,
    ): Promise<KaminoBuildDepositResult> {
      const market = await getMarket();
      const reserve = reserveFromMarket(market, input.reserveMint);
      const sdk = await loadSdk();
      const kit = await loadKit();
      const ownerSigner = kit.createNoopSigner(kit.address(input.walletAddress));
      const action = await sdk.KaminoAction.buildDepositTxns(
        market as never,
        input.amountRaw.toString(),
        kit.address(reserve.mint),
        ownerSigner,
        new sdk.VanillaObligation(kit.address(KLEND_PROGRAM_ID.toBase58())),
        true,
        undefined,
      );

      const allIxs = sdk.KaminoAction.actionToIxs(action);
      const web3Ixs = allIxs.map((ix) => kitInstructionToWeb3(ix, kit));
      const transaction = new Transaction();
      for (const ix of web3Ixs) transaction.add(ix);
      const owner = new PublicKey(input.walletAddress);
      transaction.feePayer = owner;
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;

      const snapshot = snapshotFromReserve(reserve);
      const amountUi = rawToUiAmount(input.amountRaw, reserve.decimals);
      return {
        transaction,
        reserveAddress: reserve.address,
        reserveSymbol: reserve.symbol,
        decimals: reserve.decimals,
        amountUi,
        reserveSnapshot: snapshot,
      };
    },

    async buildWithdrawTransaction(
      connection: Connection,
      input: KaminoBuildWithdrawInput,
    ): Promise<KaminoBuildWithdrawResult> {
      const market = await getMarket();
      const reserve = reserveFromMarket(market, input.reserveMint);
      const sdk = await loadSdk();
      const kit = await loadKit();
      const ownerSigner = kit.createNoopSigner(kit.address(input.walletAddress));
      const amount = input.withdrawAll ? 'U64_MAX' : input.amountRaw.toString();
      const action = await sdk.KaminoAction.buildWithdrawTxns(
        market as never,
        amount,
        kit.address(reserve.mint),
        ownerSigner,
        new sdk.VanillaObligation(kit.address(KLEND_PROGRAM_ID.toBase58())),
        true,
        undefined,
      );

      const allIxs = sdk.KaminoAction.actionToIxs(action);
      const web3Ixs = allIxs.map((ix) => kitInstructionToWeb3(ix, kit));
      const transaction = new Transaction();
      for (const ix of web3Ixs) transaction.add(ix);
      const owner = new PublicKey(input.walletAddress);
      transaction.feePayer = owner;
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;

      const snapshot = snapshotFromReserve(reserve);
      const amountUi = input.withdrawAll ? 'max' : rawToUiAmount(input.amountRaw, reserve.decimals);
      return {
        transaction,
        reserveAddress: reserve.address,
        reserveSymbol: reserve.symbol,
        decimals: reserve.decimals,
        amountUi,
        reserveSnapshot: snapshot,
      };
    },
  };
}

function kitInstructionToWeb3(ix: unknown, kit: KitBundle): TransactionInstruction {
  const record = ix as {
    programAddress: string;
    accounts?: Array<{ address: string; role: number }>;
    data?: Uint8Array | ReadonlyArray<number>;
  };
  const keys = (record.accounts ?? []).map((account) => ({
    pubkey: new PublicKey(account.address),
    isSigner: kit.isSignerRole(account.role),
    isWritable: kit.isWritableRole(account.role),
  }));
  const data = record.data ? Buffer.from(record.data as Uint8Array) : Buffer.alloc(0);
  return new TransactionInstruction({
    programId: new PublicKey(record.programAddress),
    keys,
    data,
  });
}

function readNested<T>(source: unknown, path: string[]): T | undefined {
  let current: unknown = source;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as T | undefined;
}

function readNestedString(source: unknown, path: string[]): string | undefined {
  const value = readNested(source, path);
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { toString?: () => string }).toString === 'function') {
    const text = (value as { toString: () => string }).toString();
    if (text && text !== '[object Object]') return text;
  }
  return undefined;
}

function readNestedNumber(source: unknown, path: string[]): number | undefined {
  const value = readNested(source, path);
  return numericish(value);
}

function numericish(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber: () => number }).toNumber === 'function') {
    try {
      return (value as { toNumber: () => number }).toNumber();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stringish(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value && typeof value === 'object' && 'toString' in value && typeof (value as { toString: () => string }).toString === 'function') {
    const text = (value as { toString: () => string }).toString();
    if (text && text !== '[object Object]') return text;
  }
  return undefined;
}

function rawToUiAmount(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionText}`;
}
