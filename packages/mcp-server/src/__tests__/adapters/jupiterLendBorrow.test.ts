import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';

// Minimal bn.js-compatible stub (bn.js isn't a direct dep of this package). Implements the
// BorrowBn surface the borrow client consumes.
class BN {
  readonly v: bigint;
  constructor(value: string | number | bigint) {
    this.v = typeof value === 'bigint' ? value : typeof value === 'number' ? BigInt(Math.trunc(value)) : BigInt(value);
  }
  toString(): string { return this.v.toString(); }
  toNumber(): number { return Number(this.v); }
  isZero(): boolean { return this.v === 0n; }
  isNeg(): boolean { return this.v < 0n; }
  neg(): BN { return new BN(-this.v); }
  add(o: BN): BN { return new BN(this.v + o.v); }
  mul(o: BN): BN { return new BN(this.v * o.v); }
  div(o: BN): BN { return new BN(o.v === 0n ? 0n : this.v / o.v); }
  gt(o: BN): boolean { return this.v > o.v; }
}

import {
  __resetJupiterLendBorrowSdkCacheForTests,
  __setJupiterLendBorrowSdkForTests,
  __setJupiterLendMintDecimalsForTests,
  __setJupiterLendReadClientForTests,
  getJupiterLendClient,
  type JupiterLendBorrowSdkBundle,
  type LendReadClientApi,
  type LendReadNftPosition,
  type LendReadVaultData,
} from '../../adapters/jupiter/index.js';
import type { AgentWalletConfig } from '../../config.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // stablecoin debt → USD values populated

function fakeConfig(): AgentWalletConfig {
  return { cluster: 'mainnet-beta', rpcUrl: 'https://api.fake', mainnet: { enabled: true }, tokens: [], connectors: { jupiter: {} } } as unknown as AgentWalletConfig;
}

// A vault whose collateral is wSOL (decimals resolve locally, no RPC) and debt is USDC.
function fakeVault(overrides: Partial<{ collateralFactor: number; liquidationThreshold: number; borrowRateVault: number; borrowFee: number }> = {}): LendReadVaultData {
  return {
    vault: new PublicKey('11111111111111111111111111111112'),
    constantViews: { vaultId: 7, supplyToken: WSOL, borrowToken: USDC },
    configs: {
      collateralFactor: new BN(overrides.collateralFactor ?? 800), // ÷1000 = 0.80 → 8000 bps
      liquidationThreshold: new BN(overrides.liquidationThreshold ?? 900), // ÷1000 = 0.90 → 9000 bps
      liquidationPenalty: new BN(50),
      borrowFee: new BN(overrides.borrowFee ?? 0),
      oracle: new PublicKey('11111111111111111111111111111113'),
    },
    exchangePricesAndRates: { borrowRateVault: overrides.borrowRateVault ?? 500, supplyRateVault: 200 }, // ÷100 = 5% / 2%
    limitsAndAvailability: { borrowable: new BN('1000000000'), withdrawable: new BN('2000000000') },
    totalSupplyAndBorrow: { totalSupplyVault: new BN('5000000000'), totalBorrowVault: new BN('3000000000') },
  };
}

// oraclePrice is 1e15-scaled: collateral(wSOL, 9dp) priced in debt(USDC, 6dp) units.
// To make 1 SOL ≈ 100 USDC: colRaw(1e9) * price / 1e15 = debtUnits. Want 100 * 1e6 = 1e8.
// 1e9 * price / 1e15 = 1e8 → price = 1e14.
const ORACLE_PRICE_100 = new BN('100000000000000'); // 1e14

const MAX_REPAY_SENTINEL = new BN('-170141183460469231731687303715884105728'); // MIN_I128 (SDK sentinel value)

function fakeBorrowSdk(operateCapture: { args?: unknown }): JupiterLendBorrowSdkBundle {
  return {
    getInitPositionIx: vi.fn(async () => ({ ix: SystemProgram.transfer({ fromPubkey: new PublicKey(WALLET), toPubkey: new PublicKey(WALLET), lamports: 0 }), nftId: 1 })),
    getOperateIx: vi.fn(async (args) => {
      operateCapture.args = args;
      return {
        ixs: [SystemProgram.transfer({ fromPubkey: new PublicKey(WALLET), toPubkey: new PublicKey(WALLET), lamports: 1 })],
        addressLookupTableAccounts: [],
        nftId: 1,
      };
    }),
    getCurrentPosition: vi.fn(async () => ({ colRaw: new BN('1000000000') as never, debtRaw: new BN('50000000') as never, userLiquidationStatus: false })),
    readOraclePrice: vi.fn(async () => ({ oraclePriceOperate: ORACLE_PRICE_100 as never, oraclePriceLiquidate: ORACLE_PRICE_100 as never })),
    MAX_REPAY_AMOUNT: MAX_REPAY_SENTINEL as never,
    MAX_WITHDRAW_AMOUNT: MAX_REPAY_SENTINEL as never,
    BN: BN as never,
  };
}

function fakeReadClient(vault: LendReadVaultData, positions: LendReadNftPosition[] = []): LendReadClientApi {
  return {
    vault: {
      getAllVaults: vi.fn(async () => [vault]),
      getVaultByVaultId: vi.fn(async () => vault),
      getAllUserPositions: vi.fn(async () => positions),
      getPositionByVaultId: vi.fn(async () => positions[0]!),
      getFinalPosition: vi.fn(async () => ({ colRaw: new BN('0') as never, debtRaw: new BN('0') as never })),
    },
  };
}

beforeEach(() => {
  __resetJupiterLendBorrowSdkCacheForTests();
  __setJupiterLendMintDecimalsForTests(USDC.toBase58(), 6); // avoid a live getMint RPC for the debt mint
  vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 } as never);
});
afterEach(() => {
  __resetJupiterLendBorrowSdkCacheForTests();
  __setJupiterLendMintDecimalsForTests(USDC.toBase58(), undefined);
  vi.restoreAllMocks();
});

describe('Jupiter Borrow write path (getOperateIx)', () => {
  it('open (create) bundles collateral + borrow at positionId 0 and returns a v0 transaction', async () => {
    const capture: { args?: unknown } = {};
    __setJupiterLendBorrowSdkForTests(fakeBorrowSdk(capture));
    __setJupiterLendReadClientForTests(fakeReadClient(fakeVault()));
    const client = await getJupiterLendClient(WALLET, fakeConfig());
    const result = await client.buildBorrowCreatePosition({ walletAddress: WALLET, cluster: 'mainnet-beta', vaultId: 7, collateralAmount: '1', collateralAmountRaw: '1000000000', borrowAmount: '50', borrowAmountRaw: '50000000' });
    const args = capture.args as { positionId: number; colAmount: BN; debtAmount: BN };
    expect(args.positionId).toBe(0);
    expect(args.colAmount.toString()).toBe('1000000000');
    expect(args.debtAmount.toString()).toBe('50000000');
    // Result must be a versioned (v0) transaction.
    const tx = VersionedTransaction.deserialize(Buffer.from(result.transactionBase64, 'base64'));
    expect(tx.message.version).toBe(0);
  });

  it('repay-all passes the MAX_REPAY_AMOUNT sentinel as debtAmount', async () => {
    const capture: { args?: unknown } = {};
    __setJupiterLendBorrowSdkForTests(fakeBorrowSdk(capture));
    __setJupiterLendReadClientForTests(fakeReadClient(fakeVault()));
    const client = await getJupiterLendClient(WALLET, fakeConfig());
    await client.buildBorrowRepay({ walletAddress: WALLET, cluster: 'mainnet-beta', vaultId: 7, positionId: 3, amount: '0', amountRaw: '0', repayAll: true });
    const args = capture.args as { debtAmount: BN; colAmount: BN };
    expect(args.debtAmount).toBe(MAX_REPAY_SENTINEL);
    expect(args.colAmount.isZero()).toBe(true);
  });

  it('withdraw collateral passes a negative colAmount', async () => {
    const capture: { args?: unknown } = {};
    __setJupiterLendBorrowSdkForTests(fakeBorrowSdk(capture));
    __setJupiterLendReadClientForTests(fakeReadClient(fakeVault()));
    const client = await getJupiterLendClient(WALLET, fakeConfig());
    await client.buildBorrowWithdrawCollateral({ walletAddress: WALLET, cluster: 'mainnet-beta', vaultId: 7, positionId: 3, amount: '0.5', amountRaw: '500000000', minHealthRatio: 1.25 });
    const args = capture.args as { colAmount: BN };
    expect(args.colAmount.isNeg()).toBe(true);
    expect(args.colAmount.toString()).toBe('-500000000');
  });
});

describe('Jupiter Borrow read/health mapping', () => {
  it('maps vault config to bps + APR', async () => {
    __setJupiterLendBorrowSdkForTests(fakeBorrowSdk({}));
    __setJupiterLendReadClientForTests(fakeReadClient(fakeVault()));
    const client = await getJupiterLendClient(WALLET, fakeConfig());
    const vault = await client.getBorrowVaultDetail({ vaultId: 7 });
    expect(vault.ltvBps).toBe(8000); // collateralFactor 800 ×10
    expect(vault.liquidationThresholdBps).toBe(9000); // liquidationThreshold 900 ×10
    expect(vault.borrowApr).toBeCloseTo(5, 5); // 500 ÷100
    expect(vault.borrowMint).toBe(USDC.toBase58());
  });

  it('computes health tiers and clears health for a zero-debt position', async () => {
    const vault = fakeVault();
    // 1 SOL collateral (~100 USDC), 50 USDC debt → LTV 50%, health = 0.90/0.50 = 1.8 → safe.
    const safePosition: LendReadNftPosition = { nftId: 3, owner: new PublicKey(WALLET), supply: new BN('1000000000'), borrow: new BN('50000000'), isLiquidated: false, vault };
    __setJupiterLendBorrowSdkForTests(fakeBorrowSdk({}));
    __setJupiterLendReadClientForTests(fakeReadClient(vault, [safePosition]));
    const client = await getJupiterLendClient(WALLET, fakeConfig());
    const [pos] = await client.getBorrowPositions({ walletAddress: WALLET });
    expect(pos!.liquidationStatus).toBe('safe');
    expect(pos!.healthRatio).toBeCloseTo(1.8, 1);
    expect(pos!.ltvBps).toBeCloseTo(5000, -2); // ~50%
    expect(pos!.debtValueUsd).toBeDefined(); // USDC debt → USD populated

    // Zero-debt position → health null, safe (no liquidation risk).
    const noDebt: LendReadNftPosition = { ...safePosition, borrow: new BN('0') };
    __setJupiterLendReadClientForTests(fakeReadClient(vault, [noDebt]));
    const client2 = await getJupiterLendClient(WALLET, fakeConfig());
    const [pos2] = await client2.getBorrowPositions({ walletAddress: WALLET });
    expect(pos2!.healthRatio).toBeNull();
    expect(pos2!.liquidationStatus).toBe('safe');
  });

  it('previewBorrowHealth projects an unsafe open as blocked with warnings', async () => {
    const vault = fakeVault();
    __setJupiterLendBorrowSdkForTests(fakeBorrowSdk({}));
    __setJupiterLendReadClientForTests(fakeReadClient(vault, []));
    const client = await getJupiterLendClient(WALLET, fakeConfig());
    // Deposit 1 SOL (~100 USDC), borrow 95 USDC → LTV 95% > maxLTV 80% and health 0.90/0.95<1 → blocked.
    const preview = await client.previewBorrowHealth({ walletAddress: WALLET, vaultId: 7, collateralDelta: '1', debtDelta: '95', minHealthRatio: 1.25 });
    expect(preview.blocked).toBe(true);
    expect(preview.warnings.length).toBeGreaterThan(0);
    expect(preview.after.liquidationStatus === 'liquidatable' || preview.after.healthRatio! < 1.25).toBe(true);
  });
});
