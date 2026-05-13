import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { parseDecimalAmount } from '../../amounts.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
} from '../types.js';
import { AdapterError } from '../types.js';
import {
  DEFAULT_MARGINFI_MIN_HEALTH_RATIO,
  MARGINFI_ADAPTER_ID,
} from './constants.js';
import {
  getMarginfiClient,
  type MarginfiActionBuildInput,
  type MarginfiHealthPreview,
  type MarginfiOperation,
} from './client.js';

export interface MarginfiActionInput {
  bankAddress?: string;
  bankMint?: string;
  token?: string;
  amount?: string;
  marginfiAccount?: string;
  withdrawAll?: boolean;
  repayAll?: boolean;
  createAccountIfMissing?: boolean;
  dueAt?: string;
  note?: string;
}

export function marginfiAction(operation: MarginfiOperation): AdapterAction<MarginfiActionInput> {
  return {
    id: operation,
    kind: `marginfi_${operation}` as AdapterAction<MarginfiActionInput>['kind'],

    async prepare(input, ctx): Promise<AdapterPrepareResult> {
      const walletAddress = await ctx.backend.getAddress();
      const client = await getMarginfiClient(walletAddress);
      const minHealthRatio = marginfiMinHealthRatio(ctx.config);
      const previewInput: MarginfiActionBuildInput & { minHealthRatio?: number; createAccountIfMissing?: boolean } = {
        operation,
        walletAddress,
        ...(input.bankAddress !== undefined && { bankAddress: input.bankAddress }),
        ...(input.bankMint !== undefined && { bankMint: input.bankMint }),
        ...(input.token !== undefined && { token: input.token }),
        ...(input.amount !== undefined && { amount: input.amount }),
        ...(input.marginfiAccount !== undefined && { marginfiAccount: input.marginfiAccount }),
        ...(input.withdrawAll !== undefined && { withdrawAll: input.withdrawAll }),
        ...(input.repayAll !== undefined && { repayAll: input.repayAll }),
        ...(input.createAccountIfMissing !== undefined && { createAccountIfMissing: input.createAccountIfMissing }),
        minHealthRatio,
      };

      const preview = await client.previewHealth(ctx.connection, previewInput);
      assertHealthPreviewAllowed(preview);
      const bankSnapshot = await client.getBankSnapshot(ctx.connection, previewInput);
      parseDecimalAmount(preview.amount, bankSnapshot.decimals, `MarginFi ${operation} amount`);
      const tokenLabel = preview.tokenSymbol ?? bankSnapshot.tokenSymbol ?? shortAddress(preview.bankMint);
      const summary = `${titleCase(operation)} ${preview.amount} ${tokenLabel} ${operation === 'deposit' || operation === 'repay' ? 'to' : 'from'} MarginFi`;
      const params: Record<string, unknown> = {
        adapter: MARGINFI_ADAPTER_ID,
        connectorId: MARGINFI_ADAPTER_ID,
        action: operation,
        operation,
        approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
        marginfiAccount: preview.marginfiAccount,
        bankAddress: preview.bankAddress,
        bankMint: preview.bankMint,
        ...(tokenLabel ? { tokenSymbol: tokenLabel } : {}),
        decimals: bankSnapshot.decimals,
        amount: preview.amount,
        amountRaw: preview.amountRaw,
        healthPreview: preview,
        bankSnapshot,
        minHealthRatio,
        refreshAtExecution: operation === 'borrow' || operation === 'withdraw',
        preparedSnapshotAt: new Date().toISOString(),
        ...(preview.withdrawAll ? { withdrawAll: true } : {}),
        ...(preview.repayAll ? { repayAll: true } : {}),
      };

      return {
        addInput: {
          kind: `marginfi_${operation}` as AdapterAction<MarginfiActionInput>['kind'],
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

    async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
      const walletAddress = await ctx.backend.getAddress();
      if (walletAddress !== action.walletAddress) {
        throw new ProtocolError(
          'unauthorized',
          `MarginFi ${operation} belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
        );
      }
      const client = await getMarginfiClient(walletAddress);
      const buildInput: MarginfiActionBuildInput = {
        operation,
        walletAddress,
        marginfiAccount: requireString(action, 'marginfiAccount'),
        bankAddress: requireString(action, 'bankAddress'),
        amount: requireString(action, 'amount'),
        ...(action.params.withdrawAll === true && { withdrawAll: true }),
        ...(action.params.repayAll === true && { repayAll: true }),
      };
      if (operation === 'borrow' || operation === 'withdraw') {
        const preview = await client.previewHealth(ctx.connection, {
          ...buildInput,
          minHealthRatio: marginfiMinHealthRatio(ctx.config),
        });
        assertHealthPreviewAllowed(preview);
      }
      const built = await client.buildActionTransaction(ctx.connection, buildInput);
      const tokenLabel = built.bankSnapshot.tokenSymbol ?? shortAddress(built.bankSnapshot.bankMint);
      const summary = `${titleCase(operation)} ${built.amount} ${tokenLabel} ${operation === 'deposit' || operation === 'repay' ? 'to' : 'from'} MarginFi`;
      const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
      return {
        txid,
        signedAt: new Date().toISOString(),
        preview: {
          marginfiAccount: built.marginfiAccount,
          bankAddress: built.bankSnapshot.bankAddress,
          bankMint: built.bankSnapshot.bankMint,
          amount: built.amount,
          amountRaw: built.amountRaw,
        },
      };
    },
  };
}

export function marginfiMinHealthRatio(config: { connectors?: { marginfi?: { minHealthRatio?: number } } }): number {
  const configured = config.connectors?.marginfi?.minHealthRatio;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MARGINFI_MIN_HEALTH_RATIO;
}

export function assertHealthPreviewAllowed(preview: MarginfiHealthPreview): void {
  if (!preview.blocked) return;
  const after = preview.after;
  const reason = preview.warnings.length
    ? preview.warnings.join(' ')
    : !after
      ? 'Health preview is unavailable.'
      : after.healthRatio !== null && after.healthRatio < preview.minHealthRatio
        ? `Projected health ratio ${after.healthRatioText} is below minimum ${preview.minHealthRatio}.`
        : 'Projected account health is unhealthy.';
  throw new AdapterError(MARGINFI_ADAPTER_ID, 'health_check_failed', reason);
}

function requireString(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `MarginFi action ${action.id} is missing ${key}.`);
  }
  return value;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function shortAddress(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}
