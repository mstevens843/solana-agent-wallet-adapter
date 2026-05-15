// Real SaveClient implementation backed by @solendprotocol/solend-sdk. The SDK is
// vanilla web3.js (no @solana/kit), so the wiring is much lighter than Kamino's.
//
// Wire this at boot from your runtime by calling:
//   import { setSaveClientFactory } from '@solana-agent-wallet-adapter/mcp-server';
//   import { buildSaveSdkClient } from '.../sdkClient.js';
//   setSaveClientFactory(() => buildSaveSdkClient({ rpcUrl: process.env.SOLANA_RPC_URL! }));
//
// Without this, every Save approve fails with "@solendprotocol/solend-sdk is not wired."

import { Connection, PublicKey } from '@solana/web3.js';

import type {
  SaveBuildInput,
  SaveBuildResult,
  SaveClient,
  SaveMarketSnapshot,
  SaveObligation,
  SaveReserveSnapshot,
} from './client.js';

interface BuildSaveSdkClientOptions {
  rpcUrl: string;
  /** Override the production main pool if needed (defaults to Save Main Market). */
  mainPoolAddress?: string;
}

export interface SdkBundle {
  SolendActionCore: typeof import('@solendprotocol/solend-sdk').SolendActionCore;
  parseReserve: typeof import('@solendprotocol/solend-sdk').parseReserve;
  MAIN_POOL_ADDRESS: PublicKey;
  SOLEND_PRODUCTION_PROGRAM_ID: PublicKey;
  fetchPoolMetadata: typeof import('@solendprotocol/solend-sdk').fetchPoolMetadata;
}

let cachedSdk: SdkBundle | undefined;

export async function loadSaveSdkForSmokeTest(): Promise<SdkBundle> {
  if (cachedSdk) return cachedSdk;
  const sdk = await import('@solendprotocol/solend-sdk');
  cachedSdk = {
    SolendActionCore: sdk.SolendActionCore,
    parseReserve: sdk.parseReserve,
    MAIN_POOL_ADDRESS: sdk.MAIN_POOL_ADDRESS,
    SOLEND_PRODUCTION_PROGRAM_ID: sdk.SOLEND_PRODUCTION_PROGRAM_ID,
    fetchPoolMetadata: sdk.fetchPoolMetadata,
  };
  return cachedSdk;
}

const loadSdk = loadSaveSdkForSmokeTest;

interface CachedPool {
  pool: {
    address: string;
    owner: string;
    name: string | null;
    authorityAddress: string;
    reserves: Array<{
      address: string;
      liquidityAddress: string;
      cTokenMint: string;
      cTokenLiquidityAddress: string;
      pythOracle: string;
      switchboardOracle: string;
      mintAddress: string;
      liquidityFeeReceiverAddress: string;
      decimals: number;
      symbol: string;
    }>;
  };
  loadedAt: number;
}

const POOL_TTL_MS = 60_000;

export function buildSaveSdkClient(options: BuildSaveSdkClientOptions): SaveClient {
  let cached: CachedPool | undefined;

  async function getPool(connection: Connection): Promise<CachedPool['pool']> {
    if (cached && Date.now() - cached.loadedAt < POOL_TTL_MS) return cached.pool;
    const sdk = await loadSdk();
    const mainPoolAddress = options.mainPoolAddress
      ? new PublicKey(options.mainPoolAddress)
      : sdk.MAIN_POOL_ADDRESS;
    const programId = sdk.SOLEND_PRODUCTION_PROGRAM_ID;
    // Lending market authority PDA. Solend deposit/withdraw/borrow/repay
    // instructions all read pool.authorityAddress and call new PublicKey on
    // it; an empty string here throws "Invalid public key input" before the
    // wallet ever sees a transaction.
    const [poolAuthority] = PublicKey.findProgramAddressSync(
      [mainPoolAddress.toBytes()],
      programId,
    );
    // Pull every Solend reserve account owned by the program and filtered to this
    // lending market. memcmp offset 10 is `lendingMarket` per the on-chain layout
    // (1 byte version + 1 byte unused + 8 byte lastUpdate.slot + 1 byte stale = 10
    // bytes header before `lendingMarket: PublicKey`).
    const reserveAccounts = await connection.getProgramAccounts(programId, {
      filters: [
        { dataSize: 619 },
        { memcmp: { offset: 10, bytes: mainPoolAddress.toBase58() } },
      ],
      commitment: 'confirmed',
    });
    const reserves = reserveAccounts.map((entry) => {
      const parsed = sdk.parseReserve(entry.pubkey, entry.account);
      const info = parsed.info;
      return {
        address: entry.pubkey.toBase58(),
        liquidityAddress: info.liquidity.supplyPubkey.toBase58(),
        cTokenMint: info.collateral.mintPubkey.toBase58(),
        cTokenLiquidityAddress: info.collateral.supplyPubkey.toBase58(),
        pythOracle: info.liquidity.pythOracle.toBase58(),
        switchboardOracle: info.liquidity.switchboardOracle.toBase58(),
        mintAddress: info.liquidity.mintPubkey.toBase58(),
        liquidityFeeReceiverAddress: info.config.feeReceiver.toBase58(),
        decimals: info.liquidity.mintDecimals,
        symbol: shortMintLabel(info.liquidity.mintPubkey.toBase58()),
      };
    });
    if (reserves.length === 0) {
      throw new Error('Save Main Market has no reserves visible from this RPC.');
    }
    // Best-effort symbol resolution via the public Save API metadata. Failure is
    // non-fatal — the deposit still works with the on-chain mint as the symbol.
    try {
      const metadata = await sdk.fetchPoolMetadata(connection, 'production', undefined, true, false);
      const main = metadata.find((entry) => entry.address === mainPoolAddress.toBase58());
      if (main) {
        for (const reserve of reserves) {
          const meta = main.reserves.find((entry) => entry.mintAddress === reserve.mintAddress);
          if (meta?.name) reserve.symbol = meta.name;
        }
      }
    } catch {
      // ignore — keep mint-derived labels
    }
    const pool: CachedPool['pool'] = {
      address: mainPoolAddress.toBase58(),
      owner: '',
      name: 'Main Pool',
      authorityAddress: poolAuthority.toBase58(),
      reserves,
    };
    cached = { pool, loadedAt: Date.now() };
    return pool;
  }

  function resolveReserve(
    pool: CachedPool['pool'],
    reserveMint: string,
  ): CachedPool['pool']['reserves'][number] {
    const match = pool.reserves.find((reserve) => reserve.mintAddress === reserveMint);
    if (!match) {
      throw new Error(`Save Main Market has no reserve for mint ${reserveMint}.`);
    }
    return match;
  }

  function snapshotFromReserve(
    reserve: CachedPool['pool']['reserves'][number],
    marketAddress: string,
  ): SaveReserveSnapshot {
    return {
      reserveAddress: reserve.address,
      reserveMint: reserve.mintAddress,
      reserveSymbol: reserve.symbol,
      decimals: reserve.decimals,
      marketAddress,
      supplyApy: 0,
      borrowApy: 0,
      utilization: 0,
      totalSupply: '0',
      totalBorrow: '0',
      liquidity: '0',
      collateralFactor: 0,
      liquidationThreshold: 0,
      liquidationBonus: 0,
      withdrawAvailable: '0',
      lastUpdateSlot: 0,
    };
  }

  async function buildTransaction(
    connection: Connection,
    input: SaveBuildInput,
    flavor: 'deposit' | 'withdraw' | 'borrow' | 'repay',
  ): Promise<SaveBuildResult> {
    const pool = await getPool(connection);
    const reserve = resolveReserve(pool, input.reserveMint);
    const sdk = await loadSdk();
    const wallet = { publicKey: new PublicKey(input.walletAddress) };
    const config = { environment: 'production' as const };
    const amount = flavor === 'withdraw' && input.withdrawAll
      ? '18446744073709551615' // U64_MAX
      : input.amountRaw.toString();
    const builder = flavor === 'deposit'
      ? sdk.SolendActionCore.buildDepositTxns
      : flavor === 'withdraw'
        ? sdk.SolendActionCore.buildWithdrawTxns
        : flavor === 'borrow'
          ? sdk.SolendActionCore.buildBorrowTxns
          : sdk.SolendActionCore.buildRepayTxns;
    const action = await builder(
      pool as never,
      reserve as never,
      connection,
      amount,
      wallet as never,
      config as never,
    );
    const txns = await action.getLegacyTransactions();
    const lending = txns.lendingTxn;
    if (!lending) {
      throw new Error('Save adapter could not produce a lending transaction. The wallet may need to create an obligation first.');
    }
    lending.feePayer = wallet.publicKey;
    if (!lending.recentBlockhash) {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      lending.recentBlockhash = blockhash;
    }
    return {
      transaction: lending,
      reserveAddress: reserve.address,
      reserveSymbol: reserve.symbol,
      decimals: reserve.decimals,
      amountUi: rawToUiAmount(input.amountRaw, reserve.decimals),
      reserveSnapshot: snapshotFromReserve(reserve, pool.address),
    };
  }

  return {
    async getMarketSnapshot(connection: Connection): Promise<SaveMarketSnapshot> {
      const pool = await getPool(connection);
      return {
        marketAddress: pool.address,
        programId: '',
        reserveCount: pool.reserves.length,
        totalDeposits: '0',
        totalBorrows: '0',
        reserves: pool.reserves.map((entry) => snapshotFromReserve(entry, pool.address)),
      };
    },

    async getReserveSnapshot(connection: Connection, reserveMint: string): Promise<SaveReserveSnapshot> {
      const pool = await getPool(connection);
      return snapshotFromReserve(resolveReserve(pool, reserveMint), pool.address);
    },

    async listReserveSnapshots(connection: Connection): Promise<SaveReserveSnapshot[]> {
      const pool = await getPool(connection);
      return pool.reserves.map((entry) => snapshotFromReserve(entry, pool.address));
    },

    async getObligation(): Promise<SaveObligation | null> {
      // Wallet-obligation enumeration requires more SDK plumbing; returning null
      // keeps the option provider running and lets approve flows still go through.
      return null;
    },

    buildDepositTransaction(connection, input) {
      return buildTransaction(connection, input, 'deposit');
    },

    buildWithdrawTransaction(connection, input) {
      return buildTransaction(connection, input, 'withdraw');
    },

    buildBorrowTransaction(connection, input) {
      return buildTransaction(connection, input, 'borrow');
    },

    buildRepayTransaction(connection, input) {
      return buildTransaction(connection, input, 'repay');
    },
  };
}

function shortMintLabel(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function rawToUiAmount(raw: bigint, decimals: number): string {
  const value = raw;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionText}`;
}
