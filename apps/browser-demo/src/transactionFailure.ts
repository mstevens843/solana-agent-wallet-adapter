/**
 * Transaction failure classification for browser-demo execution.
 *
 * Pure, dependency-free module. Given an arbitrary error thrown during a
 * Solana transaction flow, return a structured classification that the UI
 * layer can use to decide whether to:
 *
 *   - Restore the approve/send button (safe to ask wallet again).
 *   - Retry only the same signed-transaction bytes (no new wallet prompt).
 *   - Check chain status before declaring failure (ambiguous submitted).
 *   - Lock the action behind "Check confirmation" and stop prompting.
 *
 * Safety invariant: once a wallet signature may have happened (the caller
 * passes `hasSignedBytes` or `txid` in the context), this module MUST NEVER
 * return `safeToAskWalletAgain: true`, except for unambiguously pre-signature
 * error classes (wallet_rejected, wallet_unavailable, etc. — see classifier
 * branches below). When in doubt, treat the failure as
 * `unknown_maybe_submitted` and require an on-chain check.
 */

export type TransactionFailureKind =
  | 'wallet_rejected'
  | 'wallet_unavailable'
  | 'config_missing'
  | 'rpc_timeout'
  | 'rpc_rejected'
  | 'network_unreachable'
  | 'onchain_failed'
  | 'expired_blockhash'
  | 'slippage_or_quote_failed'
  | 'simulation_failed'
  | 'insufficient_funds'
  | 'invalid_transaction'
  | 'rate_limited'
  | 'unknown_maybe_submitted';

export interface ClassifiedTransactionFailure {
  kind: TransactionFailureKind;
  title: string;
  message: string;
  technicalMessage: string;
  retryableSignedBroadcast: boolean;
  maybeSubmitted: boolean;
  safeToAskWalletAgain: boolean;
  shouldCheckChainBeforeFailing: boolean;
}

export interface TransactionFailureContext {
  hasSignedBytes?: boolean;
  txid?: string;
}

const TITLE_BY_KIND: Record<TransactionFailureKind, string> = {
  wallet_rejected: 'Wallet approval rejected',
  wallet_unavailable: 'Wallet unavailable',
  config_missing: 'Transaction execution not configured',
  rpc_timeout: 'Transaction send timed out',
  rpc_rejected: 'Transaction send rejected',
  network_unreachable: 'Network unreachable',
  onchain_failed: 'Transaction failed on-chain',
  expired_blockhash: 'Transaction blockhash expired',
  slippage_or_quote_failed: 'Quote or slippage failed',
  simulation_failed: 'Transaction simulation failed',
  insufficient_funds: 'Insufficient funds',
  invalid_transaction: 'Invalid transaction',
  rate_limited: 'Rate limited',
  unknown_maybe_submitted: 'Transaction status pending',
};

const AMBIGUOUS_TITLE = 'Transaction status pending';
const AMBIGUOUS_MESSAGE = 'The signed transaction is being checked. Use Check confirmation or Solscan before retrying.';
const RETRY_MESSAGE = 'Retrying only the same signed transaction. No second wallet approval is needed.';
const CONFIG_MESSAGE = 'Transaction execution is not configured. Add RPC/Jupiter setup before trying again.';
const ONCHAIN_MESSAGE = 'The transaction reached chain status and failed. Review the error before retrying.';

// Pattern groups. Each group is an array of lowercased substrings that
// indicate the failure class when present in the normalized error message.
// Groups are tested in priority order in the classifier below.

const WALLET_REJECTED_PATTERNS = [
  'user rejected',
  'user denied',
  'rejected by user',
  'cancelled',
  'canceled',
  'approval denied',
  'wallet declined',
  'request rejected',
];

const WALLET_UNAVAILABLE_PATTERNS = [
  'wallet not connected',
  'no wallet selected',
  'wallet unavailable',
  'adapter unavailable',
  'unsupported wallet method',
  'signtransaction not supported',
  'signandsendtransaction not supported',
];

const CONFIG_MISSING_PATTERNS = [
  'missing rpc url',
  'missing helius',
  'missing jupiter',
  'missing jup api key',
  'missing api key',
  'transaction execution is not configured',
  'unauthorized setup',
  'environment variable missing',
];

const ALREADY_PROCESSED_PATTERNS = [
  'already processed',
  'transaction already processed',
  'duplicate signature',
  'already been processed',
];

const EXPIRED_BLOCKHASH_PATTERNS = [
  'blockhash not found',
  'block height exceeded',
  'last valid block height exceeded',
  'expired blockhash',
];

const SIMULATION_FAILED_PATTERNS = [
  'simulation failed',
  'preflight failure',
  'transaction simulation failed',
  'custom program error',
  'instructionerror',
];

const ONCHAIN_FAILED_PATTERNS = [
  'chain status failed',
  'finalized status failed',
  'transaction failed on-chain',
  'transaction failed on chain',
  'on-chain failure',
];

const SLIPPAGE_OR_QUOTE_PATTERNS = [
  'slippage',
  'output threshold',
  'route not found',
  'quote expired',
  'no route',
  'jupiter execute failed',
  'price impact',
];

const INSUFFICIENT_FUNDS_PATTERNS = [
  'insufficient funds',
  'insufficient lamports',
  'account does not have enough',
];

const INVALID_TRANSACTION_PATTERNS = [
  'signature verification failed',
  'failed to sanitize',
  'invalid transaction',
  'transaction too large',
  'versioned transaction not supported',
];

// Wormhole SDK throws this from getAccountData(info) when a Wormhole PDA fetch returns null —
// e.g. routing a Solana-native mint through the legacy AutomaticTokenBridge relayer. Treat as a
// pre-signature route-availability failure: no wallet prompt happened, recreating the draft is
// the remediation.
const BRIDGE_ACCOUNT_NULL_PATTERNS = ['account info is null'];

const RATE_LIMITED_PATTERNS = ['429', 'rate limit', 'too many requests'];

// HTTP 5xx and gateway markers.
const SERVER_5XX_PATTERNS = [
  ' 500 ',
  ' 502 ',
  ' 503 ',
  ' 504 ',
  'http 500',
  'http 502',
  'http 503',
  'http 504',
  'status 500',
  'status 502',
  'status 503',
  'status 504',
  'gateway timeout',
  'service unavailable',
  'bad gateway',
];

const TIMEOUT_PATTERNS = ['timeout', 'timed out', 'aborted', 'etimedout'];

const NETWORK_UNREACHABLE_PATTERNS = [
  'failed fetch',
  'failed to fetch',
  'network error',
  'econnreset',
  'enotfound',
  'econnrefused',
  'dns lookup failed',
  'fetch error',
];

/**
 * Classify any thrown error into a structured execution-failure result.
 *
 * @param err - The thrown value. Anything: Error, string, object, undefined.
 * @param context - Execution context:
 *   - `hasSignedBytes`: a wallet signature has happened; we hold the signed bytes.
 *   - `txid`: a transaction signature is known and may exist on-chain.
 */
export function classifyTransactionFailure(
  err: unknown,
  context: TransactionFailureContext = {},
): ClassifiedTransactionFailure {
  const technicalMessage = normalizeErrorMessage(err);
  const matchText = technicalMessage.toLowerCase();
  const hasSignedBytes = Boolean(context.hasSignedBytes);
  const txid = typeof context.txid === 'string' && context.txid.trim().length > 0 ? context.txid : '';
  const hasSignedOrTxid = hasSignedBytes || Boolean(txid);

  // Priority-ordered single-pass classification. Earlier branches win.

  // 1. Wallet rejected. Always pre-signature: a wallet rejection means
  //    the user said no in the wallet popup. Safe to ask wallet again.
  if (matchAny(matchText, WALLET_REJECTED_PATTERNS)) {
    return {
      kind: 'wallet_rejected',
      title: TITLE_BY_KIND.wallet_rejected,
      message: 'Wallet approval was rejected. You can try approving again when ready.',
      technicalMessage,
      retryableSignedBroadcast: false,
      maybeSubmitted: false,
      safeToAskWalletAgain: true,
      shouldCheckChainBeforeFailing: false,
    };
  }

  // 2. Wallet unavailable. Pre-signature setup problem.
  if (matchAny(matchText, WALLET_UNAVAILABLE_PATTERNS)) {
    return {
      kind: 'wallet_unavailable',
      title: TITLE_BY_KIND.wallet_unavailable,
      message: 'No wallet is available. Connect a supported wallet and try again.',
      technicalMessage,
      retryableSignedBroadcast: false,
      maybeSubmitted: false,
      safeToAskWalletAgain: true,
      shouldCheckChainBeforeFailing: false,
    };
  }

  // 3. Config missing. Pre-signature setup problem; do not prompt wallet.
  if (matchAny(matchText, CONFIG_MISSING_PATTERNS)) {
    return {
      kind: 'config_missing',
      title: TITLE_BY_KIND.config_missing,
      message: CONFIG_MESSAGE,
      technicalMessage,
      retryableSignedBroadcast: false,
      maybeSubmitted: false,
      safeToAskWalletAgain: false,
      shouldCheckChainBeforeFailing: false,
    };
  }

  // 4. Already processed / duplicate signature. This is reported by RPC when
  //    the same signed bytes are sent twice. It strongly implies the original
  //    transaction is already on-chain — check status, do not re-sign.
  if (matchAny(matchText, ALREADY_PROCESSED_PATTERNS)) {
    return {
      kind: 'unknown_maybe_submitted',
      title: AMBIGUOUS_TITLE,
      message: AMBIGUOUS_MESSAGE,
      technicalMessage,
      retryableSignedBroadcast: false,
      maybeSubmitted: true,
      safeToAskWalletAgain: false,
      shouldCheckChainBeforeFailing: true,
    };
  }

  // 5. Expired blockhash. Do not silently re-sign. If a txid is known the
  //    transaction may have landed before expiry; check chain first.
  if (matchAny(matchText, EXPIRED_BLOCKHASH_PATTERNS)) {
    const maybeSubmitted = Boolean(txid);
    return {
      kind: 'expired_blockhash',
      title: TITLE_BY_KIND.expired_blockhash,
      message: maybeSubmitted
        ? AMBIGUOUS_MESSAGE
        : 'The transaction blockhash expired before send. You can try again.',
      technicalMessage,
      retryableSignedBroadcast: false,
      maybeSubmitted,
      // Never ask the wallet again automatically after blockhash expiry —
      // the UI must show the expired/unknown status first.
      safeToAskWalletAgain: false,
      shouldCheckChainBeforeFailing: maybeSubmitted,
    };
  }

  // 6. Explicit on-chain failure (chain/finalized status said failed). This
  //    must take precedence over simulation patterns: a real chain failure is
  //    final. Detect via explicit on-chain markers OR a txid+InstructionError
  //    pattern.
  if (
    matchAny(matchText, ONCHAIN_FAILED_PATTERNS) ||
    (txid && matchAny(matchText, SIMULATION_FAILED_PATTERNS))
  ) {
    return {
      kind: 'onchain_failed',
      title: TITLE_BY_KIND.onchain_failed,
      message: ONCHAIN_MESSAGE,
      technicalMessage,
      retryableSignedBroadcast: false,
      maybeSubmitted: true,
      safeToAskWalletAgain: false,
      shouldCheckChainBeforeFailing: false,
    };
  }

  // 7. Simulation / preflight failure. Pre-signature unless a txid says
  //    otherwise (handled above).
  if (matchAny(matchText, SIMULATION_FAILED_PATTERNS)) {
    return {
      kind: 'simulation_failed',
      title: TITLE_BY_KIND.simulation_failed,
      message: 'Simulation rejected the transaction. Adjust parameters and try again.',
      technicalMessage,
      retryableSignedBroadcast: false,
      maybeSubmitted: false,
      // Only safe to ask wallet again when no signature/txid exists.
      safeToAskWalletAgain: !hasSignedOrTxid,
      shouldCheckChainBeforeFailing: false,
    };
  }

  // 8. Slippage / quote failure. Usually pre-sign in Jupiter flows. If signed
  //    bytes or txid exist this is ambiguous and must not re-prompt the wallet.
  if (matchAny(matchText, SLIPPAGE_OR_QUOTE_PATTERNS)) {
    const maybeSubmitted = hasSignedOrTxid;
    return {
      kind: 'slippage_or_quote_failed',
      title: TITLE_BY_KIND.slippage_or_quote_failed,
      message: maybeSubmitted
        ? AMBIGUOUS_MESSAGE
        : 'Quote or slippage check failed. Refresh the quote and try again.',
      technicalMessage,
      retryableSignedBroadcast: false,
      maybeSubmitted,
      safeToAskWalletAgain: !hasSignedOrTxid,
      shouldCheckChainBeforeFailing: false,
    };
  }

  // 9. Insufficient funds. Pre-signature: the wallet would not be able to
  //    sign anyway. Safe to ask again once the user funds the wallet.
  if (matchAny(matchText, INSUFFICIENT_FUNDS_PATTERNS)) {
    return {
      kind: 'insufficient_funds',
      title: TITLE_BY_KIND.insufficient_funds,
      message: 'Insufficient funds for the transaction. Add funds and try again.',
      technicalMessage,
      retryableSignedBroadcast: false,
      maybeSubmitted: false,
      safeToAskWalletAgain: true,
      shouldCheckChainBeforeFailing: false,
    };
  }

  // 10. Invalid transaction. The transaction is structurally bad and cannot
  //     be re-signed safely. Lock the action.
  if (matchAny(matchText, INVALID_TRANSACTION_PATTERNS)) {
    return {
      kind: 'invalid_transaction',
      title: TITLE_BY_KIND.invalid_transaction,
      message: 'The transaction was rejected as invalid. Rebuild and try again.',
      technicalMessage,
      retryableSignedBroadcast: false,
      maybeSubmitted: false,
      safeToAskWalletAgain: false,
      shouldCheckChainBeforeFailing: false,
    };
  }

  // 10b. Wormhole bridge PDA missing (legacy relayer mis-routed this token). Pre-signature.
  if (matchAny(matchText, BRIDGE_ACCOUNT_NULL_PATTERNS)) {
    return {
      kind: 'invalid_transaction',
      title: 'Bridge route not available',
      message: 'This token cannot be bridged via the automatic relayer. Recreate the draft to use the manual Token Bridge route.',
      technicalMessage,
      retryableSignedBroadcast: false,
      maybeSubmitted: false,
      safeToAskWalletAgain: false,
      shouldCheckChainBeforeFailing: false,
    };
  }

  // 11. Rate limited. Same signed bytes can be rebroadcast after a delay.
  if (matchAny(matchText, RATE_LIMITED_PATTERNS)) {
    return ambiguousNetworkResult('rate_limited', technicalMessage, hasSignedOrTxid);
  }

  // 12. Server 5xx. Same signed bytes can be rebroadcast.
  if (matchAny(matchText, SERVER_5XX_PATTERNS)) {
    return ambiguousNetworkResult('network_unreachable', technicalMessage, hasSignedOrTxid);
  }

  // 13. Timeout. Same signed bytes can be rebroadcast.
  if (matchAny(matchText, TIMEOUT_PATTERNS)) {
    return ambiguousNetworkResult('rpc_timeout', technicalMessage, hasSignedOrTxid);
  }

  // 14. Network unreachable. Same signed bytes can be rebroadcast.
  if (matchAny(matchText, NETWORK_UNREACHABLE_PATTERNS)) {
    return ambiguousNetworkResult('network_unreachable', technicalMessage, hasSignedOrTxid);
  }

  // 15. Unknown fallback. Never show generic "Transaction failed" once a
  //     signature might exist: treat as `unknown_maybe_submitted` and require
  //     on-chain check.
  if (hasSignedOrTxid) {
    return {
      kind: 'unknown_maybe_submitted',
      title: AMBIGUOUS_TITLE,
      message: AMBIGUOUS_MESSAGE,
      technicalMessage,
      retryableSignedBroadcast: true,
      maybeSubmitted: true,
      safeToAskWalletAgain: false,
      shouldCheckChainBeforeFailing: true,
    };
  }

  return {
    kind: 'unknown_maybe_submitted',
    title: 'Transaction error',
    message: technicalMessage || 'The transaction could not be completed. Try again.',
    technicalMessage,
    retryableSignedBroadcast: false,
    maybeSubmitted: false,
    safeToAskWalletAgain: true,
    shouldCheckChainBeforeFailing: false,
  };
}

/**
 * True only for failure classes where rebroadcasting the EXACT SAME signed
 * transaction bytes is safe. Never true for wallet-side failures, on-chain
 * failures, expired blockhash, slippage, simulation, insufficient funds,
 * invalid transaction, or unknown errors without signed bytes.
 *
 * Signature accepts an `unknown` error directly; internally classifies it
 * without a context so integration callers that have richer context may
 * prefer `classifyTransactionFailure(err, ctx).retryableSignedBroadcast`.
 */
export function shouldRetrySignedBroadcast(err: unknown): boolean {
  const classified = classifyTransactionFailure(err);
  switch (classified.kind) {
    case 'rpc_timeout':
    case 'network_unreachable':
    case 'rate_limited':
      return true;
    case 'unknown_maybe_submitted':
      // With an empty context the classifier sets retryableSignedBroadcast
      // to false for the no-signed-bytes branch. Trust the classifier's
      // structural decision rather than re-deriving it here.
      return classified.retryableSignedBroadcast;
    default:
      return false;
  }
}

/**
 * True for ambiguous failure classes that may have landed on chain. Caller
 * should consult signature status before declaring failure or prompting again.
 */
export function shouldCheckChainBeforeFailing(err: unknown): boolean {
  const classified = classifyTransactionFailure(err);
  return classified.shouldCheckChainBeforeFailing;
}

/**
 * Produce toast copy for user-facing execution errors. Ambiguous outcomes
 * must stay in pending status and point the user at confirmation/Solscan
 * instead of sounding like a hard failure.
 */
export function transactionFailureToastCopy(result: ClassifiedTransactionFailure): {
  title: string;
  message: string;
} {
  // Only show the "signed transaction is being checked" copy when there is an
  // actual possibility a transaction was submitted. The fallback `unknown_maybe_submitted`
  // kind also fires for pre-sign errors (e.g., dispatcher refused, validation failed) —
  // in those cases the wallet never opened and the user must see the real error.
  if (result.maybeSubmitted) {
    if (result.kind === 'onchain_failed') {
      return { title: TITLE_BY_KIND.onchain_failed, message: ONCHAIN_MESSAGE };
    }
    if (result.retryableSignedBroadcast) {
      return { title: AMBIGUOUS_TITLE, message: RETRY_MESSAGE };
    }
    return { title: AMBIGUOUS_TITLE, message: AMBIGUOUS_MESSAGE };
  }
  if (result.kind === 'config_missing') {
    return { title: TITLE_BY_KIND.config_missing, message: CONFIG_MESSAGE };
  }
  if (result.kind === 'onchain_failed') {
    return { title: TITLE_BY_KIND.onchain_failed, message: ONCHAIN_MESSAGE };
  }
  return { title: result.title, message: result.message };
}

/**
 * Convert any thrown value to a short, secret-redacted display string.
 *
 * Behaviour:
 *   - Preserves the original casing for display.
 *   - Drops anything that looks like a stack trace.
 *   - Redacts obvious secret patterns: `api-key=...`, `apiKey=...`,
 *     `Bearer ...`, `secret=...`, `token=...`, and `?...api-key=...`
 *     query strings on RPC URLs.
 *   - Collapses runaway whitespace and truncates extremely long output.
 */
export function normalizeErrorMessage(err: unknown): string {
  const raw = extractRawMessage(err);
  if (!raw) return '';
  const noStack = stripStackTrace(raw);
  const redacted = redactSecrets(noStack);
  const collapsed = redacted.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_MESSAGE_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

const MAX_MESSAGE_LENGTH = 400;

function extractRawMessage(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return String(err);
  }
  if (err instanceof Error) {
    return err.message || err.name || '';
  }
  if (typeof err === 'object') {
    const candidate = err as { message?: unknown; error?: unknown; reason?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.length > 0) {
      return candidate.message;
    }
    if (typeof candidate.error === 'string' && candidate.error.length > 0) {
      return candidate.error;
    }
    if (typeof candidate.reason === 'string' && candidate.reason.length > 0) {
      return candidate.reason;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return '';
    }
  }
  return '';
}

function stripStackTrace(value: string): string {
  // Anything from the first "    at " stack frame onwards is a stack trace.
  // Also strip from a line that starts with "Error:" if it is on its own line
  // mid-string (multiline error toStrings).
  const stackIndex = value.search(/\n\s+at\s+/);
  if (stackIndex >= 0) {
    return value.slice(0, stackIndex);
  }
  return value;
}

function redactSecrets(value: string): string {
  let out = value;
  // helius-style RPC api-key query params: ?api-key=xxxx or &api-key=xxxx.
  out = out.replace(/([?&](?:api[-_]?key|apikey))=([^\s&"']+)/gi, '$1=[redacted]');
  // Generic `apiKey=...` body params.
  out = out.replace(/\b(api[-_]?key)\s*=\s*([^\s&"',;]+)/gi, '$1=[redacted]');
  // Bearer tokens.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]');
  // secret=... key=value forms.
  out = out.replace(/\b(secret|token|password|passwd|pwd)\s*=\s*([^\s&"',;]+)/gi, '$1=[redacted]');
  // Helius hostnames with key in path: e.g. https://rpc.helius.xyz/?api-key=...
  out = out.replace(/(helius[a-z0-9.\-]*\/[^\s]*api[-_]?key=)([^\s&"']+)/gi, '$1[redacted]');
  return out;
}

function ambiguousNetworkResult(
  kind: Extract<TransactionFailureKind, 'rpc_timeout' | 'network_unreachable' | 'rate_limited'>,
  technicalMessage: string,
  hasSignedOrTxid: boolean,
): ClassifiedTransactionFailure {
  const titlesByKind: Record<typeof kind, string> = {
    rpc_timeout: TITLE_BY_KIND.rpc_timeout,
    network_unreachable: TITLE_BY_KIND.network_unreachable,
    rate_limited: TITLE_BY_KIND.rate_limited,
  };
  return {
    kind,
    title: hasSignedOrTxid ? AMBIGUOUS_TITLE : titlesByKind[kind],
    message: hasSignedOrTxid ? RETRY_MESSAGE : 'Network or RPC error. The app will retry the send.',
    technicalMessage,
    retryableSignedBroadcast: true,
    maybeSubmitted: hasSignedOrTxid,
    // Never ask the wallet again automatically once signed bytes or a txid
    // exist for an ambiguous network failure.
    safeToAskWalletAgain: false,
    shouldCheckChainBeforeFailing: true,
  };
}

function matchAny(haystack: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (haystack.includes(pattern)) return true;
  }
  return false;
}
