import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import {
  ProtocolError,
  SolanaSigningClient,
  type Cluster,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';

import { lifetimeSpendEstimate } from '@solana-agent-wallet-adapter/workflow';

import { formatRawAmount, parseDecimalAmount } from './amounts.js';
import {
  DEFAULT_TOKEN_REGISTRY,
  USDC_MINT,
  WSOL_MINT,
  type AgentWalletConfig,
  type RecurringPolicyConfig,
  type TokenLimitConfig,
} from './config.js';
import type {
  PreparedAction,
  PreparedActionStore,
  PreparedActionTxStatus,
  RecurringCadence,
} from './preparedActions.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export interface AgentWalletActionServiceOptions {
  backend: WalletBackend;
  config: AgentWalletConfig;
  preparedActions?: PreparedActionStore;
  connection?: Connection;
  client?: SolanaSigningClient;
}

export interface SwapInput {
  inputToken?: string;
  outputToken?: string;
  amount: string;
  slippageBps?: number;
}

export interface PrepareTransferSolInput {
  recipient: string;
  amountSol: string;
  dueAt?: string;
  note?: string;
}

export interface PrepareTransferSplInput {
  token: string;
  recipient: string;
  amount: string;
  dueAt?: string;
  note?: string;
}

export interface PrepareSwapInput extends SwapInput {
  dueAt?: string;
  note?: string;
}

export interface RecurringPaymentInput {
  token?: string;
  recipient?: string;
  amount?: string;
  cadence?: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
  note?: string;
  expiresAt?: string;
  notifications?: { inApp?: boolean; webhookUrl?: string };
}

export interface UpdateRecurringPaymentInput extends RecurringPaymentInput {
  recurringId: string;
}

export class AgentWalletActionService {
  private readonly backend: WalletBackend;
  private readonly config: AgentWalletConfig;
  private readonly preparedActions?: PreparedActionStore;
  private readonly connection: Connection;
  private readonly client: SolanaSigningClient;

  constructor(options: AgentWalletActionServiceOptions) {
    this.backend = options.backend;
    this.config = options.config;
    this.preparedActions = options.preparedActions;
    this.connection = options.connection ?? new Connection(options.config.rpcUrl, 'confirmed');
    this.client = options.client ?? new SolanaSigningClient({ backend: options.backend });
  }

  async walletStatus(): Promise<Record<string, unknown>> {
    const caps = await this.backend.capabilities();
    return {
      connected: Boolean(caps.address),
      address: caps.address ?? null,
      cluster: this.config.cluster,
      rpcUrl: this.config.rpcUrl,
      mainnetEnabled: this.config.mainnet.enabled,
      caps: this.config.mainnet,
      tokens: this.config.tokens,
    };
  }

  async health(): Promise<Record<string, unknown>> {
    const caps = await this.backend.capabilities().catch(() => null);
    return {
      walletConnected: Boolean(caps?.address),
      walletAddress: caps?.address ?? null,
      cluster: this.config.cluster,
      rpcUrl: this.config.rpcUrl,
      rpcWritable: await checkRpc(this.config.rpcUrl),
      mainnetEnabled: this.config.mainnet.enabled,
      capsEnabled: Boolean(this.config.mainnet.enabled),
      safetyCaps: this.config.mainnet,
      allowlistedTokens: this.config.tokens,
      preparedActionStorePath: this.preparedActions?.getStoragePath?.() ?? null,
    };
  }

  async balances(): Promise<Record<string, unknown>> {
    const address = await this.backend.getAddress();
    const owner = new PublicKey(address);
    const lamports = await this.connection.getBalance(owner, 'confirmed');
    return {
      address,
      cluster: this.config.cluster,
      sol: formatRawAmount(BigInt(lamports), 9),
      lamports: lamports.toString(),
      tokens: await readConfiguredTokenBalances(this.connection, owner, this.config),
    };
  }

  async portfolioSummary(): Promise<Record<string, unknown>> {
    const address = await this.backend.getAddress();
    const owner = new PublicKey(address);
    const lamports = await this.connection.getBalance(owner, 'confirmed');
    const configuredTokens = await readConfiguredTokenBalances(this.connection, owner, this.config);
    const parsedTokens = await this.connection
      .getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, 'confirmed')
      .catch(() => ({ value: [] }));
    const configuredMints = new Set(this.config.tokens.map((token) => token.mint));
    const unknownTokenAccounts = parsedTokens.value
      .map((entry) => {
        const parsed = entry.account.data.parsed as {
          info?: {
            mint?: string;
            tokenAmount?: { uiAmountString?: string; amount?: string; decimals?: number };
          };
        };
        return {
          account: entry.pubkey.toBase58(),
          mint: parsed.info?.mint ?? '',
          amount: parsed.info?.tokenAmount?.uiAmountString ?? '0',
          rawAmount: parsed.info?.tokenAmount?.amount ?? '0',
          decimals: parsed.info?.tokenAmount?.decimals ?? 0,
        };
      })
      .filter((token) => token.mint && !configuredMints.has(token.mint));
    const recentSignatures = await this.connection
      .getSignaturesForAddress(owner, { limit: 5 }, 'confirmed')
      .catch(() => []);
    return {
      address,
      cluster: this.config.cluster,
      sol: formatRawAmount(BigInt(lamports), 9),
      lamports: lamports.toString(),
      configuredTokens,
      unknownTokenAccounts,
      recentSignatures: recentSignatures.map((signature) => ({
        signature: signature.signature,
        slot: signature.slot,
        err: signature.err,
        blockTime: signature.blockTime,
      })),
      safetyCaps: this.config.mainnet,
    };
  }

  async prepareTransferSol(input: PrepareTransferSolInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    parseDecimalAmount(input.amountSol, 9, 'SOL transfer amount');
    const from = await this.backend.getAddress();
    const to = new PublicKey(input.recipient).toBase58();
    const action = await this.store().addAction({
      kind: 'transfer_sol',
      walletAddress: from,
      cluster: this.config.cluster,
      summary: `Transfer ${input.amountSol} SOL to ${to}`,
      params: { recipient: to, amountSol: input.amountSol },
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    });
    return { preparedAction: action };
  }

  async prepareTransferSpl(input: PrepareTransferSplInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const tokenConfig = await resolveToken(this.config, this.connection, input.token);
    parseDecimalAmount(input.amount, tokenConfig.decimals, `${tokenConfig.symbol} amount`);
    const from = await this.backend.getAddress();
    const to = new PublicKey(input.recipient).toBase58();
    const action = await this.store().addAction({
      kind: 'transfer_spl',
      walletAddress: from,
      cluster: this.config.cluster,
      summary: `Transfer ${input.amount} ${tokenConfig.symbol} to ${to}`,
      params: { token: tokenConfig.requestToken, recipient: to, amount: input.amount },
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    });
    return { preparedAction: action };
  }

  async prepareSwap(input: PrepareSwapInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const swap = await normalizeSwapInput(this.config, this.connection, input);
    const from = await this.backend.getAddress();
    const action = await this.store().addAction({
      kind: 'swap',
      walletAddress: from,
      cluster: this.config.cluster,
      summary: `Swap ${input.amount} ${swap.inputSymbol} to ${swap.outputSymbol}`,
      params: {
        inputToken: swap.inputSymbol,
        outputToken: swap.outputSymbol,
        amount: input.amount,
        slippageBps: swap.slippageBps,
      },
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    });
    return { preparedAction: action };
  }

  async listPreparedActions(): Promise<Record<string, unknown>> {
    const store = this.store();
    const materialized = await store.materializeDueRecurring();
    const actions = await store.listActions();
    return { materialized, actions };
  }

  async rejectPreparedAction(actionId: string, reason?: string): Promise<Record<string, unknown>> {
    return {
      preparedAction: await this.store().updateAction(actionId, {
        status: 'rejected',
        ...(reason !== undefined && { error: reason }),
      }),
    };
  }

  async archivePreparedAction(actionId: string): Promise<Record<string, unknown>> {
    return { preparedAction: await this.store().archiveAction(actionId) };
  }

  async deletePreparedAction(actionId: string): Promise<Record<string, unknown>> {
    return { deleted: await this.store().deleteAction(actionId) };
  }

  async executePreparedAction(actionId: string): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const store = this.store();
    const action = await store.getAction(actionId);
    if (!action) {
      throw new ProtocolError('invalid_request', `Unknown prepared action: ${actionId}`);
    }
    assertPreparedActionExecutable(action);
    await store.updateAction(actionId, { status: 'approval_pending' });
    try {
      const result = await this.executePreparedActionRecord(action);
      const updated = await store.updateAction(actionId, {
        status: 'approved',
        txid: result.txid,
        txStatus: 'pending',
        confirmedAt: undefined,
        txError: undefined,
        error: undefined,
      });
      return { preparedAction: updated, result };
    } catch (err) {
      await store.updateAction(actionId, {
        status: preparedFailureStatus(err),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async refreshPreparedActionTxStatuses(): Promise<Record<string, unknown>> {
    const store = this.store();
    const actions = await store.listActions();
    const pending = actions.filter((action) => action.txid && action.txStatus !== 'confirmed' && action.txStatus !== 'failed');
    const updates: Array<{ actionId: string; txid: string; txStatus: PreparedActionTxStatus }> = [];
    if (pending.length > 0) {
      const statuses = await this.connection.getSignatureStatuses(pending.map((action) => action.txid!));
      for (let index = 0; index < pending.length; index += 1) {
        const action = pending[index]!;
        const txid = action.txid!;
        const status = statuses.value[index];
        if (!status) {
          if (action.txStatus !== 'pending') {
            await store.updateAction(action.id, { txStatus: 'pending' });
            updates.push({ actionId: action.id, txid, txStatus: 'pending' });
          }
          continue;
        }
        if (status.err) {
          await store.updateAction(action.id, {
            txStatus: 'failed',
            txError: JSON.stringify(status.err),
          });
          updates.push({ actionId: action.id, txid, txStatus: 'failed' });
          continue;
        }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          await store.updateAction(action.id, {
            txStatus: 'confirmed',
            confirmedAt: new Date().toISOString(),
            txError: undefined,
          });
          updates.push({ actionId: action.id, txid, txStatus: 'confirmed' });
          continue;
        }
        if (action.txStatus !== 'pending') {
          await store.updateAction(action.id, { txStatus: 'pending' });
          updates.push({ actionId: action.id, txid, txStatus: 'pending' });
        }
      }
    }
    return { updates, actions: await store.listActions() };
  }

  async receipts(): Promise<Record<string, unknown>> {
    return { receipts: await this.store().listReceipts() };
  }

  async createRecurringPayment(input: RecurringPaymentInput): Promise<Record<string, unknown>> {
    const store = this.store();
    const recurringPayment = await store.addRecurringPayment(
      await buildRecurringPaymentInput(input, await this.backend.getAddress(), this.config, this.connection),
    );
    const materialized = await store.materializeDueRecurring();
    return { recurringPayment, materialized, actions: await store.listActions() };
  }

  async listRecurringPayments(): Promise<Record<string, unknown>> {
    const store = this.store();
    const materialized = await store.materializeDueRecurring();
    return {
      materialized,
      recurringPayments: await store.listRecurringPaymentViews(),
    };
  }

  async updateRecurringPayment(input: UpdateRecurringPaymentInput): Promise<Record<string, unknown>> {
    const store = this.store();
    const current = (await store.listRecurringPayments()).find((payment) => payment.id === input.recurringId);
    if (!current) {
      throw new ProtocolError('invalid_request', `Unknown recurring payment: ${input.recurringId}`);
    }
    const recurringPayment = await store.updateRecurringPayment(
      input.recurringId,
      await buildRecurringPaymentInput(input, current.walletAddress, this.config, this.connection),
    );
    const materialized = await store.materializeDueRecurring();
    return { recurringPayment, materialized, actions: await store.listActions() };
  }

  async pauseRecurringPayment(recurringId: string): Promise<Record<string, unknown>> {
    return { recurringPayment: await this.store().updateRecurringPayment(recurringId, { status: 'paused' }) };
  }

  async resumeRecurringPayment(recurringId: string): Promise<Record<string, unknown>> {
    return { recurringPayment: await this.store().updateRecurringPayment(recurringId, { status: 'active' }) };
  }

  async deleteRecurringPayment(recurringId: string): Promise<Record<string, unknown>> {
    return { deleted: await this.store().deleteRecurringPayment(recurringId) };
  }

  async transferSol(input: { recipient: string; amountSol: string }): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const lamports = parseDecimalAmount(input.amountSol, 9, 'SOL transfer amount');
    const from = new PublicKey(await this.backend.getAddress());
    const balance = await this.connection.getBalance(from, 'confirmed');
    if (BigInt(balance) < lamports) {
      throw new ProtocolError('unauthorized', `Insufficient SOL balance for ${input.amountSol} SOL transfer.`);
    }
    const to = new PublicKey(input.recipient);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: to,
        lamports: Number(lamports),
      }),
    );
    await prepareTransaction(this.connection, tx, from);
    const txid = await this.signAndBroadcastTransaction(tx, `Transfer ${input.amountSol} SOL to ${to.toBase58()}`);
    return {
      cluster: this.config.cluster,
      from: from.toBase58(),
      recipient: to.toBase58(),
      amountSol: input.amountSol,
      txid,
      explorerUrl: explorerUrl(txid, this.config.cluster),
    };
  }

  async transferSpl(input: { token: string; recipient: string; amount: string }): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const tokenConfig = await resolveToken(this.config, this.connection, input.token);
    const rawAmount = parseDecimalAmount(input.amount, tokenConfig.decimals, `${tokenConfig.symbol} amount`);
    const owner = new PublicKey(await this.backend.getAddress());
    const recipientOwner = new PublicKey(input.recipient);
    const mint = new PublicKey(tokenConfig.mint);
    const sourceAta = await getAssociatedTokenAddress(mint, owner, tokenConfig.tokenProgramId);
    const sourceBalance = await this.connection.getTokenAccountBalance(sourceAta).catch(() => null);
    if (!sourceBalance || BigInt(sourceBalance.value.amount) < rawAmount) {
      throw new ProtocolError('unauthorized', `Insufficient ${tokenConfig.symbol} balance for ${input.amount} transfer.`);
    }
    const destinationAta = await getAssociatedTokenAddress(mint, recipientOwner, tokenConfig.tokenProgramId);
    const tx = new Transaction();
    const destinationAccount = await this.connection.getAccountInfo(destinationAta, 'confirmed');
    if (!destinationAccount) {
      tx.add(createAssociatedTokenAccountInstruction(owner, destinationAta, recipientOwner, mint, tokenConfig.tokenProgramId));
    }
    tx.add(createTransferCheckedInstruction(sourceAta, mint, destinationAta, owner, rawAmount, tokenConfig.decimals, tokenConfig.tokenProgramId));
    await prepareTransaction(this.connection, tx, owner);
    const txid = await this.signAndBroadcastTransaction(
      tx,
      `Transfer ${input.amount} ${tokenConfig.symbol} to ${recipientOwner.toBase58()}`,
    );
    return {
      cluster: this.config.cluster,
      from: owner.toBase58(),
      recipient: recipientOwner.toBase58(),
      token: tokenConfig.symbol,
      mint: tokenConfig.mint,
      amount: input.amount,
      txid,
      explorerUrl: explorerUrl(txid, this.config.cluster),
    };
  }

  async getSwapQuote(input: SwapInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const order = await fetchJupiterOrder(this.config, await this.backend.getAddress(), await normalizeSwapInput(this.config, this.connection, input));
    return orderSummary(order);
  }

  async swap(input: SwapInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const taker = await this.backend.getAddress();
    const swap = await normalizeSwapInput(this.config, this.connection, input);
    const order = await fetchJupiterOrder(this.config, taker, swap);
    if (!order.transaction || typeof order.transaction !== 'string') {
      throw new ProtocolError(
        'invalid_request',
        typeof order.errorMessage === 'string'
          ? order.errorMessage
          : 'Jupiter did not return a transaction for this order.',
      );
    }
    const signed = await this.client.signTransaction(order.transaction, {
      cluster: this.config.cluster,
      summary: `Swap ${input.amount} ${swap.inputSymbol} to ${swap.outputSymbol}`,
    });
    const executed = await executeJupiterOrder(this.config, signed.signature, order);
    return {
      ...orderSummary(order),
      status: executed.status,
      txid: executed.signature,
      explorerUrl: typeof executed.signature === 'string' ? explorerUrl(executed.signature, this.config.cluster) : null,
      execution: executed,
    };
  }

  async executePreparedActionRecord(action: PreparedAction): Promise<Record<string, unknown> & { txid: string }> {
    const currentAddress = await this.backend.getAddress();
    if (currentAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Prepared action belongs to ${action.walletAddress}, but connected wallet is ${currentAddress}.`,
      );
    }
    if (action.cluster !== this.config.cluster) {
      throw new ProtocolError(
        'cluster_mismatch',
        `Prepared action targets ${action.cluster}, but server is configured for ${this.config.cluster}.`,
      );
    }
    switch (action.kind) {
      case 'transfer_sol':
        return this.executePreparedSolTransfer(action);
      case 'transfer_spl':
        return this.executePreparedSplTransfer(action);
      case 'swap':
        return this.executePreparedSwap(action);
    }
  }

  private store(): PreparedActionStore {
    if (!this.preparedActions) {
      throw new ProtocolError('unsupported_method', 'Prepared action store is not configured.');
    }
    return this.preparedActions;
  }

  private async executePreparedSolTransfer(action: PreparedAction): Promise<Record<string, unknown> & { txid: string }> {
    const recipient = requireStringParam(action, 'recipient');
    const amountSol = requireStringParam(action, 'amountSol');
    return this.transferSol({ recipient, amountSol }) as Promise<Record<string, unknown> & { txid: string }>;
  }

  private async executePreparedSplTransfer(action: PreparedAction): Promise<Record<string, unknown> & { txid: string }> {
    const token = requireStringParam(action, 'token');
    const recipient = requireStringParam(action, 'recipient');
    const amount = requireStringParam(action, 'amount');
    return this.transferSpl({ token, recipient, amount }) as Promise<Record<string, unknown> & { txid: string }>;
  }

  private async executePreparedSwap(action: PreparedAction): Promise<Record<string, unknown> & { txid: string }> {
    const input = {
      inputToken: requireStringParam(action, 'inputToken'),
      outputToken: requireStringParam(action, 'outputToken'),
      amount: requireStringParam(action, 'amount'),
      slippageBps:
        typeof action.params.slippageBps === 'number'
          ? action.params.slippageBps
          : this.config.mainnet.maxSlippageBps,
    };
    const result = await this.swap(input);
    if (typeof result.txid !== 'string') {
      throw new ProtocolError('wallet_unreachable', 'Swap execution did not return a transaction signature.');
    }
    return result as Record<string, unknown> & { txid: string };
  }

  private async signAndBroadcastTransaction(transaction: Transaction, summary: string): Promise<string> {
    const signed = await this.client.signTransaction(txToBase64(transaction), {
      cluster: this.config.cluster,
      summary,
    });
    return this.connection.sendRawTransaction(Buffer.from(signed.signature, 'base64'), {
      preflightCommitment: 'confirmed',
      maxRetries: 5,
    });
  }
}

export function assertPreparedActionExecutable(action: PreparedAction, now = new Date()): void {
  if (action.status === 'scheduled') {
    const dueAt = new Date(action.dueAt);
    if (Number.isFinite(dueAt.getTime()) && dueAt.getTime() > now.getTime()) {
      throw new ProtocolError(
        'invalid_request',
        `Prepared action ${action.id} is scheduled for ${action.dueAt} and is not due yet.`,
      );
    }
  }
  if (!['ready', 'overdue', 'failed'].includes(action.status)) {
    throw new ProtocolError(
      'invalid_request',
      `Prepared action ${action.id} cannot be executed from status ${action.status}.`,
    );
  }
}

export function preparedFailureStatus(err: unknown): PreparedAction['status'] {
  if (err instanceof ProtocolError && err.code === 'user_rejected') {
    return 'rejected';
  }
  if (err instanceof ProtocolError && err.code === 'unauthorized') {
    return 'blocked';
  }
  return 'failed';
}

function requireActionAllowed(config: AgentWalletConfig): void {
  void config;
}

async function buildRecurringPaymentInput(
  input: RecurringPaymentInput,
  walletAddress: string,
  config: AgentWalletConfig,
  connection: Connection,
) {
  requireActionAllowed(config);
  const token = normalizeTokenIdentifier(requireString(input.token, 'token'));
  const amount = requireString(input.amount, 'amount');
  const recipient = new PublicKey(requireString(input.recipient, 'recipient')).toBase58();
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 500) : undefined;
  const localTime = typeof input.localTime === 'string' && input.localTime.trim() ? input.localTime.trim() : undefined;
  if (localTime !== undefined && !/^\d{2}:\d{2}$/.test(localTime)) {
    throw new ProtocolError('invalid_request', 'localTime must be HH:MM in 24-hour local time.');
  }
  const schedule = normalizeRecurringSchedule({
    cadence: input.cadence ?? 'weekly',
    dayOfWeek: input.dayOfWeek,
    dayOfMonth: input.dayOfMonth,
    intervalDays: input.intervalDays,
    intervalHours: input.intervalHours,
    intervalMinutes: input.intervalMinutes,
    localTime,
    startAt: input.startAt,
    maxOccurrences: input.maxOccurrences,
  });

  if (token === 'SOL') {
    parseDecimalAmount(amount, 9, 'SOL recurring payment amount');
  } else {
    const tokenConfig = await resolveToken(config, connection, token);
    parseDecimalAmount(amount, tokenConfig.decimals, `${tokenConfig.symbol} recurring payment amount`);
  }

  const expiresAt = normalizeExpiresAt(input.expiresAt);
  const notifications = normalizeNotifications(input.notifications);

  enforceRecurringPolicy(config.recurring, token, amount, {
    cadence: schedule.cadence,
    dayOfWeek: schedule.dayOfWeek,
    dayOfMonth: schedule.dayOfMonth,
    intervalDays: schedule.intervalDays,
    intervalHours: schedule.intervalHours,
    intervalMinutes: schedule.intervalMinutes,
    localTime: schedule.localTime,
    startAt: schedule.startAt,
    maxOccurrences: schedule.maxOccurrences,
    createdAt: new Date().toISOString(),
    expiresAt,
  });

  return {
    walletAddress,
    cluster: config.cluster,
    token,
    recipient,
    amount,
    ...schedule,
    ...(note !== undefined && { note }),
    ...(expiresAt !== undefined && { expiresAt }),
    ...(notifications !== undefined && { notifications }),
  };
}

function enforceRecurringPolicy(
  policy: RecurringPolicyConfig | undefined,
  token: string,
  amount: string,
  cadenceFields: Parameters<typeof lifetimeSpendEstimate>[0],
): void {
  if (!policy) return;
  const lifetime = policy.maxLifetimeAmount?.[token];
  const perWeek = policy.maxPerWeekAmount?.[token];
  const perMonth = policy.maxPerMonthAmount?.[token];
  if (!lifetime && !perWeek && !perMonth) return;

  const estimate = lifetimeSpendEstimate(cadenceFields, amount, new Date());
  if (lifetime && estimate.bounded && estimate.totalAmount && compareDecimal(estimate.totalAmount, lifetime) > 0) {
    throw new ProtocolError(
      'invalid_request',
      `This schedule would spend up to ${estimate.totalAmount} ${token} total, exceeding your configured lifetime cap of ${lifetime} ${token}.`,
    );
  }
  if (perWeek && compareDecimal(estimate.perWeek, perWeek) > 0) {
    throw new ProtocolError(
      'invalid_request',
      `This schedule would spend up to ${estimate.perWeek} ${token} per week, exceeding your configured cap of ${perWeek} ${token} per week.`,
    );
  }
  if (perMonth && compareDecimal(estimate.perMonth, perMonth) > 0) {
    throw new ProtocolError(
      'invalid_request',
      `This schedule would spend up to ${estimate.perMonth} ${token} per month, exceeding your configured cap of ${perMonth} ${token} per month.`,
    );
  }
}

function compareDecimal(left: string, right: string): number {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function normalizeNotifications(
  value: unknown,
): { inApp?: boolean; webhookUrl?: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_request', 'notifications must be an object.');
  }
  const obj = value as Record<string, unknown>;
  const result: { inApp?: boolean; webhookUrl?: string } = {};
  if (obj.inApp !== undefined) {
    if (typeof obj.inApp !== 'boolean') {
      throw new ProtocolError('invalid_request', 'notifications.inApp must be a boolean.');
    }
    result.inApp = obj.inApp;
  }
  if (obj.webhookUrl !== undefined && obj.webhookUrl !== null && obj.webhookUrl !== '') {
    if (typeof obj.webhookUrl !== 'string') {
      throw new ProtocolError('invalid_request', 'notifications.webhookUrl must be a string.');
    }
    try {
      const parsed = new URL(obj.webhookUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
    } catch {
      throw new ProtocolError('invalid_request', 'notifications.webhookUrl must be a valid http(s) URL.');
    }
    result.webhookUrl = obj.webhookUrl;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeExpiresAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ProtocolError('invalid_request', 'expiresAt must be an ISO timestamp string.');
  }
  const trimmed = value.trim();
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new ProtocolError('invalid_request', 'expiresAt must be a valid ISO timestamp.');
  }
  return trimmed;
}

function normalizeRecurringSchedule(input: {
  cadence: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
}): {
  cadence: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
} {
  if (input.maxOccurrences !== undefined && (!Number.isInteger(input.maxOccurrences) || input.maxOccurrences < 1)) {
    throw new ProtocolError('invalid_request', 'maxOccurrences must be a positive integer when provided.');
  }
  if (input.cadence === 'weekly') {
    if (input.localTime === undefined) {
      throw new ProtocolError('invalid_request', 'localTime is required for weekly recurring payments.');
    }
    if (!Number.isInteger(input.dayOfWeek) || input.dayOfWeek === undefined || input.dayOfWeek < 0 || input.dayOfWeek > 6) {
      throw new ProtocolError('invalid_request', 'dayOfWeek must be an integer from 0 to 6 for weekly recurring payments.');
    }
    return {
      cadence: input.cadence,
      dayOfWeek: input.dayOfWeek,
      localTime: input.localTime,
      ...(input.maxOccurrences !== undefined && { maxOccurrences: input.maxOccurrences }),
    };
  }
  if (input.cadence === 'monthly') {
    if (input.localTime === undefined) {
      throw new ProtocolError('invalid_request', 'localTime is required for monthly recurring payments.');
    }
    if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth === undefined || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
      throw new ProtocolError('invalid_request', 'dayOfMonth must be an integer from 1 to 31 for monthly recurring payments.');
    }
    return {
      cadence: input.cadence,
      dayOfMonth: input.dayOfMonth,
      localTime: input.localTime,
      ...(input.maxOccurrences !== undefined && { maxOccurrences: input.maxOccurrences }),
    };
  }
  if (input.cadence === 'interval_days') {
    if (!Number.isInteger(input.intervalDays) || input.intervalDays === undefined || input.intervalDays < 1 || input.intervalDays > 365) {
      throw new ProtocolError('invalid_request', 'intervalDays must be an integer from 1 to 365 for every-N-days recurring payments.');
    }
    return {
      cadence: input.cadence,
      intervalDays: input.intervalDays,
      ...(input.startAt !== undefined && { startAt: input.startAt }),
      ...(input.maxOccurrences !== undefined && { maxOccurrences: input.maxOccurrences }),
    };
  }
  if (input.cadence === 'interval_hours') {
    if (!Number.isInteger(input.intervalHours) || input.intervalHours === undefined || input.intervalHours < 1 || input.intervalHours > 8760) {
      throw new ProtocolError('invalid_request', 'intervalHours must be an integer from 1 to 8760 for every-N-hours recurring payments.');
    }
    return {
      cadence: input.cadence,
      intervalHours: input.intervalHours,
      ...(input.startAt !== undefined && { startAt: input.startAt }),
      ...(input.maxOccurrences !== undefined && { maxOccurrences: input.maxOccurrences }),
    };
  }
  if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes === undefined || input.intervalMinutes < 1 || input.intervalMinutes > 525600) {
    throw new ProtocolError('invalid_request', 'intervalMinutes must be an integer from 1 to 525600 for every-N-minutes recurring payments.');
  }
  return {
    cadence: input.cadence,
    intervalMinutes: input.intervalMinutes,
    ...(input.startAt !== undefined && { startAt: input.startAt }),
    ...(input.maxOccurrences !== undefined && { maxOccurrences: input.maxOccurrences }),
  };
}

async function readConfiguredTokenBalances(
  connection: Connection,
  owner: PublicKey,
  config: AgentWalletConfig,
): Promise<Array<{ symbol: string; mint: string; amount: string; rawAmount: string }>> {
  const tokens = [];
  for (const token of config.tokens) {
    const ata = await getAssociatedTokenAddress(new PublicKey(token.mint), owner);
    const balance = await connection.getTokenAccountBalance(ata).catch(() => null);
    tokens.push({
      symbol: token.symbol,
      mint: token.mint,
      amount: balance?.value.uiAmountString ?? '0',
      rawAmount: balance?.value.amount ?? '0',
    });
  }
  return tokens;
}

function requireStringParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `Prepared action ${action.id} is missing ${key}.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `${label} is required.`);
  }
  return value.trim();
}

async function checkRpc(rpcUrl: string): Promise<{ ok: boolean; message: string }> {
  try {
    const connection = new Connection(rpcUrl, 'confirmed');
    await connection.getLatestBlockhash('confirmed');
    return { ok: true, message: 'RPC accepted latest-blockhash request.' };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'RPC check failed.',
    };
  }
}

interface NormalizedSwapInput {
  inputMint: string;
  outputMint: string;
  inputSymbol: string;
  outputSymbol: string;
  amountRaw: bigint;
  slippageBps: number;
}

interface ResolvedTokenConfig extends TokenLimitConfig {
  requestToken: string;
  tokenProgramId: PublicKey;
}

async function normalizeSwapInput(
  config: AgentWalletConfig,
  connection: Connection,
  input: SwapInput,
): Promise<NormalizedSwapInput> {
  const inputToken = await resolveSwapToken(config, connection, input.inputToken ?? 'SOL');
  const outputToken = await resolveSwapToken(config, connection, input.outputToken ?? 'USDC');
  const slippageBps = input.slippageBps ?? config.mainnet.maxSlippageBps;
  const amountRaw = parseDecimalAmount(input.amount, inputToken.decimals, `${inputToken.symbol} swap amount`);
  return {
    inputMint: inputToken.mint,
    outputMint: outputToken.mint,
    inputSymbol: inputToken.symbol,
    outputSymbol: outputToken.symbol,
    amountRaw,
    slippageBps,
  };
}

async function resolveSwapToken(
  config: AgentWalletConfig,
  connection: Connection,
  token: string,
): Promise<ResolvedTokenConfig> {
  if (isNativeSolToken(token)) {
    return {
      symbol: 'SOL',
      mint: WSOL_MINT,
      decimals: 9,
      maxTransfer: config.mainnet.maxSwapInput,
      requestToken: 'SOL',
      tokenProgramId: TOKEN_PROGRAM_ID,
    };
  }
  return resolveToken(config, connection, token);
}

async function resolveToken(
  config: AgentWalletConfig,
  connection: Connection,
  token: string,
): Promise<ResolvedTokenConfig> {
  const trimmed = token.trim();
  const known = findKnownToken(config, trimmed);
  const mintText = known?.mint ?? trimmed;
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintText);
  } catch {
    throw new ProtocolError(
      'invalid_request',
      `Token ${token} is not a known symbol. Paste the token mint address.`,
    );
  }
  const account = await connection.getParsedAccountInfo(mint, 'confirmed').catch(() => null);
  const owner = account?.value?.owner;
  const tokenProgramId = owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const parsedData = account?.value?.data;
  const parsed = parsedData && typeof parsedData === 'object' && 'parsed' in parsedData
    ? parsedData.parsed as { info?: { decimals?: unknown } }
    : undefined;
  const decimals = known?.decimals ?? (typeof parsed?.info?.decimals === 'number' ? parsed.info.decimals : undefined);
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
    throw new ProtocolError('invalid_request', `Could not read decimals for token mint ${shortToken(mint.toBase58())}.`);
  }
  const rawMint = mint.toBase58();
  const requestToken = known && known.symbol.toLowerCase() === trimmed.toLowerCase() ? known.symbol : rawMint;
  return {
    symbol: known?.symbol ?? shortToken(rawMint),
    mint: rawMint,
    decimals,
    maxTransfer: known?.maxTransfer ?? '',
    requestToken,
    tokenProgramId,
  };
}

function findKnownToken(config: AgentWalletConfig, token: string): TokenLimitConfig | undefined {
  const normalized = token.toLowerCase();
  return [...config.tokens, ...DEFAULT_TOKEN_REGISTRY].find(
    (entry) => entry.symbol.toLowerCase() === normalized || entry.mint.toLowerCase() === normalized,
  );
}

function isNativeSolToken(token: string): boolean {
  const trimmed = token.trim();
  return trimmed.toUpperCase() === 'SOL' || trimmed === WSOL_MINT;
}

function normalizeTokenIdentifier(token: string): string {
  const trimmed = token.trim();
  return looksLikeMintAddress(trimmed) ? trimmed : trimmed.toUpperCase();
}

function looksLikeMintAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function shortToken(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}

async function fetchJupiterOrder(
  config: AgentWalletConfig,
  taker: string,
  swap: NormalizedSwapInput,
): Promise<Record<string, unknown>> {
  const apiKey = jupiterApiKey(config);
  if (!apiKey) {
    throw new ProtocolError('unauthorized', `Missing Jupiter API key. Set ${config.jupiter.apiKeyEnv} or JUP_API_KEY before using swap tools.`);
  }
  const url = new URL(`${config.jupiter.baseUrl}/order`);
  url.searchParams.set('inputMint', swap.inputMint);
  url.searchParams.set('outputMint', swap.outputMint);
  url.searchParams.set('amount', swap.amountRaw.toString());
  url.searchParams.set('taker', taker);
  url.searchParams.set('slippageBps', swap.slippageBps.toString());
  const response = await fetch(url, { headers: { 'x-api-key': apiKey } });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ProtocolError('wallet_unreachable', `Jupiter order failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function executeJupiterOrder(
  config: AgentWalletConfig,
  signedTransaction: string,
  order: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const apiKey = jupiterApiKey(config);
  if (!apiKey) {
    throw new ProtocolError('unauthorized', `Missing Jupiter API key. Set ${config.jupiter.apiKeyEnv} or JUP_API_KEY.`);
  }
  const requestId = order.requestId;
  if (typeof requestId !== 'string') {
    throw new ProtocolError('invalid_request', 'Jupiter order did not include requestId.');
  }
  const response = await fetch(`${config.jupiter.baseUrl}/execute`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      signedTransaction,
      requestId,
      ...(typeof order.lastValidBlockHeight === 'string' && { lastValidBlockHeight: order.lastValidBlockHeight }),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ProtocolError('wallet_unreachable', `Jupiter execute failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function jupiterApiKey(config: AgentWalletConfig): string | undefined {
  return process.env[config.jupiter.apiKeyEnv]?.trim() || process.env.JUP_API_KEY?.trim() || undefined;
}

function orderSummary(order: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: order.mode,
    router: order.router,
    inputMint: order.inputMint,
    outputMint: order.outputMint,
    inAmount: order.inAmount,
    outAmount: order.outAmount,
    otherAmountThreshold: order.otherAmountThreshold,
    slippageBps: order.slippageBps,
    priceImpact: order.priceImpact,
    requestId: order.requestId,
    hasTransaction: Boolean(order.transaction),
    errorCode: order.errorCode,
    errorMessage: order.errorMessage ?? order.error,
  };
}

async function prepareTransaction(connection: Connection, transaction: Transaction, feePayer: PublicKey): Promise<void> {
  transaction.feePayer = feePayer;
  const latest = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = latest.blockhash;
}

function txToBase64(transaction: Transaction): string {
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

async function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgramId = TOKEN_PROGRAM_ID,
): Promise<PublicKey> {
  const [address] = await PublicKey.findProgramAddress(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function createTransferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
  tokenProgramId = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: tokenProgramId,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function explorerUrl(signature: string, cluster: Cluster): string {
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${signature}${suffix}`;
}
