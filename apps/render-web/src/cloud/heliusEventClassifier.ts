import type { PushEventType } from './pushTypes.js';

/**
 * Turn a Helius enhanced transaction into a push event for a specific wallet.
 *
 * Design rule: the DISCRIMINATOR never depends on a program id.
 *
 * What separates "Jupiter automation fired for you" from "you did a swap" is the fee payer — an
 * automation fill is signed and paid for by Jupiter's keeper, not by you. That signal needs no
 * allowlist and cannot go stale. Program ids are used only to REFINE limit-vs-DCA, and when neither
 * matches we still emit a truthful generic "order filled" rather than guessing or dropping the event.
 * So a redeployed/rotated Jupiter program degrades the wording, never the delivery.
 */

// Verified on mainnet (getAccountInfo → executable, BPFLoaderUpgradeable). Identity per Solscan's
// program labels + Jupiter docs. Env-overridable so a program migration is a config change, not a
// redeploy — and see the rule above: a miss here only costs the limit/DCA wording.
export const JUPITER_TRIGGER_PROGRAM_ID = 'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X';
export const JUPITER_DCA_PROGRAM_ID = 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M';

export interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number | string;
}

export interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number | string;
}

export interface HeliusEnhancedTransaction {
  signature?: string;
  type?: string;
  source?: string;
  description?: string;
  feePayer?: string;
  timestamp?: number;
  transactionError?: unknown;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
  instructions?: Array<{ programId?: string; innerInstructions?: Array<{ programId?: string }> }>;
  accountData?: Array<{ account?: string }>;
}

export interface ClassifiedPushEvent {
  type: PushEventType;
  dedupeKey: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface ClassifyOptions {
  triggerProgramId?: string;
  dcaProgramId?: string;
}

/** Every program id in the tx, including inner instructions (where a CPI'd fill actually lives). */
export function programIdsIn(tx: HeliusEnhancedTransaction): Set<string> {
  const ids = new Set<string>();
  for (const ix of tx.instructions ?? []) {
    if (ix.programId) ids.add(ix.programId);
    for (const inner of ix.innerInstructions ?? []) {
      if (inner.programId) ids.add(inner.programId);
    }
  }
  return ids;
}

/** Does this tx touch the wallet at all — as fee payer, a transfer counterparty, or an account key? */
export function txTouchesWallet(tx: HeliusEnhancedTransaction, wallet: string): boolean {
  if (tx.feePayer === wallet) return true;
  for (const transfer of tx.tokenTransfers ?? []) {
    if (transfer.fromUserAccount === wallet || transfer.toUserAccount === wallet) return true;
  }
  for (const transfer of tx.nativeTransfers ?? []) {
    if (transfer.fromUserAccount === wallet || transfer.toUserAccount === wallet) return true;
  }
  return (tx.accountData ?? []).some((entry) => entry.account === wallet);
}

/**
 * Returns undefined when the tx isn't worth a notification for this wallet. Being quiet is the
 * correct default: a phone that buzzes for every incidental account touch is worse than silence.
 */
export function classifyHeliusTransaction(
  tx: HeliusEnhancedTransaction,
  wallet: string,
  options: ClassifyOptions = {},
): ClassifiedPushEvent | undefined {
  const signature = typeof tx.signature === 'string' ? tx.signature : '';
  if (!signature) return undefined;
  if (!txTouchesWallet(tx, wallet)) return undefined;

  const programs = programIdsIn(tx);
  const triggerId = options.triggerProgramId ?? JUPITER_TRIGGER_PROGRAM_ID;
  const dcaId = options.dcaProgramId ?? JUPITER_DCA_PROGRAM_ID;
  const received = netReceived(tx, wallet);
  const spent = netSpent(tx, wallet);

  // A tx the wallet did NOT pay for, that moved value to it, via Jupiter's automation programs.
  // The keeper — not the user — is the fee payer, which is precisely what makes this an "it fired
  // while you were away" event rather than something the user just watched happen in-app.
  const automation = tx.feePayer !== wallet && (programs.has(triggerId) || programs.has(dcaId));
  if (automation) {
    const isDca = programs.has(dcaId) && !programs.has(triggerId);
    const type: PushEventType = isDca ? 'jupiter.recurring.filled' : 'jupiter.trigger.filled';
    return {
      type,
      dedupeKey: signature,
      title: isDca ? 'DCA order filled' : 'Limit order filled',
      body: swapSummary(spent, received) ?? (isDca ? 'Your recurring order executed.' : 'Your limit order executed.'),
      data: { signature, tab: 'positions', section: 'orders' },
    };
  }

  // The wallet's own transaction. The app already toasts this when it's open; push is what covers the
  // case where it isn't. `transactionError` is Helius's post-parse failure marker.
  if (tx.feePayer === wallet) {
    const failed = Boolean(tx.transactionError);
    return {
      type: failed ? 'tx.failed' : 'tx.confirmed',
      dedupeKey: signature,
      title: failed ? 'Transaction failed' : 'Transaction confirmed',
      body: failed
        ? shortSignature(signature)
        : swapSummary(spent, received) ?? describeOrShort(tx, signature),
      data: { signature, tab: 'completed' },
    };
  }

  // Someone else's tx that merely mentions the wallet (an airdrop-spam mint, a shared LP account, a
  // program that happens to list it). Not ours to interrupt the user for.
  return undefined;
}

function netReceived(tx: HeliusEnhancedTransaction, wallet: string): { amount: number; mint: string } | undefined {
  for (const transfer of tx.tokenTransfers ?? []) {
    const amount = numeric(transfer.tokenAmount);
    if (transfer.toUserAccount === wallet && amount > 0 && transfer.mint) return { amount, mint: transfer.mint };
  }
  return undefined;
}

function netSpent(tx: HeliusEnhancedTransaction, wallet: string): { amount: number; mint: string } | undefined {
  for (const transfer of tx.tokenTransfers ?? []) {
    const amount = numeric(transfer.tokenAmount);
    if (transfer.fromUserAccount === wallet && amount > 0 && transfer.mint) return { amount, mint: transfer.mint };
  }
  return undefined;
}

function swapSummary(
  spent: { amount: number; mint: string } | undefined,
  received: { amount: number; mint: string } | undefined,
): string | undefined {
  if (spent && received) return `${formatAmount(spent.amount)} ${symbolFor(spent.mint)} → ${formatAmount(received.amount)} ${symbolFor(received.mint)}`;
  if (received) return `Received ${formatAmount(received.amount)} ${symbolFor(received.mint)}`;
  if (spent) return `Sent ${formatAmount(spent.amount)} ${symbolFor(spent.mint)}`;
  return undefined;
}

/** Helius `description` is already human-readable; it beats a bare signature when we have it. */
function describeOrShort(tx: HeliusEnhancedTransaction, signature: string): string {
  const description = typeof tx.description === 'string' ? tx.description.trim() : '';
  return description ? description.slice(0, 140) : shortSignature(signature);
}

function shortSignature(signature: string): string {
  return signature.length > 12 ? `${signature.slice(0, 6)}…${signature.slice(-4)}` : signature;
}

// Only the handful of mints a notification body is likely to name. Anything else degrades to a
// truncated mint rather than pulling a token list into the webhook hot path.
const KNOWN_MINTS: Readonly<Record<string, string>> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
};

function symbolFor(mint: string): string {
  return KNOWN_MINTS[mint] ?? (mint.length > 8 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint);
}

function formatAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  if (amount > 0 && amount < 1) return String(Number(amount.toPrecision(4)));
  return amount.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function numeric(value: number | string | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
