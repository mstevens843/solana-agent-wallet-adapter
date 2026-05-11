# Agent Prompt: Browser Execution Safety Integration

Read `TX_SAFETY_SHARED_SPEC.md` first.

This prompt is parallel-safe. It owns the browser-demo UI/execution integration files only. It must not edit the module files owned by the other prompts.

This prompt can run at the same time as:

- `AGENT_PROMPT_TX_LEDGER_MODULE.md`
- `AGENT_PROMPT_FAILURE_CLASSIFICATION_MODULE.md`
- `AGENT_PROMPT_PRESIGN_REVIEW_MODULE.md`

Write imports against the APIs specified in those prompt files. If this prompt runs before those modules exist in your workspace, do not create fallback duplicates and do not edit their files. Full typecheck/build is expected after all parallel patches are merged.

## Mission

Wire durable transaction execution safety into the browser demo:

- Persist signed/submitted transaction state before broadcast.
- Prevent duplicate approvals after a signature may exist.
- Reconcile pending transactions on load, refresh, tab entry, and explicit checks.
- Show accurate toasts for sign, send, retry, confirmation, success, ambiguity, and failure.
- Show pre-sign review details before wallet signing.
- Show clean Done/receipt cards with tx links for on-chain actions and proof-only labeling for non-chain actions.

## Write Scope

You may edit only:

- `apps/browser-demo/src/main.ts`
- `apps/browser-demo/src/styles.css`
- `apps/browser-demo/src/__tests__/browserExecutionSafety.integration.test.ts` if you add integration tests
- existing browser-demo tests only if changed UI copy breaks them

Do not edit:

- `apps/browser-demo/src/transactionLedger.ts`
- `apps/browser-demo/src/transactionFailure.ts`
- `apps/browser-demo/src/preSignReview.ts`
- Render server code
- MCP server code
- CLI/desktop code
- package manifests unless a test runner proves a missing dependency

## Expected Module APIs

Assume these modules exist once all parallel prompts are merged:

- `./transactionLedger`
- `./transactionFailure`
- `./preSignReview`

Use the exported APIs from the corresponding prompt files. Do not change those APIs from this prompt.

## Existing App Context To Inspect

Before editing, inspect these areas of `apps/browser-demo/src/main.ts`:

- Toast helpers: `pushToast`, `replaceToast`, `updateTransactionToast`, `toastStack`
- Browser execution entrypoints: functions around `executeBrowserPreparedActionRecord`, `executeBrowserPreparedAction`, `executeBrowserSolTransfer`, `executeBrowserSplTransfer`, `executeBrowserSwap`, `executeBrowserCustomTransaction`
- Broadcast helpers: `broadcastSignedBrowserTransactionWithRetry`, `executeSignedJupiterSwapWithRetry`, `resolveSubmittedTransactionStatus`
- Approval card rendering: prepared action card functions and `preparedActionDecisionLabels`
- Done/receipt card rendering: completed plan / receipt rendering functions
- Refresh handlers and tab navigation handlers

Keep edits tightly scoped to transaction execution safety and the cards/toasts that expose it.

## 1. Persist Signed Tx State Before Broadcast

When a wallet returns signed transaction bytes from `signTransaction`:

- Derive txid/signature from the signed transaction when possible.
- Compute signed transaction hash with `signedTransactionHashFromBase64`.
- Upsert a ledger record before any broadcast or Jupiter execute call.
- Include:
  - `actionId`
  - `cluster`
  - `kind`
  - `workflowSource: 'browser'` or `'local-bridge'` as appropriate
  - `walletAddress`
  - `phase: 'wallet_signed'`
  - `txid` when derivable
  - `signedTransactionHash`
  - `signedTransactionBase64` when available
  - `jupiterRequestId` for Jupiter swap orders
  - `attemptCount`
  - timestamps
  - `explorerUrl`

For wallet-native `signAndSendTransaction`:

- If the wallet returns a txid/signature only, persist `txid`, `phase: 'submitted'`, and timestamps.
- Do not auto-retry wallet-native sign-and-send without signed bytes.
- The UI should switch to `Check confirmation`.

If a tab refreshes after signing:

- Load the ledger.
- If a matching pending record exists, do not ask for wallet approval again.
- Show `Check confirmation` and the tx link when a txid exists.

## 2. Disable Duplicate Approval Execution

Approval card button rules:

- Before any signed/submitted ledger state: show the existing approve label (`Approve swap`, `Approve and send`, etc.).
- With a ledger record in `wallet_signed`, `broadcasting`, `submitted`, `confirming`, or `ambiguous`: show `Check confirmation`.
- With action-level pending tx state even if ledger is missing: show `Check confirmation`.
- With on-chain failed state: show failure details and an explicit retry action only after the failure is visible.
- With wallet rejection before signing: restore normal approve button.

Click behavior:

- On approve click, immediately set a local busy/pending state for that action.
- Disable the button while the operation is active.
- Ignore double-clicks and repeated clicks while the action is active.
- If the result becomes ambiguous, keep the action pending and do not restore approve.
- If the result is wallet rejected before signing, restore approve.

Never:

- Show `Approve swap/send` when a signed record or txid might already exist.
- Automatically ask the wallet to sign a second transaction after a send timeout.
- Archive or delete a pending submitted action without reconciliation.

## 3. Reconciliation Job

Add reconciliation on:

- app bootstrap after state load
- Refresh button / inbox refresh
- entering or re-rendering the Needs Approval tab
- explicit `Check confirmation` button click
- after any ambiguous send/broadcast error

Reconciliation behavior:

- Load records from `pendingTransactionsNeedingReconciliation`.
- For each record with txid, call the existing signature status API path already used by `resolveSubmittedTransactionStatus`.
- If confirmed/finalized:
  - mark ledger `confirmed`
  - set `confirmedAt`
  - update action status to approved/completed
  - create or merge the Done receipt
  - show `Transaction confirmed` toast if user initiated
  - include `Open Solscan`
- If on-chain failed:
  - mark ledger `failed`
  - set `failedAt`, `failureKind: 'onchain_failed'`, and `lastError`
  - keep action visible in Needs Approval with failed status and Solscan link
  - do not show approve as the primary action
- If still pending:
  - keep ledger `submitted` or `confirming`
  - keep action visible with `Check confirmation`
  - show Solscan link if txid exists
- If status API is unavailable:
  - keep ledger `ambiguous` or `submitted`
  - show `Submitted status unknown` only for user-initiated checks

Records without txid:

- If signed bytes exist, attempt safe rebroadcast only through the same signed bytes path.
- If no signed bytes and no txid, do not ask the wallet again automatically. Show a clear ambiguous/error state.

## 4. Retry Policy

Retries are allowed only for the exact same signed transaction bytes.

Flow:

1. Wallet signs transaction.
2. Ledger persists signed bytes/hash before send.
3. First broadcast starts with toast `Sending transaction`.
4. On retryable network/RPC failure, classify with `transactionFailure.ts`.
5. Before retry, check whether txid already reached chain status if txid is known.
6. Retry the same signed bytes after a short delay.
7. Toast says `Retrying transaction send`.
8. Toast detail says `Retrying only the same signed transaction. Do not approve this request again.`
9. On success, mark `submitted`/`confirming`, then reconcile.
10. On ambiguous final failure, mark `ambiguous` and show `Check confirmation`.

Do not retry:

- wallet rejection
- config missing
- invalid transaction
- simulation/preflight failure before send
- expired blockhash without checking status
- on-chain failure
- Jupiter quote/order failure before wallet signing

## 5. Toast UX

Use one toast per execution when practical.

Required lifecycle:

- `Signing transaction`
- `Sending transaction`
- `Retrying transaction send`
- `Checking confirmation`
- `Transaction submitted`
- `Transaction confirmed`
- `Submitted status unknown`
- `Transaction failed on-chain`
- `Wallet approval rejected`
- `Transaction execution not configured`

Rules:

- Pending states use the existing spinner styling.
- Any toast with txid includes `Open Solscan`.
- Success toasts should say the receipt/link was saved in Done.
- Ambiguous toasts must not say final failure.
- Config failures should name missing execution setup without exposing secrets.
- Rejections should be short and should not create a receipt.

## 6. Pre-Sign Review UI

Use `preSignReview.ts` models before opening the wallet.

Location:

- Render inside the approval card/details area.
- Do not create a landing page or separate marketing screen.
- Keep it compact, dense, and scannable.

For sends:

- Show wallet, recipient, amount/token, memo, fee estimate, balance, post-send balance, cluster.
- If recipient is missing, do not render a fake recipient row.
- If fee/balance is unavailable, omit it rather than showing `n/a`.

For swaps:

- Show input amount/token, output token, expected output, minimum received, slippage, route, Jupiter request id, price impact, cluster.
- If Jupiter order/quote is fetched during execution, update the review panel and toast before wallet signing.
- Show route and slippage before the wallet opens whenever data exists.

For custom transactions:

- Show fee payer, instruction count, transaction fingerprint, touched programs, cluster.

Warnings:

- Render warning text above the primary action.
- Danger warnings may require a deliberate confirmation click, but do not add needless multi-step friction for normal send/swap reviews.

Styling:

- Use existing card/detail patterns.
- Keep labels small and uppercase if matching current UI.
- Long values must truncate cleanly.
- No nested cards.
- No `n/a` fields.

## 7. Done And Receipt Cards

For on-chain receipts:

- Always show short txid.
- Always show `Open Solscan`.
- Always show `Copy tx link`.
- Show tx status: `confirmed`, `pending`, or `failed`.
- Show completed timestamp when confirmed.
- Keep existing `Copy receipt JSON`.

For proof-only receipts:

- Show `Proof only`.
- Show proof id/signature/hash copy actions.
- Do not show empty txid, recipient, or Solscan fields.

For pending submitted transactions:

- Keep them visible in Needs Approval or a pending Done-style area.
- Show `Check confirmation`.
- Show txid/Solscan when known.
- Do not silently remove them from the queue.

## 8. Recipient Box Cleanup

In approval cards and any similar request card:

- If an action/request has no recipient, do not render a `Recipient` summary box.
- Remaining boxes should fill the row using responsive grid behavior.
- Swaps, custom txs, and proof-only records should not show `Recipient n/a`.
- Sends/transfers with real recipients still show recipient with copy action.

## 9. Failure Handling Matrix

Use `classifyTransactionFailure`.

- Wallet rejected: restore action to ready; user can approve again.
- Wallet unavailable: restore action to ready; show connect/setup copy.
- Config missing: keep ready; show setup/config error.
- Quote/slippage failed before signing: restore ready.
- Network/RPC timeout after signed bytes: mark ambiguous; show `Check confirmation`; no wallet prompt.
- Rate limit/5xx after signed bytes: retry same signed bytes, then ambiguous if unresolved.
- Already processed/duplicate signature: check confirmation.
- Expired blockhash: check chain status first; if not landed, show expired state without automatic re-sign.
- On-chain failed: mark failed with tx link/error; allow only explicit retry after user sees it.
- Unknown after signed bytes: mark ambiguous; show `Check confirmation`.

## 10. Tests

Add integration-style tests only if the current test harness makes it practical. Use a unique test file name to avoid overlapping module test files:

- `apps/browser-demo/src/__tests__/browserExecutionSafety.integration.test.ts`

Cover at least the pure/renderable pieces you can without a browser wallet:

- Button label becomes `Check confirmation` when pending ledger/action tx state exists.
- Recipient box is omitted when recipient is absent.
- Done card renders `Open Solscan` and `Copy tx link` for on-chain receipt.
- Proof-only card renders `Proof only` and no tx link.
- Failure classifier output maps to non-duplicate approve state in render helpers if helpers are testable.

## Verification

If all parallel module files are present, run:

```bash
pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck
pnpm -F @solana-agent-wallet-adapter/browser-demo test
pnpm -F @solana-agent-wallet-adapter/browser-demo build
```

If this prompt runs before the module prompts have landed, do not edit their files just to make isolated typecheck pass. Note that final verification must happen after all parallel patches are merged.

Manual scenarios after merge:

- Approve swap, simulate send timeout, verify button becomes `Check confirmation` and no second wallet prompt appears.
- Refresh tab after signed bytes but before confirmation, verify pending tx is recovered.
- Confirm pending tx, verify Done card gets Solscan link and copy tx link.
- Wallet rejection restores approve button.
- Proof-only approval shows `Proof only` and no tx link.
- Swap approval card does not show `Recipient n/a`.

## Acceptance

The app must never show a second wallet approval button for an action if a signed or submitted transaction may already exist. Any ambiguous transaction must remain trackable through txid/signature status and Solscan.

Final response: list only the files changed, the key functions wired, and any verification that could not run because parallel module patches were not present.
