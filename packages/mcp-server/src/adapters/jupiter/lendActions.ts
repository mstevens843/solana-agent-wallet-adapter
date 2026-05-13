import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { parseDecimalAmount } from '../../amounts.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction, PreparedActionKind } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
  DAppAdapterContext,
} from '../types.js';
import { AdapterError } from '../types.js';

import {
  JUPITER_ADAPTER_ID,
  JUPITER_LEND_BORROW_PROGRAM_IDS_BASE58,
  JUPITER_LEND_EARN_PROGRAM_IDS_BASE58,
  type JupiterLendBorrowOperation,
  type JupiterLendEarnOperation,
} from './constants.js';
import {
  assertBorrowHealthPreviewAllowed,
  assertOracleFresh,
  configuredMaxLtvBps,
  configuredMinHealthRatio,
  getBorrowPositions,
  getBorrowVaultDetail,
  previewBorrowHealth,
} from './lendBorrow.js';
import { getEarnTokenDetail } from './lendEarn.js';
import {
  getJupiterLendClient,
  type JupiterLendBorrowPositionSnapshot,
  type JupiterLendBorrowVaultSnapshot,
  type JupiterLendBuildResult,
  type JupiterLendEarnTokenSnapshot,
} from './lendClient.js';

export interface JupiterLendEarnActionInput {
  assetMint: string;
  amount?: string;
  shares?: string;
  minSharesOut?: string;
  minUnderlyingOut?: string;
  dueAt?: string;
  note?: string;
}

export interface JupiterLendBorrowActionInput {
  vaultId: number;
  positionId?: number;
  collateralAmount?: string;
  borrowAmount?: string;
  amount?: string;
  minHealthRatio?: number;
  maxLtvBps?: number;
  repayAll?: boolean;
  dueAt?: string;
  note?: string;
}

export function earnDepositAction(): AdapterAction<JupiterLendEarnActionInput> {
  return buildEarnAction('earn_deposit', {
    kind: 'jupiter_lend_earn_deposit',
    summarize: (token, amount) => `Deposit ${amount} ${earnLabel(token)} into Jupiter Earn`,
    requireAmount: true,
    refreshAtExecution: false,
    build: async (client, { token, args, input }) => {
      assertAmount(input.amount, 'Jupiter Earn deposit');
      return client.buildEarnDeposit({
        ...args,
        assetMint: token.assetMint,
        amount: input.amount as string,
        amountRaw: rawAmount(input.amount as string, token.decimals),
        ...(input.minSharesOut !== undefined ? { minSharesOut: input.minSharesOut } : {}),
      });
    },
  });
}

export function earnWithdrawAction(): AdapterAction<JupiterLendEarnActionInput> {
  return buildEarnAction('earn_withdraw', {
    kind: 'jupiter_lend_earn_withdraw',
    summarize: (token, amount) => `Withdraw ${amount} ${earnLabel(token)} from Jupiter Earn`,
    requireAmount: true,
    refreshAtExecution: true,
    build: async (client, { token, args, input }) => {
      assertAmount(input.amount, 'Jupiter Earn withdraw');
      return client.buildEarnWithdraw({
        ...args,
        assetMint: token.assetMint,
        amount: input.amount as string,
        amountRaw: rawAmount(input.amount as string, token.decimals),
        ...(input.minUnderlyingOut !== undefined ? { minUnderlyingOut: input.minUnderlyingOut } : {}),
      });
    },
  });
}

export function earnMintAction(): AdapterAction<JupiterLendEarnActionInput> {
  return buildEarnAction('earn_mint', {
    kind: 'jupiter_lend_earn_mint',
    summarize: (token, _amount, shares) => `Mint ${shares} ${earnLabel(token)} shares on Jupiter Earn`,
    requireShares: true,
    refreshAtExecution: false,
    build: async (client, { token, args, input }) => {
      assertAmount(input.shares, 'Jupiter Earn mint');
      return client.buildEarnMint({
        ...args,
        assetMint: token.assetMint,
        shares: input.shares as string,
        sharesRaw: rawAmount(input.shares as string, token.shareDecimals),
      });
    },
  });
}

export function earnRedeemAction(): AdapterAction<JupiterLendEarnActionInput> {
  return buildEarnAction('earn_redeem', {
    kind: 'jupiter_lend_earn_redeem',
    summarize: (token, _amount, shares) => `Redeem ${shares} ${earnLabel(token)} shares on Jupiter Earn`,
    requireShares: true,
    refreshAtExecution: true,
    build: async (client, { token, args, input }) => {
      assertAmount(input.shares, 'Jupiter Earn redeem');
      return client.buildEarnRedeem({
        ...args,
        assetMint: token.assetMint,
        shares: input.shares as string,
        sharesRaw: rawAmount(input.shares as string, token.shareDecimals),
        ...(input.minUnderlyingOut !== undefined ? { minUnderlyingOut: input.minUnderlyingOut } : {}),
      });
    },
  });
}

export function borrowCreatePositionAction(): AdapterAction<JupiterLendBorrowActionInput> {
  return buildBorrowAction('borrow_create_position', {
    kind: 'jupiter_lend_borrow_create_position',
    summarize: (vault) => `Open Jupiter Borrow position on ${vaultLabel(vault)}`,
    healthGated: true,
    refreshAtExecution: true,
    build: async (client, { vault, args, input, minHealthRatio }) => {
      return client.buildBorrowCreatePosition({
        ...args,
        vaultId: vault.vaultId,
        ...(input.collateralAmount !== undefined
          ? {
              collateralAmount: input.collateralAmount,
              collateralAmountRaw: rawAmount(input.collateralAmount, vault.supplyDecimals),
            }
          : {}),
        ...(input.borrowAmount !== undefined
          ? {
              borrowAmount: input.borrowAmount,
              borrowAmountRaw: rawAmount(input.borrowAmount, vault.borrowDecimals),
            }
          : {}),
      });
    },
    extraPreview: (input) => ({
      ...(input.collateralAmount !== undefined ? { collateralAmount: input.collateralAmount } : {}),
      ...(input.borrowAmount !== undefined ? { borrowAmount: input.borrowAmount } : {}),
    }),
  });
}

export function borrowDepositCollateralAction(): AdapterAction<JupiterLendBorrowActionInput> {
  return buildBorrowAction('borrow_deposit_collateral', {
    kind: 'jupiter_lend_borrow_deposit_collateral',
    summarize: (vault, amount) => `Deposit ${amount} ${vault.supplySymbol ?? shortMint(vault.supplyMint)} collateral on Jupiter Borrow`,
    requireAmount: true,
    requirePositionId: true,
    healthGated: false,
    refreshAtExecution: false,
    build: async (client, { vault, args, input }) => {
      assertAmount(input.amount, 'Jupiter Borrow deposit collateral');
      assertPositionId(input.positionId);
      return client.buildBorrowDepositCollateral({
        ...args,
        vaultId: vault.vaultId,
        positionId: input.positionId as number,
        amount: input.amount as string,
        amountRaw: rawAmount(input.amount as string, vault.supplyDecimals),
      });
    },
  });
}

export function borrowBorrowAction(): AdapterAction<JupiterLendBorrowActionInput> {
  return buildBorrowAction('borrow_borrow', {
    kind: 'jupiter_lend_borrow_borrow',
    summarize: (vault, amount) => `Borrow ${amount} ${vault.borrowSymbol ?? shortMint(vault.borrowMint)} from Jupiter Borrow`,
    requireAmount: true,
    requirePositionId: true,
    healthGated: true,
    refreshAtExecution: true,
    build: async (client, { vault, args, input, minHealthRatio }) => {
      assertAmount(input.amount, 'Jupiter Borrow borrow');
      assertPositionId(input.positionId);
      return client.buildBorrowBorrow({
        ...args,
        vaultId: vault.vaultId,
        positionId: input.positionId as number,
        amount: input.amount as string,
        amountRaw: rawAmount(input.amount as string, vault.borrowDecimals),
        minHealthRatio,
      });
    },
  });
}

export function borrowRepayAction(): AdapterAction<JupiterLendBorrowActionInput> {
  return buildBorrowAction('borrow_repay', {
    kind: 'jupiter_lend_borrow_repay',
    summarize: (vault, amount, _shares, repayAll) =>
      repayAll
        ? `Repay all ${vault.borrowSymbol ?? shortMint(vault.borrowMint)} debt on Jupiter Borrow`
        : `Repay ${amount} ${vault.borrowSymbol ?? shortMint(vault.borrowMint)} on Jupiter Borrow`,
    requirePositionId: true,
    healthGated: false,
    refreshAtExecution: false,
    build: async (client, { vault, args, input }) => {
      if (!input.repayAll) assertAmount(input.amount, 'Jupiter Borrow repay');
      assertPositionId(input.positionId);
      return client.buildBorrowRepay({
        ...args,
        vaultId: vault.vaultId,
        positionId: input.positionId as number,
        amount: input.amount ?? '0',
        amountRaw: input.amount ? rawAmount(input.amount, vault.borrowDecimals) : '0',
        ...(input.repayAll ? { repayAll: true } : {}),
      });
    },
    extraPreview: (input) => ({
      ...(input.repayAll ? { repayAll: true } : {}),
    }),
  });
}

export function borrowWithdrawCollateralAction(): AdapterAction<JupiterLendBorrowActionInput> {
  return buildBorrowAction('borrow_withdraw_collateral', {
    kind: 'jupiter_lend_borrow_withdraw_collateral',
    summarize: (vault, amount) =>
      `Withdraw ${amount} ${vault.supplySymbol ?? shortMint(vault.supplyMint)} collateral from Jupiter Borrow`,
    requireAmount: true,
    requirePositionId: true,
    healthGated: true,
    refreshAtExecution: true,
    build: async (client, { vault, args, input, minHealthRatio }) => {
      assertAmount(input.amount, 'Jupiter Borrow withdraw collateral');
      assertPositionId(input.positionId);
      return client.buildBorrowWithdrawCollateral({
        ...args,
        vaultId: vault.vaultId,
        positionId: input.positionId as number,
        amount: input.amount as string,
        amountRaw: rawAmount(input.amount as string, vault.supplyDecimals),
        minHealthRatio,
      });
    },
  });
}

interface EarnActionConfig {
  kind: PreparedActionKind;
  summarize: (
    token: JupiterLendEarnTokenSnapshot,
    amount: string | undefined,
    shares?: string | undefined,
  ) => string;
  requireAmount?: boolean;
  requireShares?: boolean;
  refreshAtExecution: boolean;
  build: (
    client: Awaited<ReturnType<typeof getJupiterLendClient>>,
    ctx: {
      token: JupiterLendEarnTokenSnapshot;
      args: { walletAddress: string; cluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet' };
      input: JupiterLendEarnActionInput;
    },
  ) => Promise<JupiterLendBuildResult>;
}

function buildEarnAction(
  operation: JupiterLendEarnOperation,
  config: EarnActionConfig,
): AdapterAction<JupiterLendEarnActionInput> {
  return {
    id: operation,
    kind: config.kind,
    async prepare(input, ctx): Promise<AdapterPrepareResult> {
      const walletAddress = await ctx.backend.getAddress();
      if (!input.assetMint?.trim()) {
        throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `${operation} requires assetMint.`);
      }
      const token = await getEarnTokenDetail(ctx.config, walletAddress, input.assetMint);
      if (config.requireAmount && !input.amount?.trim()) {
        throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `${operation} requires amount.`);
      }
      if (config.requireShares && !input.shares?.trim()) {
        throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `${operation} requires shares.`);
      }
      if (input.amount?.trim()) {
        parseDecimalAmount(input.amount, token.decimals, `Jupiter Earn ${operation} amount`);
      }
      if (input.shares?.trim()) {
        parseDecimalAmount(input.shares, token.shareDecimals, `Jupiter Earn ${operation} shares`);
      }
      const summary = config.summarize(token, input.amount, input.shares);
      const warnings = collectEarnWarnings(operation, token);
      const params: Record<string, unknown> = {
        adapter: JUPITER_ADAPTER_ID,
        connectorId: JUPITER_ADAPTER_ID,
        product: 'lend',
        operation,
        approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
        walletAddress,
        cluster: ctx.config.cluster,
        assetMint: token.assetMint,
        shareMint: token.shareMint,
        ...(token.tokenSymbol ? { tokenSymbol: token.tokenSymbol } : {}),
        decimals: token.decimals,
        shareDecimals: token.shareDecimals,
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.amount !== undefined ? { amountRaw: rawAmount(input.amount, token.decimals) } : {}),
        ...(input.shares !== undefined ? { shares: input.shares } : {}),
        ...(input.shares !== undefined ? { sharesRaw: rawAmount(input.shares, token.shareDecimals) } : {}),
        ...(input.minSharesOut !== undefined ? { minSharesOut: input.minSharesOut } : {}),
        ...(input.minUnderlyingOut !== undefined ? { minUnderlyingOut: input.minUnderlyingOut } : {}),
        earnSnapshot: token,
        programIds: JUPITER_LEND_EARN_PROGRAM_IDS_BASE58,
        refreshAtExecution: config.refreshAtExecution,
        preparedSnapshotAt: new Date().toISOString(),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      return {
        addInput: {
          kind: config.kind,
          walletAddress,
          cluster: ctx.config.cluster,
          summary,
          params,
          ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
          ...(input.note !== undefined && { note: input.note }),
        },
        preview: params,
      };
    },
    async execute(action: PreparedAction, ctx: DAppAdapterContext): Promise<AdapterExecuteResult> {
      const walletAddress = await ctx.backend.getAddress();
      assertOwnership(action, walletAddress);
      const client = await getJupiterLendClient(walletAddress, ctx.config);
      const token = await getEarnTokenDetail(ctx.config, walletAddress, requireParam(action, 'assetMint'));
      const refreshed = await config.build(client, {
        token,
        args: {
          walletAddress,
          cluster: ctx.config.cluster,
        },
        input: {
          assetMint: token.assetMint,
          ...(typeof action.params.amount === 'string' ? { amount: action.params.amount } : {}),
          ...(typeof action.params.shares === 'string' ? { shares: action.params.shares } : {}),
          ...(typeof action.params.minSharesOut === 'string' ? { minSharesOut: action.params.minSharesOut } : {}),
          ...(typeof action.params.minUnderlyingOut === 'string'
            ? { minUnderlyingOut: action.params.minUnderlyingOut }
            : {}),
        },
      });
      const summary = config.summarize(token, typeof action.params.amount === 'string' ? action.params.amount : undefined,
        typeof action.params.shares === 'string' ? action.params.shares : undefined);
      const txid = await ctx.signAndBroadcast(refreshed.transactionBase64, summary);
      return {
        txid,
        signedAt: new Date().toISOString(),
        preview: {
          assetMint: token.assetMint,
          ...(action.params.amount !== undefined ? { amount: action.params.amount } : {}),
          ...(action.params.shares !== undefined ? { shares: action.params.shares } : {}),
          ...(refreshed.notes && refreshed.notes.length > 0 ? { notes: refreshed.notes } : {}),
        },
      };
    },
  };
}

interface BorrowActionConfig {
  kind: PreparedActionKind;
  summarize: (
    vault: JupiterLendBorrowVaultSnapshot,
    amount: string | undefined,
    shares?: string | undefined,
    repayAll?: boolean,
  ) => string;
  requireAmount?: boolean;
  requirePositionId?: boolean;
  healthGated: boolean;
  refreshAtExecution: boolean;
  build: (
    client: Awaited<ReturnType<typeof getJupiterLendClient>>,
    ctx: {
      vault: JupiterLendBorrowVaultSnapshot;
      args: { walletAddress: string; cluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet' };
      input: JupiterLendBorrowActionInput;
      minHealthRatio: number;
    },
  ) => Promise<JupiterLendBuildResult>;
  extraPreview?: (input: JupiterLendBorrowActionInput) => Record<string, unknown>;
}

function buildBorrowAction(
  operation: JupiterLendBorrowOperation,
  config: BorrowActionConfig,
): AdapterAction<JupiterLendBorrowActionInput> {
  return {
    id: operation,
    kind: config.kind,
    async prepare(input, ctx): Promise<AdapterPrepareResult> {
      const walletAddress = await ctx.backend.getAddress();
      if (!Number.isFinite(input.vaultId)) {
        throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `${operation} requires vaultId.`);
      }
      if (config.requirePositionId && !Number.isFinite(input.positionId)) {
        throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `${operation} requires positionId.`);
      }
      const vault = await getBorrowVaultDetail(ctx.config, walletAddress, input.vaultId);
      if (oracleGatedOperation(operation)) {
        assertOracleFresh(vault.oracle, `Jupiter Borrow ${operation}`);
      }
      const positionSnapshot = await fetchPositionSnapshotIfNeeded(ctx, walletAddress, input);
      if (positionSnapshot) {
        assertPositionOwnership(positionSnapshot, walletAddress);
      }
      const minHealthRatio = input.minHealthRatio ?? configuredMinHealthRatio(ctx.config);
      const maxLtvBps = input.maxLtvBps ?? configuredMaxLtvBps(ctx.config);
      let healthPreview: Awaited<ReturnType<typeof previewBorrowHealth>> | undefined;
      if (config.healthGated) {
        const collateralDelta = collateralDeltaForPreview(operation, input);
        const debtDelta = debtDeltaForPreview(operation, input);
        healthPreview = await previewBorrowHealth(ctx.config, {
          walletAddress,
          vaultId: input.vaultId,
          ...(input.positionId !== undefined ? { positionId: input.positionId } : {}),
          ...(collateralDelta !== undefined ? { collateralDelta } : {}),
          ...(debtDelta !== undefined ? { debtDelta } : {}),
          minHealthRatio,
          ...(maxLtvBps !== undefined ? { maxLtvBps } : {}),
        });
        assertBorrowHealthPreviewAllowed(healthPreview);
      }
      const summary = config.summarize(vault, input.amount, undefined, input.repayAll);
      const params: Record<string, unknown> = {
        adapter: JUPITER_ADAPTER_ID,
        connectorId: JUPITER_ADAPTER_ID,
        product: 'lend',
        operation,
        approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
        walletAddress,
        cluster: ctx.config.cluster,
        vaultId: vault.vaultId,
        vaultAddress: vault.vaultAddress,
        supplyMint: vault.supplyMint,
        borrowMint: vault.borrowMint,
        supplyDecimals: vault.supplyDecimals,
        borrowDecimals: vault.borrowDecimals,
        ...(vault.supplySymbol ? { supplySymbol: vault.supplySymbol } : {}),
        ...(vault.borrowSymbol ? { borrowSymbol: vault.borrowSymbol } : {}),
        ...(input.positionId !== undefined ? { positionId: input.positionId } : {}),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.amount !== undefined && operation !== 'borrow_create_position'
          ? { amountRaw: amountRawForOperation(operation, input.amount, vault) }
          : {}),
        ...(healthPreview ? { healthPreview } : {}),
        ...(vault.oracle ? { oracleSnapshot: vault.oracle } : {}),
        ...(positionSnapshot ? { positionSnapshot } : {}),
        minHealthRatio,
        ...(maxLtvBps !== undefined ? { maxLtvBps } : {}),
        vaultSnapshot: vault,
        programIds: JUPITER_LEND_BORROW_PROGRAM_IDS_BASE58,
        refreshAtExecution: config.refreshAtExecution,
        preparedSnapshotAt: new Date().toISOString(),
        ...(config.extraPreview ? config.extraPreview(input) : {}),
      };
      return {
        addInput: {
          kind: config.kind,
          walletAddress,
          cluster: ctx.config.cluster,
          summary,
          params,
          ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
          ...(input.note !== undefined && { note: input.note }),
        },
        preview: params,
      };
    },
    async execute(action: PreparedAction, ctx: DAppAdapterContext): Promise<AdapterExecuteResult> {
      const walletAddress = await ctx.backend.getAddress();
      assertOwnership(action, walletAddress);
      const client = await getJupiterLendClient(walletAddress, ctx.config);
      const vaultIdValue = action.params.vaultId;
      if (typeof vaultIdValue !== 'number' || !Number.isFinite(vaultIdValue)) {
        throw new ProtocolError('invalid_request', `Jupiter Borrow ${operation} prepared action is missing vaultId.`);
      }
      const vault = await getBorrowVaultDetail(ctx.config, walletAddress, vaultIdValue);
      if (oracleGatedOperation(operation)) {
        assertOracleFresh(vault.oracle, `Jupiter Borrow ${operation}`);
      }
      const input = readBorrowInputFromAction(action);
      if (input.positionId !== undefined) {
        const refreshedPosition = await fetchPositionSnapshotIfNeeded(ctx, walletAddress, input);
        if (refreshedPosition) {
          assertPositionOwnership(refreshedPosition, walletAddress);
        }
      }
      const minHealthRatio = typeof action.params.minHealthRatio === 'number'
        ? action.params.minHealthRatio
        : configuredMinHealthRatio(ctx.config);
      if (config.healthGated) {
        const collateralDelta = collateralDeltaForPreview(operation, input);
        const debtDelta = debtDeltaForPreview(operation, input);
        const refreshedPreview = await previewBorrowHealth(ctx.config, {
          walletAddress,
          vaultId: vaultIdValue,
          ...(input.positionId !== undefined ? { positionId: input.positionId } : {}),
          ...(collateralDelta !== undefined ? { collateralDelta } : {}),
          ...(debtDelta !== undefined ? { debtDelta } : {}),
          minHealthRatio,
        });
        assertBorrowHealthPreviewAllowed(refreshedPreview);
      }
      const refreshed = await config.build(client, {
        vault,
        args: {
          walletAddress,
          cluster: ctx.config.cluster,
        },
        input,
        minHealthRatio,
      });
      const summary = config.summarize(vault, input.amount, undefined, input.repayAll);
      const txid = await ctx.signAndBroadcast(refreshed.transactionBase64, summary);
      return {
        txid,
        signedAt: new Date().toISOString(),
        preview: {
          vaultId: vault.vaultId,
          ...(input.positionId !== undefined ? { positionId: input.positionId } : {}),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(refreshed.notes && refreshed.notes.length > 0 ? { notes: refreshed.notes } : {}),
        },
      };
    },
  };
}

function collateralDeltaForPreview(
  operation: JupiterLendBorrowOperation,
  input: JupiterLendBorrowActionInput,
): string | undefined {
  if (operation === 'borrow_create_position') return input.collateralAmount;
  if (operation === 'borrow_deposit_collateral') return input.amount;
  if (operation === 'borrow_withdraw_collateral' && input.amount?.trim()) return `-${input.amount}`;
  return undefined;
}

function debtDeltaForPreview(
  operation: JupiterLendBorrowOperation,
  input: JupiterLendBorrowActionInput,
): string | undefined {
  if (operation === 'borrow_create_position') return input.borrowAmount;
  if (operation === 'borrow_borrow') return input.amount;
  if (operation === 'borrow_repay' && input.amount?.trim()) return `-${input.amount}`;
  return undefined;
}

function amountRawForOperation(
  operation: JupiterLendBorrowOperation,
  amount: string,
  vault: JupiterLendBorrowVaultSnapshot,
): string {
  switch (operation) {
    case 'borrow_deposit_collateral':
    case 'borrow_withdraw_collateral':
      return rawAmount(amount, vault.supplyDecimals);
    case 'borrow_borrow':
    case 'borrow_repay':
      return rawAmount(amount, vault.borrowDecimals);
    default:
      return rawAmount(amount, vault.supplyDecimals);
  }
}

function readBorrowInputFromAction(action: PreparedAction): JupiterLendBorrowActionInput {
  const input: JupiterLendBorrowActionInput = {
    vaultId: action.params.vaultId as number,
  };
  if (typeof action.params.positionId === 'number') input.positionId = action.params.positionId;
  if (typeof action.params.collateralAmount === 'string') input.collateralAmount = action.params.collateralAmount;
  if (typeof action.params.borrowAmount === 'string') input.borrowAmount = action.params.borrowAmount;
  if (typeof action.params.amount === 'string') input.amount = action.params.amount;
  if (typeof action.params.minHealthRatio === 'number') input.minHealthRatio = action.params.minHealthRatio;
  if (typeof action.params.maxLtvBps === 'number') input.maxLtvBps = action.params.maxLtvBps;
  if (action.params.repayAll === true) input.repayAll = true;
  return input;
}

function assertAmount(value: string | undefined, label: string): void {
  if (!value?.trim()) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `${label} requires an amount.`);
  }
}

function assertPositionId(value: number | undefined): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'positionId is required for this Jupiter Borrow action.');
  }
}

function assertOwnership(action: PreparedAction, walletAddress: string): void {
  if (action.walletAddress !== walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Jupiter Lend ${action.kind} belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
}

function assertPositionOwnership(
  position: JupiterLendBorrowPositionSnapshot,
  walletAddress: string,
): void {
  if (position.owner !== walletAddress) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'position_not_owned',
      `Jupiter Borrow position #${position.positionId} is owned by ${position.owner}, not ${walletAddress}.`,
    );
  }
}

async function fetchPositionSnapshotIfNeeded(
  ctx: DAppAdapterContext,
  walletAddress: string,
  input: { vaultId: number; positionId?: number },
): Promise<JupiterLendBorrowPositionSnapshot | undefined> {
  if (input.positionId === undefined) return undefined;
  const positions = await getBorrowPositions(ctx.config, {
    walletAddress,
    vaultId: input.vaultId,
    positionId: input.positionId,
  });
  const match = positions.find(
    (entry) => entry.vaultId === input.vaultId && entry.positionId === input.positionId,
  );
  if (!match) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'position_not_owned',
      `Jupiter Borrow position #${input.positionId} is not owned by ${walletAddress}.`,
    );
  }
  return match;
}

function oracleGatedOperation(operation: JupiterLendBorrowOperation): boolean {
  return operation === 'borrow_borrow' || operation === 'borrow_withdraw_collateral';
}

function collectEarnWarnings(
  operation: JupiterLendEarnOperation,
  token: JupiterLendEarnTokenSnapshot,
): string[] {
  const warnings: string[] = [];
  if (
    (operation === 'earn_withdraw' || operation === 'earn_redeem') &&
    token.withdrawalSmoothing?.enabled === true
  ) {
    warnings.push(
      token.withdrawalSmoothing.note ??
        'Jupiter Earn applies withdrawal smoothing on this market. The amount you receive may release over time.',
    );
  }
  return warnings;
}

function requireParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `Jupiter Lend prepared action is missing ${key}.`);
  }
  return value;
}

function earnLabel(token: JupiterLendEarnTokenSnapshot): string {
  return token.tokenSymbol ?? shortMint(token.assetMint);
}

function vaultLabel(vault: JupiterLendBorrowVaultSnapshot): string {
  const supply = vault.supplySymbol ?? shortMint(vault.supplyMint);
  const borrow = vault.borrowSymbol ?? shortMint(vault.borrowMint);
  return `${supply}/${borrow} vault`;
}

function shortMint(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}

function rawAmount(amount: string, decimals: number): string {
  const trimmed = amount.trim();
  const negative = trimmed.startsWith('-');
  const absolute = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fractional = ''] = absolute.split('.');
  const normalizedFractional = fractional.padEnd(decimals, '0').slice(0, decimals);
  const digits = `${whole}${normalizedFractional}`.replace(/^0+(?=\d)/, '');
  return `${negative ? '-' : ''}${digits || '0'}`;
}
