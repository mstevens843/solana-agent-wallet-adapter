# Agent Prompt: Durable Transaction Ledger Module

Read `TX_SAFETY_SHARED_SPEC.md` first.

This prompt is parallel-safe. It owns only the ledger module and its tests. Do not edit any file outside the write scope.

## Mission

Create a pure browser-demo transaction execution ledger. The ledger persists signed/submitted transaction state before broadcast and makes that state recoverable after refresh. It is the source of truth that prevents accidental double approvals.

This prompt does not integrate the ledger into UI or execution handlers. The browser integration agent will do that separately.

## Write Scope

You may edit only:

- `apps/browser-demo/src/transactionLedger.ts`
- `apps/browser-demo/src/__tests__/transactionLedger.test.ts`

Do not edit:

- `apps/browser-demo/src/main.ts`
- `apps/browser-demo/src/styles.css`
- `apps/browser-demo/src/transactionFailure.ts`
- `apps/browser-demo/src/preSignReview.ts`
- Render server code
- MCP server code
- CLI/desktop code
- package manifests unless a test runner proves a missing dependency

Prefer no new dependencies.

## Required API

Export these names:

```ts
export type ExecutionPhase =
  | 'prepared'
  | 'wallet_opening'
  | 'wallet_signed'
  | 'broadcasting'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'failed'
  | 'ambiguous';

export type ExecutionFailureKind =
  | 'wallet_rejected'
  | 'wallet_unavailable'
  | 'config_missing'
  | 'rpc_timeout'
  | 'rpc_rejected'
  | 'network_unreachable'
  | 'onchain_failed'
  | 'expired_blockhash'
  | 'slippage_or_quote_failed'
  | 'unknown_maybe_submitted';

export interface PendingTransactionRecord {
  id: string;
  actionId: string;
  cluster: string;
  workflowSource: 'browser' | 'cloud' | 'local-bridge';
  kind: string;
  phase: ExecutionPhase;
  walletAddress?: string;
  txid?: string;
  unsignedTransactionHash?: string;
  signedTransactionHash?: string;
  signedTransactionBase64?: string;
  jupiterRequestId?: string;
  attemptCount: number;
  signedAt?: string;
  submittedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  lastError?: string;
  failureKind?: ExecutionFailureKind;
  explorerUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionLedgerDocument {
  version: 1;
  records: PendingTransactionRecord[];
}

export interface PendingTransactionPatch {
  id?: string;
  actionId: string;
  cluster: string;
  workflowSource: PendingTransactionRecord['workflowSource'];
  kind: string;
  phase?: ExecutionPhase;
  walletAddress?: string;
  txid?: string;
  unsignedTransactionHash?: string;
  signedTransactionHash?: string;
  signedTransactionBase64?: string;
  jupiterRequestId?: string;
  attemptCount?: number;
  signedAt?: string;
  submittedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  lastError?: string;
  failureKind?: ExecutionFailureKind;
  explorerUrl?: string;
}

export const TRANSACTION_LEDGER_STORAGE_KEY: string;
export function loadTransactionLedger(storage?: Storage): PendingTransactionRecord[];
export function saveTransactionLedger(records: PendingTransactionRecord[], storage?: Storage): void;
export function upsertPendingTransaction(patch: PendingTransactionPatch, storage?: Storage): PendingTransactionRecord;
export function findPendingTransactionByAction(actionId: string, storage?: Storage): PendingTransactionRecord | undefined;
export function findPendingTransactionByTxid(txid: string, cluster?: string, storage?: Storage): PendingTransactionRecord | undefined;
export function markTransactionPhase(
  id: string,
  phase: ExecutionPhase,
  patch?: Partial<PendingTransactionRecord>,
  storage?: Storage,
): PendingTransactionRecord | undefined;
export function removePendingTransaction(id: string, storage?: Storage): void;
export function pendingTransactionsNeedingReconciliation(
  records?: PendingTransactionRecord[],
  now?: Date,
  storage?: Storage,
): PendingTransactionRecord[];
export function signedTransactionHashFromBase64(signedTransactionBase64: string): Promise<string>;
export function explorerUrlForTxid(txid: string, cluster: string): string;
```

You may add small helper exports if tests need them, but keep the public API focused.

## Storage Contract

- Storage key: `solana-agent-wallet-pending-transactions-v1`
- Stored shape: `{ "version": 1, "records": PendingTransactionRecord[] }`
- Browser-local only. Do not use IndexedDB, server APIs, or cloud storage in this module.
- Reads must tolerate missing, malformed, old, or partially invalid data.
- Invalid records should be dropped, not crash app load.
- Keep at most 100 records.
- Sort newest first by `updatedAt`.
- Do not remove confirmed/failed records during normal save unless trimming old records is required by the 100-record cap.

## Normalization Rules

- `phase` defaults to `prepared`.
- `attemptCount` defaults to `0`.
- `createdAt` and `updatedAt` must be valid ISO strings.
- `actionId`, `cluster`, `workflowSource`, and `kind` are required.
- `id` should be stable. If missing, generate a deterministic-enough local id such as `tx-ledger-${actionId}-${timestamp}`.
- `explorerUrl` should be filled automatically when `txid` exists and caller did not provide it.
- Unknown phases/failure kinds are invalid and should be dropped or normalized conservatively.

## Upsert Rules

`upsertPendingTransaction` must update instead of duplicating when any of these match:

- same `id`
- same non-empty `actionId`
- same non-empty `txid` on the same cluster

When merging:

- Preserve existing `signedTransactionBase64`, `signedTransactionHash`, and `txid` unless caller explicitly provides replacement values.
- Increment/update `attemptCount` only when caller provides it.
- Always refresh `updatedAt`.
- Preserve original `createdAt`.

## Hashing

- `signedTransactionHashFromBase64` returns SHA-256 hex over the signed transaction base64 string.
- Use Web Crypto when available.
- Provide a deterministic fallback for Node/Vitest using `node:crypto` if the browser crypto API is unavailable.
- Do not hash decoded bytes unless every caller and test agrees; the contract is base64 text in, hex out.

## Reconciliation Selection

`pendingTransactionsNeedingReconciliation` should include records with phase:

- `wallet_signed`
- `broadcasting`
- `submitted`
- `confirming`
- `ambiguous`

Exclude:

- `prepared`
- `wallet_opening`
- `confirmed`
- `failed`

Timing:

- Include records with no `nextRetryAt`.
- Include records with `nextRetryAt <= now`.
- Exclude records with `nextRetryAt > now`.
- Always return newest first.

## UX State Support

The integration agent will use the ledger this way:

- Before wallet signature: no ledger record is required.
- After signature and before broadcast: store signed bytes/hash, txid if derivable, phase `wallet_signed`.
- During broadcast retry: phase `broadcasting`, attempt count increments.
- After txid is known/submitted: phase `submitted` or `confirming`.
- If send outcome is unclear: phase `ambiguous`, txid if derivable, error stored.
- Confirmed: phase `confirmed`, `confirmedAt` set.
- Failed: phase `failed`, `failedAt` set, `failureKind` and `lastError` set.

## Tests

Use Vitest. Cover:

- Missing storage returns empty array.
- Malformed storage returns empty array.
- Invalid records are dropped.
- Valid records are normalized and sorted newest first.
- Upsert updates same `id` without duplicating.
- Upsert updates same `actionId` without duplicating.
- Upsert updates same `txid` and cluster without duplicating.
- Upsert preserves txid/signed hash/signed bytes when later patches omit them.
- Reconciliation includes ambiguous/submitted/confirming/wallet_signed/broadcasting.
- Reconciliation excludes confirmed/failed/prepared/wallet_opening.
- Future `nextRetryAt` records are skipped.
- Max record cap trims older records.
- Hash helper produces stable hex output.
- Explorer URL uses Solscan and includes cluster query for non-mainnet clusters.

## Acceptance

Run the browser-demo tests if practical from your environment:

```bash
pnpm -F @solana-agent-wallet-adapter/browser-demo test
```

If this prompt runs in parallel before the other prompts, full project typecheck may fail until all parallel patches are merged. Do not edit outside your write scope to fix cross-prompt imports.

Final response: list only the files changed and the exported API.
