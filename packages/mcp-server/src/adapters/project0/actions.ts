import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
} from '../types.js';
import { AdapterError } from '../types.js';
import {
  DEFAULT_PROJECT0_MIN_HEALTH_RATIO,
  PROJECT0_ADAPTER_ID,
} from './constants.js';
import {
  getProject0Client,
  normalizeProject0ActionInput,
  type Project0ActionInput,
  type Project0ActionOperation,
  type Project0HealthPreview,
  type Project0Operation,
} from './client.js';

export interface Project0PrepareInput {
  bankAddress?: string;
  bankMint?: string;
  token?: string;
  amount?: string;
  project0Account?: string;
  accountIndex?: number;
  withdrawAll?: boolean;
  repayAll?: boolean;
  minHealthRatio?: number;
  dueAt?: string;
  note?: string;
}

export function project0Action(operation: Project0ActionOperation): AdapterAction<Project0PrepareInput> {
  return {
    id: operation,
    kind: `project0_${operation}` as AdapterAction<Project0PrepareInput>['kind'],

    async prepare(input, ctx): Promise<AdapterPrepareResult> {
      const walletAddress = await ctx.backend.getAddress();
      const client = getProject0Client(project0ApiBaseUrl(ctx.config));
      const minHealthRatio = input.minHealthRatio ?? project0MinHealthRatio(ctx.config);
      const previewInput = normalizeProject0ActionInput({
        operation,
        walletAddress,
        ...(input.bankAddress !== undefined && { bankAddress: input.bankAddress }),
        ...(input.bankMint !== undefined && { bankMint: input.bankMint }),
        ...(input.token !== undefined && { token: input.token }),
        ...(input.amount !== undefined && { amount: input.amount }),
        ...(input.project0Account !== undefined && { project0Account: input.project0Account }),
        ...(input.accountIndex !== undefined && { accountIndex: input.accountIndex }),
        ...(input.withdrawAll !== undefined && { withdrawAll: input.withdrawAll }),
        ...(input.repayAll !== undefined && { repayAll: input.repayAll }),
        minHealthRatio,
      } satisfies Project0ActionInput);
      const preview = await client.previewHealth(ctx.connection, previewInput);
      assertProject0HealthPreviewAllowed(preview);
      const summary = project0Summary(operation, preview);
      const params: Record<string, unknown> = {
        adapter: PROJECT0_ADAPTER_ID,
        connectorId: PROJECT0_ADAPTER_ID,
        action: operation,
        operation,
        approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
        minHealthRatio,
        healthPreview: preview,
        refreshAtExecution: operation === 'borrow' || operation === 'withdraw',
        preparedSnapshotAt: new Date().toISOString(),
        ...(preview.project0Account ? { project0Account: preview.project0Account } : {}),
        ...(preview.accountIndex !== undefined ? { accountIndex: preview.accountIndex } : {}),
        ...(preview.bankAddress ? { bankAddress: preview.bankAddress } : {}),
        ...(preview.bankMint ? { bankMint: preview.bankMint } : {}),
        ...(preview.tokenSymbol ? { tokenSymbol: preview.tokenSymbol } : {}),
        ...(preview.venue ? { venue: preview.venue } : {}),
        ...(preview.amount ? { amount: preview.amount } : {}),
        ...(preview.amountRaw ? { amountRaw: preview.amountRaw } : {}),
        ...(preview.withdrawAll ? { withdrawAll: true } : {}),
        ...(preview.repayAll ? { repayAll: true } : {}),
      };

      return {
        addInput: {
          kind: `project0_${operation}` as AdapterAction<Project0PrepareInput>['kind'],
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
          `Project 0 ${operation} belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
        );
      }
      const client = getProject0Client(project0ApiBaseUrl(ctx.config));
      const buildInput: Project0ActionInput = {
        operation,
        walletAddress,
        ...(stringParam(action, 'project0Account') ? { project0Account: stringParam(action, 'project0Account') } : {}),
        ...(numberParam(action, 'accountIndex') !== undefined ? { accountIndex: numberParam(action, 'accountIndex') } : {}),
        ...(stringParam(action, 'bankAddress') ? { bankAddress: stringParam(action, 'bankAddress') } : {}),
        ...(stringParam(action, 'bankMint') ? { bankMint: stringParam(action, 'bankMint') } : {}),
        ...(stringParam(action, 'amount') ? { amount: stringParam(action, 'amount') } : {}),
        ...(action.params.withdrawAll === true ? { withdrawAll: true } : {}),
        ...(action.params.repayAll === true ? { repayAll: true } : {}),
        minHealthRatio: project0MinHealthRatio(ctx.config),
      };
      if (operation === 'borrow' || operation === 'withdraw') {
        const preview = await client.previewHealth(ctx.connection, buildInput);
        assertProject0HealthPreviewAllowed(preview);
      }
      const built = await client.buildActionTransaction(ctx.connection, buildInput);
      const txids = ctx.signAndBroadcastMany
        ? await ctx.signAndBroadcastMany(built.transactionsBase64, action.summary)
        : [await ctx.signAndBroadcast(requireSingleTransaction(built.transactionsBase64, operation), action.summary)];
      return {
        ...(txids.length === 1 ? { txid: txids[0] } : { txids }),
        signedAt: new Date().toISOString(),
        preview: {
          ...(built.project0Account ? { project0Account: built.project0Account } : {}),
          ...(built.accountIndex !== undefined ? { accountIndex: built.accountIndex } : {}),
          ...(built.bank ? { bankAddress: built.bank.bankAddress, bankMint: built.bank.mint, tokenSymbol: built.bank.symbol } : {}),
          ...(built.amount ? { amount: built.amount } : {}),
          ...(built.amountRaw ? { amountRaw: built.amountRaw } : {}),
        },
      };
    },
  };
}

export function project0MinHealthRatio(config: { connectors?: { project0?: { minHealthRatio?: number } } }): number {
  const configured = config.connectors?.project0?.minHealthRatio;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_PROJECT0_MIN_HEALTH_RATIO;
}

export function project0ApiBaseUrl(config: { connectors?: { project0?: { apiBaseUrl?: string } } }): string | undefined {
  return config.connectors?.project0?.apiBaseUrl;
}

export function assertProject0HealthPreviewAllowed(preview: Project0HealthPreview): void {
  if (!preview.blocked) return;
  const reason = preview.warnings.length
    ? preview.warnings.join(' ')
    : preview.after?.healthRatio !== null && preview.after?.healthRatio !== undefined
      ? `Projected health ratio ${preview.after.healthRatioText} is below minimum ${preview.minHealthRatio}.`
      : 'Projected Project 0 account health is unavailable or unhealthy.';
  throw new AdapterError(PROJECT0_ADAPTER_ID, 'health_check_failed', reason);
}

function project0Summary(operation: Project0ActionOperation, preview: Project0HealthPreview): string {
  if (operation === 'create_account') {
    return `Create Project 0 account${preview.accountIndex !== undefined ? ` #${preview.accountIndex}` : ''}`;
  }
  const token = preview.tokenSymbol ?? shortAddress(preview.bankMint ?? preview.bankAddress ?? 'bank');
  const amount = preview.amount ?? '0';
  const direction = operation === 'deposit' || operation === 'repay' ? 'to' : 'from';
  return `${titleCase(operation)} ${amount} ${token} ${direction} Project 0`;
}

function requireSingleTransaction(transactions: string[], operation: Project0ActionOperation): string {
  if (transactions.length === 1 && transactions[0]) return transactions[0];
  throw new AdapterError(
    PROJECT0_ADAPTER_ID,
    'multiple_transactions',
    `Project 0 ${operation} produced ${transactions.length} transactions, but this wallet path only supports one. Use a bridge that supports multi-transaction connector approvals.`,
  );
}

function stringParam(action: PreparedAction, key: string): string | undefined {
  const value = action.params[key];
  return typeof value === 'string' && value ? value : undefined;
}

function numberParam(action: PreparedAction, key: string): number | undefined {
  const value = action.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1).replace(/_/g, ' ')}`;
}

function shortAddress(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}

export type { Project0Operation };
