import * as anchor from '@coral-xyz/anchor';
import { BN, BulkAccountLoader, DriftClient, type IWallet } from '@drift-labs/sdk';
import {
  IDL,
  VaultClient,
  WithdrawUnit as SdkWithdrawUnit,
  decodeName,
  getVaultDepositorAddressSync,
  type Vault,
  type VaultDepositor,
} from '@drift-labs/vaults-sdk';
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';

import type {
  DriftBuildVaultCancelWithdrawInput,
  DriftBuildVaultCancelWithdrawResult,
  DriftBuildVaultCompleteWithdrawInput,
  DriftBuildVaultCompleteWithdrawResult,
  DriftBuildVaultDepositInput,
  DriftBuildVaultDepositResult,
  DriftBuildVaultRequestWithdrawInput,
  DriftBuildVaultRequestWithdrawResult,
  DriftUserSnapshot,
  DriftVaultClient,
  DriftVaultDepositor,
  DriftVaultSnapshot,
  DriftWithdrawStatus,
} from './client.js';
import {
  DRIFT_PROGRAM_ID,
  DRIFT_VAULTS_PROGRAM_ID,
  DRIFT_VAULTS_PROGRAM_IDS,
  type DriftWithdrawUnit,
} from './constants.js';
import { convertLegacyAnchorIdl } from './legacyIdl.js';
import { fetchDriftVaultCatalog, type DriftVaultCatalogEntry } from './vaultCatalog.js';

interface BuildDriftVaultClientOptions {
  rpcUrl: string;
}

interface VaultSdkContext {
  driftClient: DriftClient;
  vaultClient: VaultClient;
  vaultProgramId: PublicKey;
}

const DRIFT_CLIENT_COMMITMENT = 'confirmed' as const;
const DRIFT_CLIENT_POLL_INTERVAL_MS = 1_000;

let catalogCache: { entries: DriftVaultCatalogEntry[]; loadedAt: number } | undefined;
const CATALOG_TTL_MS = 60_000;

export function buildDriftVaultClient(_options: BuildDriftVaultClientOptions): DriftVaultClient {
  return {
    async getUserSnapshot(connection, walletAddress, subAccountId = 0) {
      return withVaultSdk(connection, walletAddress, DRIFT_VAULTS_PROGRAM_ID, async ({ driftClient }) => {
        const authority = new PublicKey(walletAddress);
        const user = await driftClient.forceGetUserAccount(subAccountId, authority);
        const slot = await connection.getSlot(DRIFT_CLIENT_COMMITMENT);
        if (!user) {
          return {
            walletAddress,
            subAccountId,
            deposits: [],
            borrows: [],
            totalCollateral: '0',
            freeCollateral: '0',
            marginRatio: 0,
            asOfSlot: slot,
          };
        }
        return {
          walletAddress,
          subAccountId,
          userAccountAddress: (await driftClient.getUserAccountPublicKey(subAccountId, authority)).toBase58(),
          deposits: [],
          borrows: [],
          totalCollateral: '0',
          freeCollateral: '0',
          marginRatio: 0,
          asOfSlot: slot,
        } satisfies DriftUserSnapshot;
      });
    },

    async getVaultSnapshot(connection, vaultAddress) {
      const vaultPubkey = new PublicKey(vaultAddress);
      const programId = await resolveVaultProgramId(connection, vaultPubkey);
      return withVaultSdk(connection, vaultAddress, programId, async ({ vaultClient, vaultProgramId }) => {
        const { vault, slot } = await vaultClient.getVaultAndSlot(vaultPubkey);
        return snapshotFromVault(vaultClient, vault, vaultPubkey, vaultProgramId, slot);
      });
    },

    async getWalletVaultPositions(connection, walletAddress, vaultAddress) {
      const authority = new PublicKey(walletAddress);
      if (vaultAddress?.trim()) {
        const vaultPubkey = new PublicKey(vaultAddress);
        const programId = await resolveVaultProgramId(connection, vaultPubkey);
        return withVaultSdk(connection, walletAddress, programId, async ({ vaultClient, vaultProgramId }) => {
          const vault = await vaultClient.getVault(vaultPubkey);
          const depositorAddress = getVaultDepositorAddressSync(vaultProgramId, vaultPubkey, authority);
          const depositor = await fetchDepositorIfExists(vaultClient, depositorAddress);
          if (!depositor) return [];
          const slot = await connection.getSlot(DRIFT_CLIENT_COMMITMENT);
          return [await positionFromDepositor(vaultClient, depositor, vault, depositorAddress, walletAddress, slot)];
        });
      }

      const positions: DriftVaultDepositor[] = [];
      for (const programId of DRIFT_VAULTS_PROGRAM_IDS) {
        const programPositions = await withVaultSdk(connection, walletAddress, programId, async ({ vaultClient }) => {
          const depositors = await vaultClient.getAllVaultDepositorsForAuthority(authority);
          const slot = await connection.getSlot(DRIFT_CLIENT_COMMITMENT);
          const out: DriftVaultDepositor[] = [];
          for (const entry of depositors) {
            const vault = await vaultClient.getVault(entry.account.vault);
            out.push(await positionFromDepositor(vaultClient, entry.account, vault, entry.publicKey, walletAddress, slot));
          }
          return out;
        });
        positions.push(...programPositions);
      }
      return positions;
    },

    async getWithdrawStatus(connection, walletAddress, vaultAddress) {
      const vaultPubkey = new PublicKey(vaultAddress);
      const authority = new PublicKey(walletAddress);
      const programId = await resolveVaultProgramId(connection, vaultPubkey);
      return withVaultSdk(connection, walletAddress, programId, async ({ vaultClient, vaultProgramId }) => {
        const vault = await vaultClient.getVault(vaultPubkey);
        const depositorAddress = getVaultDepositorAddressSync(vaultProgramId, vaultPubkey, authority);
        const depositor = await fetchDepositorIfExists(vaultClient, depositorAddress);
        const slot = await connection.getSlot(DRIFT_CLIENT_COMMITMENT);
        return withdrawStatusFromDepositor(vault, depositor, vaultPubkey, walletAddress, slot);
      });
    },

    async buildVaultDepositTransaction(connection, input) {
      const vaultPubkey = new PublicKey(input.vaultAddress);
      const authority = new PublicKey(input.walletAddress);
      const programId = await resolveVaultProgramId(connection, vaultPubkey);
      return withVaultSdk(connection, input.walletAddress, programId, async ({ vaultClient, vaultProgramId }) => {
        const vault = await vaultClient.getVault(vaultPubkey);
        const depositorAddress = getVaultDepositorAddressSync(vaultProgramId, vaultPubkey, authority);
        const depositor = await fetchDepositorIfExists(vaultClient, depositorAddress);
        if (!depositor && input.initializeDepositorIfMissing !== true) {
          throw new Error(`No Drift vault depositor account found for ${input.walletAddress} in ${input.vaultAddress}.`);
        }
        const tx = await vaultClient.createDepositTx(
          depositorAddress,
          new BN(input.amountRaw.toString()),
          depositor ? undefined : { authority, vault: vaultPubkey },
          { noLut: true, cuLimit: 600_000 },
        );
        const slot = await connection.getSlot(DRIFT_CLIENT_COMMITMENT);
        const snapshot = await snapshotFromVault(vaultClient, vault, vaultPubkey, vaultProgramId, slot);
        return {
          transactionBase64: versionedTransactionToBase64(tx),
          vaultAddress: input.vaultAddress,
          vaultName: snapshot.name,
          depositMint: snapshot.depositMint,
          ...(snapshot.depositSymbol ? { depositSymbol: snapshot.depositSymbol } : {}),
          decimals: snapshot.decimals,
          amountUi: rawToUi(input.amountRaw, snapshot.decimals),
          initializedDepositor: !depositor,
          summarySnapshot: snapshot,
        } satisfies DriftBuildVaultDepositResult;
      });
    },

    async buildVaultRequestWithdrawTransaction(connection, input) {
      const { vaultClient, vaultProgramId, vaultPubkey, depositorAddress, vault } =
        await vaultActionContext(connection, input.walletAddress, input.vaultAddress);
      try {
        const amount = withdrawAmount(input);
        const withdrawUnit = sdkWithdrawUnit(input.withdrawUnit);
        const ixs = await vaultClient.getRequestWithdrawIx(depositorAddress, amount, withdrawUnit);
        const tx = await vaultClient.createTxnNoLut(ixs, { noLut: true, cuLimit: 600_000 });
        const slot = await connection.getSlot(DRIFT_CLIENT_COMMITMENT);
        const snapshot = await snapshotFromVault(vaultClient, vault, vaultPubkey, vaultProgramId, slot);
        return {
          transactionBase64: versionedTransactionToBase64(tx),
          vaultAddress: input.vaultAddress,
          vaultName: snapshot.name,
          depositMint: snapshot.depositMint,
          ...(snapshot.depositSymbol ? { depositSymbol: snapshot.depositSymbol } : {}),
          decimals: snapshot.decimals,
          ...(input.amountRaw !== undefined ? { amountUi: rawToUi(input.amountRaw, snapshot.decimals) } : {}),
          ...(input.sharesRaw !== undefined ? { sharesUi: rawToUi(input.sharesRaw, vault.sharesBase) } : {}),
          redeemableAt: Math.floor(Date.now() / 1000) + snapshot.redeemPeriodSec,
          summarySnapshot: snapshot,
        } satisfies DriftBuildVaultRequestWithdrawResult;
      } finally {
        await vaultClient.driftClient.unsubscribe();
        await vaultClient.unsubscribe();
      }
    },

    async buildVaultCancelWithdrawTransaction(connection, input) {
      const { vaultClient, vaultProgramId, vaultPubkey, depositorAddress, vault } =
        await vaultActionContext(connection, input.walletAddress, input.vaultAddress);
      try {
        const depositor = await fetchDepositorIfExists(vaultClient, depositorAddress);
        const ixs = await vaultClient.getCancelRequestWithdrawIx(depositorAddress, undefined);
        const tx = await vaultClient.createTxnNoLut(ixs, { noLut: true, cuLimit: 600_000 });
        const slot = await connection.getSlot(DRIFT_CLIENT_COMMITMENT);
        const snapshot = await snapshotFromVault(vaultClient, vault, vaultPubkey, vaultProgramId, slot);
        return {
          transactionBase64: versionedTransactionToBase64(tx),
          vaultAddress: input.vaultAddress,
          vaultName: snapshot.name,
          ...(depositor ? { cancelledShares: rawToUi(depositor.lastWithdrawRequest.shares, vault.sharesBase) } : {}),
          summarySnapshot: snapshot,
        } satisfies DriftBuildVaultCancelWithdrawResult;
      } finally {
        await vaultClient.driftClient.unsubscribe();
        await vaultClient.unsubscribe();
      }
    },

    async buildVaultCompleteWithdrawTransaction(connection, input) {
      const { vaultClient, vaultProgramId, vaultPubkey, depositorAddress, vault } =
        await vaultActionContext(connection, input.walletAddress, input.vaultAddress);
      try {
        const depositor = await fetchDepositorIfExists(vaultClient, depositorAddress);
        const ixs = await vaultClient.getWithdrawIx(depositorAddress);
        const tx = await vaultClient.createTxnNoLut(ixs, { noLut: true, cuLimit: 600_000 });
        const slot = await connection.getSlot(DRIFT_CLIENT_COMMITMENT);
        const snapshot = await snapshotFromVault(vaultClient, vault, vaultPubkey, vaultProgramId, slot);
        return {
          transactionBase64: versionedTransactionToBase64(tx),
          vaultAddress: input.vaultAddress,
          vaultName: snapshot.name,
          ...(depositor ? { redeemedShares: rawToUi(depositor.lastWithdrawRequest.shares, vault.sharesBase) } : {}),
          ...(depositor ? { redeemedAmountUi: rawToUi(depositor.lastWithdrawRequest.value, snapshot.decimals) } : {}),
          summarySnapshot: snapshot,
        } satisfies DriftBuildVaultCompleteWithdrawResult;
      } finally {
        await vaultClient.driftClient.unsubscribe();
        await vaultClient.unsubscribe();
      }
    },
  };
}

async function withVaultSdk<T>(
  connection: Connection,
  walletAddress: string,
  vaultProgramId: PublicKey,
  fn: (ctx: VaultSdkContext) => Promise<T>,
): Promise<T> {
  const wallet = new ReadOnlyWallet(new PublicKey(walletAddress));
  const accountLoader = new BulkAccountLoader(connection, DRIFT_CLIENT_COMMITMENT, DRIFT_CLIENT_POLL_INTERVAL_MS);
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    programID: DRIFT_PROGRAM_ID,
    opts: {
      commitment: DRIFT_CLIENT_COMMITMENT,
      preflightCommitment: DRIFT_CLIENT_COMMITMENT,
      skipPreflight: false,
    },
    accountSubscription: {
      type: 'polling',
      accountLoader,
    },
    txVersion: 0,
  });
  await driftClient.subscribe();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: DRIFT_CLIENT_COMMITMENT,
    preflightCommitment: DRIFT_CLIENT_COMMITMENT,
  });
  const program = driftVaultProgram(vaultProgramId, provider);
  const vaultClient = new VaultClient({ driftClient, program: program as never });
  try {
    return await fn({ driftClient, vaultClient, vaultProgramId });
  } finally {
    await vaultClient.unsubscribe();
    await driftClient.unsubscribe();
  }
}

async function vaultActionContext(
  connection: Connection,
  walletAddress: string,
  vaultAddress: string,
): Promise<VaultSdkContext & { vaultPubkey: PublicKey; depositorAddress: PublicKey; vault: Vault }> {
  const vaultPubkey = new PublicKey(vaultAddress);
  const authority = new PublicKey(walletAddress);
  const vaultProgramId = await resolveVaultProgramId(connection, vaultPubkey);
  const wallet = new ReadOnlyWallet(authority);
  const accountLoader = new BulkAccountLoader(connection, DRIFT_CLIENT_COMMITMENT, DRIFT_CLIENT_POLL_INTERVAL_MS);
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    programID: DRIFT_PROGRAM_ID,
    opts: {
      commitment: DRIFT_CLIENT_COMMITMENT,
      preflightCommitment: DRIFT_CLIENT_COMMITMENT,
      skipPreflight: false,
    },
    accountSubscription: { type: 'polling', accountLoader },
    txVersion: 0,
  });
  await driftClient.subscribe();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: DRIFT_CLIENT_COMMITMENT,
    preflightCommitment: DRIFT_CLIENT_COMMITMENT,
  });
  const program = driftVaultProgram(vaultProgramId, provider);
  const vaultClient = new VaultClient({ driftClient, program: program as never });
  const vault = await vaultClient.getVault(vaultPubkey);
  const depositorAddress = getVaultDepositorAddressSync(vaultProgramId, vaultPubkey, authority);
  return { driftClient, vaultClient, vaultProgramId, vaultPubkey, depositorAddress, vault };
}

async function resolveVaultProgramId(connection: Connection, vault: PublicKey): Promise<PublicKey> {
  const account = await connection.getAccountInfo(vault, DRIFT_CLIENT_COMMITMENT);
  if (!account) throw new Error(`Drift vault account ${vault.toBase58()} was not found.`);
  const match = DRIFT_VAULTS_PROGRAM_IDS.find((programId) => programId.equals(account.owner));
  if (!match) {
    throw new Error(
      `Drift vault ${vault.toBase58()} is owned by ${account.owner.toBase58()}, not a known Drift Vaults program.`,
    );
  }
  return match;
}

async function snapshotFromVault(
  vaultClient: VaultClient,
  vault: Vault,
  vaultPubkey: PublicKey,
  vaultProgramId: PublicKey,
  slot: number,
): Promise<DriftVaultSnapshot> {
  const spotMarket = vaultClient.driftClient.getSpotMarketAccount(vault.spotMarketIndex);
  if (!spotMarket) throw new Error(`Drift spot market ${vault.spotMarketIndex} was not loaded.`);
  const catalog = await catalogEntry(vaultPubkey.toBase58());
  const totalValueRaw = await safeBn(
    () => vaultClient.calculateVaultEquityInDepositAsset({ vault }),
    vault.totalDeposits,
  );
  const sharePrice = await safeString(
    async () => String(await vaultClient.calcVaultSharePrice({ vault })),
    '0',
  );
  return {
    vaultAddress: vaultPubkey.toBase58(),
    name: catalog?.name ?? decodeVaultName(vault),
    manager: catalog?.managerName ?? vault.manager.toBase58(),
    programId: vaultProgramId.toBase58(),
    depositMint: spotMarket.mint.toBase58(),
    ...(catalog?.depositSymbol ? { depositSymbol: catalog.depositSymbol } : {}),
    decimals: spotMarket.decimals,
    totalShares: rawToUi(vault.totalShares, vault.sharesBase),
    totalValue: rawToUi(totalValueRaw, spotMarket.decimals),
    sharePrice,
    redeemPeriodSec: bnToNumber(vault.redeemPeriod),
    lockupSec: 0,
    profitShareBps: vault.profitShare,
    managementFeeBps: bnToNumber(vault.managementFee),
    hurdleRateBps: vault.hurdleRate,
    minDepositAmount: rawToUi(vault.minDepositAmount, spotMarket.decimals),
    pendingWithdrawShares: rawToUi(vault.totalWithdrawRequested, vault.sharesBase),
    asOfSlot: slot,
  };
}

async function positionFromDepositor(
  vaultClient: VaultClient,
  depositor: VaultDepositor,
  vault: Vault,
  depositorAddress: PublicKey,
  walletAddress: string,
  slot: number,
): Promise<DriftVaultDepositor> {
  const spotMarket = vaultClient.driftClient.getSpotMarketAccount(vault.spotMarketIndex);
  const decimals = spotMarket?.decimals ?? 6;
  const equityRaw = await safeBn(
    () => vaultClient.calculateWithdrawableVaultDepositorEquityInDepositAsset({
      vault,
      vaultDepositor: depositor,
    }),
    new BN(0),
  );
  const pending = depositor.lastWithdrawRequest.shares;
  const requestedAt = bnToNumber(depositor.lastWithdrawRequest.ts);
  const redeemPeriod = bnToNumber(vault.redeemPeriod);
  return {
    vaultAddress: depositor.vault.toBase58(),
    walletAddress,
    depositorAddress: depositorAddress.toBase58(),
    shares: rawToUi(depositor.vaultShares, depositor.vaultSharesBase),
    valueAtSharePrice: rawToUi(equityRaw, decimals),
    pendingWithdrawShares: rawToUi(pending, depositor.vaultSharesBase),
    ...(requestedAt > 0 ? { pendingWithdrawRequestedAt: requestedAt } : {}),
    ...(requestedAt > 0 ? { redeemableAt: requestedAt + redeemPeriod } : {}),
    asOfSlot: slot,
  };
}

function withdrawStatusFromDepositor(
  vault: Vault,
  depositor: VaultDepositor | undefined,
  vaultPubkey: PublicKey,
  walletAddress: string,
  slot: number,
): DriftWithdrawStatus {
  const redeemPeriodSec = bnToNumber(vault.redeemPeriod);
  if (!depositor) {
    return {
      vaultAddress: vaultPubkey.toBase58(),
      walletAddress,
      hasPendingRequest: false,
      requestedShares: '0',
      isReady: false,
      redeemPeriodSec,
      lockupSec: 0,
      asOfSlot: slot,
    };
  }
  const requestedAt = bnToNumber(depositor.lastWithdrawRequest.ts);
  const redeemableAt = requestedAt > 0 ? requestedAt + redeemPeriodSec : undefined;
  const now = Math.floor(Date.now() / 1000);
  const hasPendingRequest = depositor.lastWithdrawRequest.shares.gt(new BN(0));
  return {
    vaultAddress: vaultPubkey.toBase58(),
    walletAddress,
    hasPendingRequest,
    requestedShares: rawToUi(depositor.lastWithdrawRequest.shares, depositor.vaultSharesBase),
    requestedValue: depositor.lastWithdrawRequest.value.toString(),
    ...(requestedAt > 0 ? { requestedAt } : {}),
    ...(redeemableAt !== undefined ? { redeemableAt } : {}),
    isReady: hasPendingRequest && redeemableAt !== undefined && now >= redeemableAt,
    redeemPeriodSec,
    lockupSec: 0,
    asOfSlot: slot,
  };
}

async function fetchDepositorIfExists(
  vaultClient: VaultClient,
  depositorAddress: PublicKey,
): Promise<VaultDepositor | undefined> {
  try {
    return await vaultClient.getVaultDepositor(depositorAddress) as VaultDepositor;
  } catch (err) {
    if (isAccountMissingError(err)) return undefined;
    throw err;
  }
}

function withdrawAmount(input: DriftBuildVaultRequestWithdrawInput): BN {
  const value = input.withdrawUnit === 'shares' ? input.sharesRaw : input.amountRaw;
  if (value === undefined) {
    throw new Error(`Drift ${input.withdrawUnit} withdraw requires an amount.`);
  }
  return new BN(value.toString());
}

function driftVaultProgram(vaultProgramId: PublicKey, provider: anchor.AnchorProvider): anchor.Program {
  const baseIdl = { ...IDL, address: vaultProgramId.toBase58() };
  const idl = convertLegacyAnchorIdl(baseIdl) as unknown as anchor.Idl;
  return new anchor.Program(idl, provider);
}

type SdkWithdrawUnitValue = typeof SdkWithdrawUnit.TOKEN | typeof SdkWithdrawUnit.SHARES;

function sdkWithdrawUnit(unit: DriftWithdrawUnit): SdkWithdrawUnitValue {
  return unit === 'shares'
    ? SdkWithdrawUnit.SHARES
    : SdkWithdrawUnit.TOKEN;
}

function versionedTransactionToBase64(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString('base64');
}

function rawToUi(value: BN | bigint, decimals: number): string {
  const raw = BigInt(value.toString());
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

function bnToNumber(value: BN): number {
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeVaultName(vault: Vault): string {
  try {
    const decoded = decodeName(vault.name);
    return decoded.trim() || vault.pubkey.toBase58();
  } catch {
    return vault.pubkey.toBase58();
  }
}

async function catalogEntry(vaultAddress: string): Promise<DriftVaultCatalogEntry | undefined> {
  const now = Date.now();
  if (!catalogCache || now - catalogCache.loadedAt > CATALOG_TTL_MS) {
    try {
      catalogCache = { entries: await fetchDriftVaultCatalog(), loadedAt: now };
    } catch {
      catalogCache = { entries: [], loadedAt: now };
    }
  }
  return catalogCache.entries.find((entry) => entry.vaultAddress === vaultAddress);
}

async function safeBn(fn: () => Promise<BN>, fallback: BN): Promise<BN> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function safeString(fn: () => Promise<string>, fallback: string): Promise<string> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function isAccountMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return message.includes('account does not exist') ||
    message.includes('account not found') ||
    message.includes('could not find') ||
    message.includes('failed to find account');
}

class ReadOnlyWallet implements IWallet {
  constructor(readonly publicKey: PublicKey) {}

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    return transaction;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
    return transactions;
  }

  async signVersionedTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction> {
    return transaction;
  }

  async signAllVersionedTransactions(transactions: VersionedTransaction[]): Promise<VersionedTransaction[]> {
    return transactions;
  }
}
