# Agent Prompt: Transaction Failure Classification Module

Read `TX_SAFETY_SHARED_SPEC.md` first.

This prompt is parallel-safe. It owns only the failure-classification module and its tests. Do not edit any file outside the write scope.

## Mission

Create a pure transaction failure-classification module for browser transaction execution. It must distinguish wallet rejection, missing config, retryable RPC/network failures, ambiguous submitted states, simulation/preflight failures, expired blockhash, slippage/quote failures, and confirmed on-chain failures.

The browser integration agent will use this module to decide whether to restore the approve button, retry the same signed transaction, check chain status, or keep an action locked behind `Check confirmation`.

## Write Scope

You may edit only:

- `apps/browser-demo/src/transactionFailure.ts`
- `apps/browser-demo/src/__tests__/transactionFailure.test.ts`

Do not edit:

- `apps/browser-demo/src/main.ts`
- `apps/browser-demo/src/styles.css`
- `apps/browser-demo/src/transactionLedger.ts`
- `apps/browser-demo/src/preSignReview.ts`
- Render server code
- MCP server code
- CLI/desktop code
- package manifests unless a test runner proves a missing dependency

Prefer no new dependencies.

## Required API

Export these names:

```ts
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

export function classifyTransactionFailure(err: unknown, context?: { hasSignedBytes?: boolean; txid?: string }): ClassifiedTransactionFailure;
export function shouldRetrySignedBroadcast(err: unknown): boolean;
export function shouldCheckChainBeforeFailing(err: unknown): boolean;
export function transactionFailureToastCopy(result: ClassifiedTransactionFailure): { title: string; message: string };
export function normalizeErrorMessage(err: unknown): string;
```

You may add small helper exports if tests need them, but keep the public API focused.

## Classification Rules

### Wallet Rejected

Match strings and wallet errors that contain:

- user rejected
- user denied
- rejected by user
- cancelled
- canceled
- approval denied
- wallet declined
- request rejected

Return:

- `kind: 'wallet_rejected'`
- `retryableSignedBroadcast: false`
- `maybeSubmitted: false`
- `safeToAskWalletAgain: true`
- `shouldCheckChainBeforeFailing: false`
- title: `Wallet approval rejected`

### Wallet Unavailable

Match:

- wallet not connected
- no wallet selected
- wallet unavailable
- adapter unavailable
- unsupported wallet method
- signTransaction not supported
- signAndSendTransaction not supported

Return:

- `kind: 'wallet_unavailable'`
- `retryableSignedBroadcast: false`
- `maybeSubmitted: false`
- `safeToAskWalletAgain: true`

### Config Missing

Match:

- missing RPC URL
- missing Helius
- missing Jupiter
- missing JUP API key
- missing API key
- transaction execution is not configured
- unauthorized setup
- environment variable missing

Return:

- `kind: 'config_missing'`
- `retryableSignedBroadcast: false`
- `maybeSubmitted: false`
- `safeToAskWalletAgain: false`
- title: `Transaction execution not configured`
- message: `Transaction execution is not configured. Add RPC/Jupiter setup before trying again.`

### Retryable RPC/Network

Match:

- timeout
- timed out
- aborted
- failed fetch
- network error
- ECONNRESET
- ETIMEDOUT
- ENOTFOUND
- 429
- rate limit
- 500
- 502
- 503
- 504
- gateway timeout
- service unavailable

Return:

- `kind: 'rpc_timeout'`, `network_unreachable`, or `rate_limited`
- `retryableSignedBroadcast: true`
- `maybeSubmitted: true` when `context.hasSignedBytes` or `context.txid` is true
- `safeToAskWalletAgain: false`
- `shouldCheckChainBeforeFailing: true`

This is the main class where retrying is allowed, but only by rebroadcasting the exact same signed bytes.

### Already Processed / Duplicate Signature

Match:

- already processed
- transaction already processed
- duplicate signature
- already been processed

Return:

- `kind: 'unknown_maybe_submitted'`
- `retryableSignedBroadcast: false`
- `maybeSubmitted: true`
- `safeToAskWalletAgain: false`
- `shouldCheckChainBeforeFailing: true`

### Simulation / Preflight Failed

Match:

- simulation failed
- preflight failure
- transaction simulation failed
- custom program error
- InstructionError

Return:

- `kind: 'simulation_failed'` unless the message clearly says final chain status failed
- `retryableSignedBroadcast: false`
- `maybeSubmitted: false` if before send; true if `context.txid` is present
- `safeToAskWalletAgain: true` only when no signature/txid exists

### On-Chain Failed

Use this when a signature status response returned an error or the message says chain/finalized status failed.

Return:

- `kind: 'onchain_failed'`
- `retryableSignedBroadcast: false`
- `maybeSubmitted: true`
- `safeToAskWalletAgain: false`
- `shouldCheckChainBeforeFailing: false`
- title: `Transaction failed on-chain`
- message: `The transaction reached chain status and failed. Review the error before retrying.`

### Expired Blockhash

Match:

- blockhash not found
- block height exceeded
- last valid block height exceeded
- expired blockhash

Return:

- `kind: 'expired_blockhash'`
- `retryableSignedBroadcast: false`
- `maybeSubmitted: Boolean(context.txid)`
- `safeToAskWalletAgain: false`
- `shouldCheckChainBeforeFailing: Boolean(context.txid)`

Do not classify this as safe to automatically re-sign. The UI can let the user explicitly retry only after showing the expired/unknown status.

### Slippage / Quote Failure

Match:

- slippage
- output threshold
- route not found
- quote expired
- no route
- Jupiter execute failed
- price impact

Return:

- `kind: 'slippage_or_quote_failed'`
- `retryableSignedBroadcast: false`
- `maybeSubmitted: Boolean(context.txid || context.hasSignedBytes)`
- `safeToAskWalletAgain: !context.hasSignedBytes && !context.txid`

### Insufficient Funds

Match:

- insufficient funds
- insufficient lamports
- account does not have enough

Return:

- `kind: 'insufficient_funds'`
- `retryableSignedBroadcast: false`
- `maybeSubmitted: false`
- `safeToAskWalletAgain: true`

### Invalid Transaction

Match:

- signature verification failed
- failed to sanitize
- invalid transaction
- transaction too large
- versioned transaction not supported

Return:

- `kind: 'invalid_transaction'`
- `retryableSignedBroadcast: false`
- `maybeSubmitted: false`
- `safeToAskWalletAgain: false`

### Unknown

Default behavior:

- If context has signed bytes or txid: `unknown_maybe_submitted`, `maybeSubmitted: true`, `safeToAskWalletAgain: false`, `shouldCheckChainBeforeFailing: true`.
- If context has no signed bytes and no txid: `unknown_maybe_submitted`, `maybeSubmitted: false`, `safeToAskWalletAgain: true`.

Never show generic `Transaction failed` for unknown send/broadcast errors after signing.

## UX Copy

Messages must be short and precise.

- Ambiguous title: `Submitted status unknown`
- Ambiguous message: `The app is checking the original transaction before allowing another approval.`
- Retry message: `Retrying only the same signed transaction. Do not approve this request again.`
- Config message: `Transaction execution is not configured. Add RPC/Jupiter setup before trying again.`
- On-chain message: `The transaction reached chain status and failed. Review the error before retrying.`

`transactionFailureToastCopy` should return copy that matches the classification and never hides ambiguity.

## Tests

Use Vitest. Cover:

- Wallet rejection strings.
- Wallet unavailable strings.
- Missing Jupiter/RPC/config strings.
- Fetch/network timeout strings.
- HTTP 429/500/502/503/504 strings.
- Already processed / duplicate signature strings.
- Blockhash expired strings.
- Simulation failed strings.
- On-chain failed with txid/status context.
- Slippage/quote strings.
- Insufficient funds strings.
- Invalid transaction strings.
- Unknown error before signing.
- Unknown error after signed bytes.
- `shouldRetrySignedBroadcast` true only for retryable same-signed-bytes classes.
- `shouldCheckChainBeforeFailing` true for ambiguous submitted classes.

## Acceptance

Run the browser-demo tests if practical from your environment:

```bash
pnpm -F @solana-agent-wallet-adapter/browser-demo test
```

If this prompt runs in parallel before the other prompts, full project typecheck may fail until all parallel patches are merged. Do not edit outside your write scope to fix cross-prompt imports.

Final response: list only the files changed and the exported API.
