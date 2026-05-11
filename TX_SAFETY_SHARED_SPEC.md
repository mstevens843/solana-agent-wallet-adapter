# Shared Spec: Transaction Execution Safety

This file is the contract for the transaction-safety work. Every agent prompt in this group must read this first.

All agent prompts in this set are written to be executable in parallel. They use disjoint write scopes. The only coordination point is merge-time verification: once all patches are present together, run the browser-demo typecheck, tests, and build.

## Parallel Prompt Set

Run these at the same time if desired:

- `AGENT_PROMPT_TX_LEDGER_MODULE.md`
- `AGENT_PROMPT_FAILURE_CLASSIFICATION_MODULE.md`
- `AGENT_PROMPT_PRESIGN_REVIEW_MODULE.md`
- `AGENT_PROMPT_BROWSER_EXECUTION_INTEGRATION.md`

Do not create additional agents that edit the same files. The browser integration prompt is the only prompt allowed to edit `apps/browser-demo/src/main.ts` and `apps/browser-demo/src/styles.css`.

## Product Goal

When a user approves an on-chain action, the app must not encourage a second wallet approval if the first approval may already have produced a transaction. The app needs durable browser-local execution state, clear failure classification, automatic status reconciliation, honest toasts, and clean receipts.

## Non-Negotiable Safety Rules

- Never retry the entire wallet approval after a wallet signature may have happened.
- Safe retry means rebroadcasting the exact same signed transaction bytes, or checking the exact same transaction signature.
- If the app does not have signed bytes or a deterministic transaction signature, do not auto-retry. Show a clear status and let the user check confirmation.
- If an RPC/API send fails after signed bytes exist, classify it as ambiguous unless chain status proves failed.
- A request with a pending signature must not show an approve/send button. It must show `Check confirmation`.
- A confirmed on-chain transaction must move to Done with a Solscan link.
- A proof-only action must be labeled proof-only and must not imply that an on-chain transaction was submitted.

## Shared Status Model

Use these semantics even if exact type names vary slightly.

```ts
type ExecutionPhase =
  | 'prepared'
  | 'wallet_opening'
  | 'wallet_signed'
  | 'broadcasting'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'failed'
  | 'ambiguous';

type ExecutionFailureKind =
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

interface PendingTransactionRecord {
  id: string;
  actionId: string;
  cluster: Cluster;
  workflowSource: 'browser' | 'cloud' | 'local-bridge';
  kind: PreparedActionKind | 'bridge_request' | 'cloud_finalization' | 'custom';
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
```

## Toast Copy

Use one toast lifecycle per execution when possible.

- Signing: `Signing transaction`
- First send attempt: `Sending transaction`
- Same-signed-bytes retry: `Retrying transaction send`
- Confirmation check: `Checking confirmation`
- Submitted, not final: `Transaction submitted`
- Ambiguous send: `Submitted status unknown`
- Confirmed: `Transaction confirmed`
- On-chain failure: `Transaction failed on-chain`
- Wallet rejection: `Wallet approval rejected`
- Config error: `Transaction execution not configured`

Required retry detail:

`Retrying only the same signed transaction. Do not approve this request again.`

Required ambiguous detail:

`The app is checking the original transaction before allowing another approval.`

Any toast that has a known txid must include an `Open Solscan` link.

## Card UX

Approval cards:

- Show `Approve swap`, `Approve and send`, or equivalent only before a signed/submitted record exists.
- Show `Check confirmation` after a txid exists, signed bytes exist, or the action has pending/ambiguous tx status.
- Disable the active action button immediately on click.
- Do not render `Recipient` if the action has no recipient. Other data boxes should fill the available row.
- Keep failed-on-chain actions visible with their error and tx link.

Done/receipt cards:

- On-chain records show short txid, `Open Solscan`, and `Copy tx link`.
- Proof-only records show `Proof only`, proof id/signature copy actions, and no empty transaction fields.
- Pending submitted transactions stay visible with `Check confirmation`; they are not silently archived.

## Pre-Sign Review UX

The review is compact and factual. It is not a landing page or explainer.

Swaps should show:

- input token and amount
- output token
- expected output
- minimum received / other amount threshold
- slippage bps and percent
- route label
- Jupiter request id if available
- price impact if available
- taker wallet
- touched programs if available

Sends should show:

- sender wallet
- recipient
- amount and token
- estimated fee if available
- current balance if available
- post-send balance if available
- memo if present
- cluster

Any transaction should show:

- fee payer if known
- transaction fingerprint/hash if known
- instruction count if known
- touched programs if available

Missing optional fields should be omitted, not rendered as `n/a`.

## Failure Semantics

- Wallet rejected: restore action to ready; the user may approve again.
- Wallet unavailable: restore ready and show setup/connect guidance.
- Config missing: keep ready but show the missing setup/config error.
- Quote/slippage failure before signing: restore ready.
- Network/RPC timeout after signed bytes exist: mark ambiguous, keep `Check confirmation`, and do not ask wallet again.
- On-chain failure: mark failed with tx link and error; only allow explicit retry after the user sees the failure.
- Expired blockhash after signing: do not silently ask wallet again; check chain status first, then show a clear expired/unknown result.

## Verification After Merge

After all parallel patches are merged together, run:

```bash
pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck
pnpm -F @solana-agent-wallet-adapter/browser-demo test
pnpm -F @solana-agent-wallet-adapter/browser-demo build
```

Manual checks:

- Approve a swap, simulate send timeout, verify no second wallet prompt appears and `Check confirmation` appears.
- Refresh after signing but before confirmation, verify the pending tx is recovered.
- Confirm a pending tx, verify Done receives the Solscan link.
- Reject in wallet, verify the approve button returns.
- Proof-only approval shows `Proof only` and no transaction link.
