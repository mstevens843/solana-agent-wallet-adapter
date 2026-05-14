import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { Cluster } from '@solana-agent-wallet-adapter/core';
import {
  latestDueOccurrence,
  nextFutureOccurrence,
  type RecurringCadence as WorkflowRecurringCadence,
} from '@solana-agent-wallet-adapter/workflow';

export type PreparedActionKind =
  | 'transfer_sol'
  | 'transfer_spl'
  | 'swap'
  | 'blink_action'
  | 'kamino_deposit'
  | 'kamino_withdraw'
  | 'meteora_claim_fees'
  | 'meteora_claim_rewards'
  | 'meteora_add_liquidity'
  | 'meteora_remove_liquidity'
  | 'meteora_close_position'
  | 'orca_increase_liquidity'
  | 'orca_decrease_liquidity'
  | 'orca_collect_fees'
  | 'orca_collect_rewards'
  | 'marginfi_deposit'
  | 'marginfi_withdraw'
  | 'marginfi_borrow'
  | 'marginfi_repay'
  | 'project0_create_account'
  | 'project0_deposit'
  | 'project0_withdraw'
  | 'project0_borrow'
  | 'project0_repay'
  | 'drift_vault_deposit'
  | 'drift_vault_request_withdraw'
  | 'drift_vault_cancel_withdraw'
  | 'drift_vault_complete_withdraw'
  | 'save_deposit'
  | 'save_withdraw'
  | 'save_borrow'
  | 'save_repay'
  | 'jito_stake_sol'
  | 'jito_deposit_stake_account'
  | 'jito_unstake_jitosol'
  | 'jito_withdraw_sol'
  | 'jito_claim_deposit_receipt'
  | 'marinade_liquid_stake'
  | 'marinade_liquid_unstake'
  | 'marinade_delayed_unstake'
  | 'marinade_claim_delayed_unstake'
  | 'lulo_deposit'
  | 'lulo_withdraw'
  | 'lulo_complete_withdraw'
  | 'raydium_add_liquidity'
  | 'raydium_remove_liquidity'
  | 'raydium_collect_fees'
  | 'raydium_farm_stake'
  | 'raydium_farm_unstake'
  | 'raydium_harvest'
  | 'magiceden_buy'
  | 'magiceden_list'
  | 'magiceden_cancel_listing'
  | 'magiceden_bid'
  | 'magiceden_cancel_bid'
  | 'tensor_buy'
  | 'tensor_list'
  | 'tensor_cancel_listing'
  | 'tensor_bid'
  | 'tensor_cancel_bid'
  | 'tensor_sweep'
  | 'sanctum_swap_lst'
  | 'sanctum_add_infinity_liquidity'
  | 'sanctum_remove_infinity_liquidity'
  | 'sanctum_stake_sol_to_lst'
  | 'sanctum_unstake_lst_to_sol'
  | 'pyth_post_price_update'
  | 'realms_cast_vote'
  | 'realms_relinquish_vote'
  | 'realms_deposit_governance_tokens'
  | 'realms_withdraw_governance_tokens'
  | 'squads_create_transfer_proposal'
  | 'squads_approve_proposal'
  | 'squads_reject_proposal'
  | 'squads_cancel_proposal'
  | 'squads_execute_proposal'
  | 'wormhole_transfer'
  | 'wormhole_redeem'
  | 'wormhole_recover_or_resume'
  | 'jupiter_lend_earn_deposit'
  | 'jupiter_lend_earn_withdraw'
  | 'jupiter_lend_earn_mint'
  | 'jupiter_lend_earn_redeem'
  | 'jupiter_lend_borrow_create_position'
  | 'jupiter_lend_borrow_deposit_collateral'
  | 'jupiter_lend_borrow_borrow'
  | 'jupiter_lend_borrow_repay'
  | 'jupiter_lend_borrow_withdraw_collateral'
  | 'jupiter_trigger_register_vault'
  | 'jupiter_trigger_single_order'
  | 'jupiter_trigger_oco_order'
  | 'jupiter_trigger_otoco_order'
  | 'jupiter_trigger_edit_order'
  | 'jupiter_trigger_cancel_order'
  | 'jupiter_trigger_withdraw_order_funds'
  | 'jupiter_recurring_create_time_order'
  | 'jupiter_recurring_cancel_order'
  | 'jupiter_recurring_deposit_price_order'
  | 'jupiter_recurring_withdraw_price_order';
export type PreparedActionTxStatus = 'pending' | 'confirmed' | 'failed';
export type RecurringCadence = WorkflowRecurringCadence;

export type PreparedActionStatus =
  | 'scheduled'
  | 'ready'
  | 'overdue'
  | 'approval_pending'
  | 'approved'
  | 'rejected'
  | 'blocked'
  | 'failed';

export const TERMINAL_PREPARED_ACTION_STATUSES: ReadonlySet<PreparedActionStatus> = new Set<PreparedActionStatus>([
  'approved',
  'rejected',
  'blocked',
  'failed',
]);

export interface PreparedAction {
  id: string;
  kind: PreparedActionKind;
  status: PreparedActionStatus;
  walletAddress: string;
  cluster: Cluster;
  summary: string;
  params: Record<string, unknown>;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  activeRequestId?: string;
  txid?: string;
  txids?: string[];
  txStatus?: PreparedActionTxStatus;
  confirmedAt?: string;
  txError?: string;
  error?: string;
  note?: string;
  recurringId?: string;
  occurrenceKey?: string;
  archived?: boolean;
  archivedAt?: string;
}

export interface ConnectorRecurringTemplate {
  connectorId: string;
  actionType: string;
  subActionId?: string;
  params: Record<string, string>;
  blinkUrl?: string;
}

export interface RecurringPayment {
  id: string;
  status: 'active' | 'paused';
  walletAddress: string;
  cluster: Cluster;
  actionKind?: 'transfer' | 'swap' | 'connector' | 'blink';
  token: string;
  inputToken?: string;
  outputToken?: string;
  recipient: string;
  amount: string;
  slippageBps?: number | string;
  cadence: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
  occurrencesCreated?: number;
  consecutiveFailures?: number;
  lastOccurrenceError?: string;
  note?: string;
  expiresAt?: string;
  notifications?: RecurringPaymentNotifications;
  connectorActionTemplate?: ConnectorRecurringTemplate;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type AddRecurringPaymentInput = Omit<RecurringPayment, 'id' | 'status' | 'createdAt' | 'updatedAt'> & {
  status?: RecurringPayment['status'];
};

export interface RecurringPaymentNotifications {
  inApp?: boolean;
  webhookUrl?: string;
}

export interface RecurringPaymentView extends RecurringPayment {
  nextDueAt?: string;
}

export interface ActionReceipt {
  actionId: string;
  status: PreparedActionStatus;
  txStatus?: PreparedActionTxStatus;
  txid?: string;
  txids?: string[];
  explorerUrl?: string;
  explorerUrls?: string[];
  summary: string;
  note?: string;
  walletAddress: string;
  recipient?: string;
  amount?: string;
  token?: string;
  cluster: Cluster;
  createdAt: string;
  completedAt: string;
  error?: string;
  recurringId?: string;
  occurrenceKey?: string;
}

interface PreparedActionState {
  actions: PreparedAction[];
  recurringPayments: RecurringPayment[];
}

export interface AddPreparedActionInput {
  kind: PreparedActionKind;
  walletAddress: string;
  cluster: Cluster;
  summary: string;
  params: Record<string, unknown>;
  dueAt?: string;
  status?: PreparedActionStatus;
  note?: string;
  recurringId?: string;
  occurrenceKey?: string;
}

export interface PreparedActionStore {
  addAction(input: AddPreparedActionInput): Promise<PreparedAction>;
  listActions(): Promise<PreparedAction[]>;
  getAction(id: string): Promise<PreparedAction | null>;
  updateAction(id: string, patch: Partial<PreparedAction>): Promise<PreparedAction>;
  deleteAction(id: string): Promise<boolean>;
  archiveAction(id: string): Promise<PreparedAction>;
  addRecurringPayment(input: AddRecurringPaymentInput): Promise<RecurringPayment>;
  listRecurringPayments(): Promise<RecurringPayment[]>;
  listRecurringPaymentViews(now?: Date): Promise<RecurringPaymentView[]>;
  updateRecurringPayment(id: string, patch: Partial<RecurringPayment>): Promise<RecurringPayment>;
  deleteRecurringPayment(id: string): Promise<boolean>;
  materializeDueRecurring(now?: Date): Promise<PreparedAction[]>;
  listReceipts(): Promise<ActionReceipt[]>;
  getStoragePath?(): string;
}

export class JsonPreparedActionStore implements PreparedActionStore {
  private readonly path: string;
  private queue = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async addAction(input: AddPreparedActionInput): Promise<PreparedAction> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      const dueAt = input.dueAt ?? now;
      const action: PreparedAction = {
        id: newId('pa'),
        kind: input.kind,
        status: input.status ?? statusForDueAt(dueAt, new Date(now)),
        walletAddress: input.walletAddress,
        cluster: input.cluster,
        summary: input.summary,
        params: input.params,
        dueAt,
        createdAt: now,
        updatedAt: now,
        ...(input.note !== undefined && { note: input.note }),
        ...(input.recurringId !== undefined && { recurringId: input.recurringId }),
        ...(input.occurrenceKey !== undefined && { occurrenceKey: input.occurrenceKey }),
      };
      state.actions.push(action);
      return action;
    });
  }

  async listActions(): Promise<PreparedAction[]> {
    const state = await this.read();
    const now = new Date();
    return state.actions
      .map((action) =>
        action.status === 'scheduled' && new Date(action.dueAt).getTime() <= now.getTime()
          ? { ...action, status: 'overdue' as const }
          : action,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getAction(id: string): Promise<PreparedAction | null> {
    const actions = await this.listActions();
    return actions.find((action) => action.id === id) ?? null;
  }

  async updateAction(id: string, patch: Partial<PreparedAction>): Promise<PreparedAction> {
    return this.mutate((state) => {
      const index = state.actions.findIndex((action) => action.id === id);
      if (index < 0) {
        throw new Error(`Unknown prepared action: ${id}`);
      }
      const current = state.actions[index];
      if (!current) {
        throw new Error(`Unknown prepared action: ${id}`);
      }
      const updated: PreparedAction = {
        ...current,
        ...patch,
        id,
        updatedAt: new Date().toISOString(),
      };
      state.actions[index] = updated;
      return updated;
    });
  }

  async deleteAction(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const before = state.actions.length;
      state.actions = state.actions.filter((action) => action.id !== id);
      return state.actions.length !== before;
    });
  }

  async archiveAction(id: string): Promise<PreparedAction> {
    return this.updateAction(id, {
      archived: true,
      archivedAt: new Date().toISOString(),
    });
  }

  async addRecurringPayment(
    input: AddRecurringPaymentInput,
  ): Promise<RecurringPayment> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      const payment: RecurringPayment = {
        id: newId('rp'),
        ...input,
        status: input.status ?? 'active',
        createdAt: now,
        updatedAt: now,
        startAt: input.startAt ?? now,
      };
      state.recurringPayments.push(payment);
      return payment;
    });
  }

  async listRecurringPayments(): Promise<RecurringPayment[]> {
    const state = await this.read();
    return [...state.recurringPayments];
  }

  async listRecurringPaymentViews(now = new Date()): Promise<RecurringPaymentView[]> {
    const state = await this.read();
    return state.recurringPayments
      .map((payment) => {
        const nextDueAt = nextRecurringDueAt(payment, now);
        return {
          ...payment,
          ...(nextDueAt ? { nextDueAt } : {}),
        };
      })
      .sort((left, right) => {
        const leftDue = left.nextDueAt ?? '9999-12-31T23:59:59.999Z';
        const rightDue = right.nextDueAt ?? '9999-12-31T23:59:59.999Z';
        return leftDue.localeCompare(rightDue);
      });
  }

  async updateRecurringPayment(id: string, patch: Partial<RecurringPayment>): Promise<RecurringPayment> {
    return this.mutate((state) => {
      const index = state.recurringPayments.findIndex((payment) => payment.id === id);
      if (index < 0) {
        throw new Error(`Unknown recurring payment: ${id}`);
      }
      const current = state.recurringPayments[index];
      if (!current) {
        throw new Error(`Unknown recurring payment: ${id}`);
      }
      const updated: RecurringPayment = {
        ...current,
        ...patch,
        id,
        updatedAt: new Date().toISOString(),
      };
      state.recurringPayments[index] = updated;
      return updated;
    });
  }

  async deleteRecurringPayment(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const before = state.recurringPayments.length;
      state.recurringPayments = state.recurringPayments.filter((payment) => payment.id !== id);
      return state.recurringPayments.length !== before;
    });
  }

  async materializeDueRecurring(now = new Date()): Promise<PreparedAction[]> {
    return this.mutate((state) => {
      const created: PreparedAction[] = [];
      for (const payment of state.recurringPayments) {
        if (payment.status !== 'active') continue;
        const unresolved = state.actions.some((action) =>
          action.recurringId === payment.id && isUnresolvedPreparedAction(action),
        );
        if (unresolved) continue;
        if (payment.maxOccurrences !== undefined && (payment.occurrencesCreated ?? 0) >= payment.maxOccurrences) {
          continue;
        }
        if (payment.expiresAt) {
          const expiry = new Date(payment.expiresAt);
          if (!Number.isNaN(expiry.getTime()) && now.getTime() >= expiry.getTime()) {
            continue;
          }
        }
        const occurrence = latestDueOccurrence(payment, now);
        if (!occurrence || occurrence.dueAt.getTime() > now.getTime()) continue;
        const exists = state.actions.some(
          (action) => action.recurringId === payment.id && action.occurrenceKey === occurrence.key,
        );
        if (exists) continue;
        const timestamp = new Date().toISOString();
        const status: PreparedAction['status'] = occurrence.dueAt.getTime() < now.getTime() ? 'overdue' : 'ready';
        const baseAction = {
          id: newId('pa'),
          walletAddress: payment.walletAddress,
          cluster: payment.cluster,
          dueAt: occurrence.dueAt.toISOString(),
          createdAt: timestamp,
          updatedAt: timestamp,
          status,
          ...(payment.note !== undefined && { note: payment.note }),
          recurringId: payment.id,
          occurrenceKey: occurrence.key,
        };
        let action: PreparedAction;
        if (payment.actionKind === 'connector' && payment.connectorActionTemplate) {
          const template = payment.connectorActionTemplate;
          action = {
            ...baseAction,
            kind: template.actionType as PreparedAction['kind'],
            summary: `Recurring ${template.connectorId} ${template.subActionId ?? template.actionType}`.slice(0, 140),
            params: {
              ...template.params,
              connectorId: template.connectorId,
              recurringActionType: template.actionType,
              ...(template.subActionId ? { subActionId: template.subActionId } : {}),
              pendingPrepare: 'true',
            },
          };
        } else if (payment.actionKind === 'blink' && payment.connectorActionTemplate?.blinkUrl) {
          const template = payment.connectorActionTemplate;
          action = {
            ...baseAction,
            kind: 'blink_action' as PreparedAction['kind'],
            summary: `Recurring Blink ${template.connectorId}`.slice(0, 140),
            params: {
              ...template.params,
              connectorId: template.connectorId,
              blinkUrl: template.blinkUrl,
              pendingPrepare: 'true',
            },
          };
        } else {
          const isSwap = payment.actionKind === 'swap' || Boolean(payment.outputToken);
          const inputToken = payment.inputToken || payment.token;
          const outputToken = payment.outputToken || 'USDC';
          action = {
            ...baseAction,
            kind: isSwap ? 'swap' : payment.token.toUpperCase() === 'SOL' ? 'transfer_sol' : 'transfer_spl',
            summary: isSwap
              ? `Recurring ${payment.amount} ${inputToken} swap to ${outputToken}`
              : `Recurring ${payment.amount} ${payment.token} payment to ${payment.recipient}`,
            params: isSwap
              ? {
                  inputToken,
                  outputToken,
                  amount: payment.amount,
                  slippageBps: payment.slippageBps ?? 50,
                }
              : payment.token.toUpperCase() === 'SOL'
                ? { recipient: payment.recipient, amountSol: payment.amount }
                : {
                    token: payment.token,
                    recipient: payment.recipient,
                    amount: payment.amount,
                  },
          };
        }
        state.actions.push(action);
        payment.occurrencesCreated = (payment.occurrencesCreated ?? 0) + 1;
        payment.updatedAt = timestamp;
        created.push(action);
      }
      return created;
    });
  }

  async listReceipts(): Promise<ActionReceipt[]> {
    const state = await this.read();
    return state.actions
      .filter((action) => ['approved', 'rejected', 'failed', 'blocked'].includes(action.status))
      .map((action) => actionReceipt(action))
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  }

  getStoragePath(): string {
    return this.path;
  }

  private async mutate<T>(mutator: (state: PreparedActionState) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const state = await this.read();
      const result = mutator(state);
      await this.write(state);
      return result;
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async read(): Promise<PreparedActionState> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PreparedActionState>;
      return normalizeState({
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        recurringPayments: Array.isArray(parsed.recurringPayments) ? parsed.recurringPayments : [],
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { actions: [], recurringPayments: [] };
      }
      throw err;
    }
  }

  private async write(state: PreparedActionState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.path);
  }
}

function normalizeState(state: PreparedActionState): PreparedActionState {
  return {
    actions: state.actions.map(normalizePreparedAction),
    recurringPayments: state.recurringPayments,
  };
}

function normalizePreparedAction(action: PreparedAction): PreparedAction {
  if (
    action.kind !== 'transfer_sol' ||
    typeof action.params.amountSol === 'string' ||
    typeof action.params.amount !== 'string'
  ) {
    return action;
  }
  return {
    ...action,
    params: {
      ...action.params,
      amountSol: action.params.amount,
    },
  };
}

export function defaultPreparedActionStorePath(): string {
  return resolve(process.cwd(), '.agent-wallet', 'prepared-actions.json');
}

export function nextRecurringDueAt(payment: RecurringPayment, now = new Date()): string | null {
  if (payment.status !== 'active') return null;
  if (
    payment.maxOccurrences !== undefined &&
    (payment.occurrencesCreated ?? 0) >= payment.maxOccurrences
  ) {
    return null;
  }
  return nextFutureOccurrence(payment, now)?.dueAt.toISOString() ?? null;
}

function actionReceipt(action: PreparedAction): ActionReceipt {
  const recipient =
    typeof action.params.recipient === 'string'
      ? action.params.recipient
      : undefined;
  const amount =
    typeof action.params.amountSol === 'string'
      ? action.params.amountSol
      : typeof action.params.amount === 'string'
        ? action.params.amount
        : undefined;
  const token =
    action.kind === 'transfer_sol'
      ? 'SOL'
      : typeof action.params.token === 'string'
        ? action.params.token
        : typeof action.params.inputToken === 'string'
          ? action.params.inputToken
          : undefined;
  return {
    actionId: action.id,
    status: action.status,
    ...(action.txStatus !== undefined && { txStatus: action.txStatus }),
    ...(action.txid !== undefined && { txid: action.txid }),
    ...(action.txids !== undefined && { txids: action.txids }),
    ...(action.txid !== undefined && { explorerUrl: explorerUrl(action.txid, action.cluster) }),
    ...(action.txids !== undefined && { explorerUrls: action.txids.map((txid) => explorerUrl(txid, action.cluster)) }),
    summary: action.summary,
    ...(action.note !== undefined && { note: action.note }),
    walletAddress: action.walletAddress,
    ...(recipient !== undefined && { recipient }),
    ...(amount !== undefined && { amount }),
    ...(token !== undefined && { token }),
    cluster: action.cluster,
    createdAt: action.createdAt,
    completedAt: action.confirmedAt ?? action.updatedAt,
    ...(action.error !== undefined && { error: action.error }),
    ...(action.recurringId !== undefined && { recurringId: action.recurringId }),
    ...(action.occurrenceKey !== undefined && { occurrenceKey: action.occurrenceKey }),
  };
}

function explorerUrl(txid: string, cluster: Cluster): string {
  const clusterParam = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${txid}${clusterParam}`;
}

function statusForDueAt(dueAt: string, now: Date): PreparedActionStatus {
  return new Date(dueAt).getTime() > now.getTime() ? 'scheduled' : 'ready';
}

function isUnresolvedPreparedAction(action: PreparedAction): boolean {
  return !action.archived &&
    action.status !== 'approved' &&
    action.status !== 'rejected' &&
    action.status !== 'blocked' &&
    action.status !== 'failed';
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${suffix}`;
}
