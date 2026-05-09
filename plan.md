# First-Time User Flow And Transaction Finalization Plan

## Objective

Bring Agentic from a strong engineering foundation into a launch-ready web product flow where a normal first-time user understands the product in under 60 seconds:

- Connect wallet.
- Create or draft a plan.
- Review the exact request.
- Approve, deny, or cancel with the wallet.
- Save a durable receipt.
- Understand that Agentic never holds keys, never gets unlimited signing authority, and cannot approve silently.

The critical product boundary is:

> AI drafts. Cloud queues. Wallet approves. Receipts persist. Local bridge is optional.

This plan focuses on the first-time user flow polish and the tightened real transaction finalization layer that makes that boundary credible.

## Product Gaps Found

### 1. First-Time Flow Was Not Obvious Enough

The app had the right primitives, but a first-time user could still land in `/app` and miss the actual path:

- Wallet connection, cloud sign-in, plan creation, review, approval, and receipt were spread across multiple surfaces.
- Private local bridge language competed with cloud/browser modes and made the default path feel unclear.
- The app did not continuously explain what the current decision actually does.
- Completion did not strongly pull the user toward the saved receipt.

Implementation target:

- A first-run band that shows the live journey: Wallet, Plan, Review, Decision, Receipt.
- Primary action changes based on the current state.
- Approval cards state the exact effect of approval or rejection.
- Completed receipts become a visible end state, not a hidden archive.

### 2. Transaction Finalization Was Too Client-Supplied

The previous cloud API could store a finalization preview/result, but the browser could provide too much of that preview. For a money-moving transaction, this is not good enough. The server needs to own the review boundary.

Required final step:

- Refresh or construct the action from locked approval constraints.
- Simulate the transaction.
- Store transaction hash, message hash, quote hash, and simulation hash.
- Show the wallet only that exact transaction.
- Require a wallet proof bound to that finalization record.
- Save the confirmed receipt.

Implementation target:

- Add server-owned finalization endpoints:
  - `POST /api/approvals/:id/finalization/prepare`
  - `POST /api/approvals/:id/finalization/:finalizationId/submit`
  - `POST /api/approvals/:id/finalization/:finalizationId/fail`
- Keep the legacy preview/result route for compatibility, but make the browser use server prepare/submit.
- Require finalization-bound proof messages for submitted/confirmed transaction receipts.

### 3. Proof-Only And Wallet-Execute Paths Needed Hard Separation

The app must never make proof-only approval look like transaction execution.

Final policy:

- `transfer_sol`, `transfer_spl`, and `swap` require transaction preview/finalization.
- `custom_transaction` is proof-only until a concrete, server-owned builder exists.
- `manual_review` and recurring schedule creation use wallet decision proof.
- Browser-local fallback can sign proof-only receipts, but must say that no transaction is submitted by that proof.

Implementation target:

- Direct `/approve` is blocked for money-moving cloud approvals.
- Unsupported cloud money-moving kinds cannot be proof-only approved.
- Unsupported cloud finalization buttons are disabled and tell the user to use private local mode or reject.

### 4. Trust Layer Needed To Become The Product

The trust boundary is Agentic's moat. It needed visible proof, not only implementation details.

Implementation target:

- Show no custody, no unlimited signer, AI drafts only, receipts persist.
- Store signed decision proof messages.
- Store transaction finalization records with hashes and simulation/quote evidence.
- Add clearer trust bundle copy for completed receipts.

### 5. AI Guardrails Needed Product-Level Boundaries

The planner needed to feel powerful but bounded:

- AI can draft.
- AI can explain risk.
- AI can summarize and fill forms.
- AI cannot approve.
- AI cannot silently change locked constraints.
- AI cannot request delegated/unlimited signing.

Implementation target:

- Guardrail metadata on plans and approvals.
- Block unsafe authority language.
- Preserve finalization requirements and constraint fingerprints.

## Implementation Phases

### Phase 1: First-Time User Orientation

Implemented:

- Added a first-run progress surface for Wallet, Plan, Review, Decision, Receipt.
- Added state-aware first-run primary actions.
- Clarified cloud/browser/local mode language.
- Added approval effect panels on inbox cards.
- Improved completion focus toward saved receipts.

Acceptance criteria:

- `/app` explains the normal route without requiring docs.
- A signed-out user can still understand template flow.
- A signed-in cloud user sees cloud queue and receipt behavior clearly.
- Local bridge is positioned as private local mode, not a requirement for the public app.

### Phase 2: Finalization Policy Contract

Implemented:

- Shared workflow contract now classifies:
  - `transfer_sol`, `transfer_spl`, `swap`: `transaction_preview`
  - `recurring_payment`: `wallet_decision_proof`
  - `manual_review`, `custom_transaction`: `wallet_decision_proof`
- Direct approval is rejected for finalization-required actions.
- Proof-only decisions cannot carry txid, explorer URL, finalization id, transaction hash, message hash, quote hash, or simulation hash.
- Finalization result proof must match the finalization-specific message, not the generic approval message.

Acceptance criteria:

- A SOL transfer cannot be approved through proof-only `/approve`.
- A custom transaction does not pretend to have server transaction finalization.
- Submitted/confirmed finalization receipts are cryptographically bound to the stored review record.

### Phase 3: Server-Owned SOL Transfer Finalization

Implemented:

- Added `prepareTransactionFinalization`.
- Server validates locked constraints from approval params:
  - sender wallet
  - recipient or `recipientAddress`
  - `amountSol` or `amount`
  - SOL token boundary
- Server builds a `SystemProgram.transfer` transaction.
- Server simulates the transaction.
- Server stores:
  - transaction hash
  - message hash
  - quote hash
  - simulation hash
  - wallet action preview
  - expiry
  - trust metadata
- Server returns transaction bytes separately as `transactionBase64`.
- Added mock finalization path for deterministic server tests via `AGENTIC_MOCK_FINALIZATION=1`.

Acceptance criteria:

- Browser no longer constructs the cloud SOL finalization preview.
- Wallet approval is bound to server-prepared transaction bytes.
- Receipt stores enough evidence to audit exactly what was approved.

### Phase 4: Submit And Failure Routes

Implemented:

- Added `submitTransactionFinalization`.
- Added `failTransactionFinalization`.
- Added route matching and validation for:
  - `/finalization/prepare`
  - `/finalization/:finalizationId/submit`
  - `/finalization/:finalizationId/fail`
- Registered new routes in hosted API status metadata.

Acceptance criteria:

- Wallet aborts are recorded without completing approval.
- Confirmed submissions complete approval and archive linked queued plans.
- Route finalization id must match the body/path boundary.

### Phase 5: Browser Flow Wiring

Implemented:

- Browser cloud SOL flow calls server `/prepare`.
- Browser signs the finalization-specific proof message.
- Browser sends wallet transaction bytes through `signAndSendTransaction`.
- Browser submits `/submit` with stored transaction/message/quote/simulation hashes.
- Browser calls `/fail` if wallet approval is aborted.
- Cloud money-moving approvals that cannot be finalized are disabled.
- Unsupported cloud action label is `Use private local mode`.
- Browser fallback copy says approval proof does not submit a transaction.
- `recipientAddress` is treated as an alias for `recipient`.

Acceptance criteria:

- No cloud money-moving approval falls through to generic proof-only approval.
- Wallet action copy tells the truth about execution.
- Browser path and server path agree on finalization proof message format.

### Phase 6: Trust, Recurring, And Receipts

Implemented as part of broader flow polish:

- Clearer receipt use cases:
  - proof of intent
  - proof of rejection
  - proof of policy
  - proof of review
- Completed receipts include trust bundle data when available.
- Recurring plans gained stronger production surfaces:
  - occurrence preview/history
  - pause/resume
  - expiry/policy fields
  - notification service path
  - policy cap enforcement passed through server options
- Recurring approvals still return to the wallet per run.

Acceptance criteria:

- Recurring feels like a product workflow, not just a stored schedule.
- Evidence receipts have concrete names and use cases.
- Trust/audit data is easy to copy or inspect.

## Files Touched In This Implementation

Primary implementation:

- `packages/workflow/src/index.ts`
- `apps/render-web/src/cloud/workflowService.ts`
- `apps/render-web/src/cloud/workflowRoutes.ts`
- `apps/render-web/src/cloud/router.ts`
- `apps/render-web/src/server.ts`
- `apps/browser-demo/src/main.ts`
- `apps/browser-demo/src/styles.css`
- `scripts/smoke-render-web.mjs`

Tests and support:

- `packages/workflow/src/__tests__/workflow.test.ts`
- `apps/render-web/src/__tests__/workflow-api.test.ts`
- `apps/render-web/src/__tests__/recurring-api.test.ts`
- `apps/browser-demo/src/__tests__/planner.test.ts`
- `pnpm-lock.yaml`
- `apps/render-web/package.json`

## Verification Completed

Passed locally:

- `pnpm -F @solana-agent-wallet-adapter/workflow test`
- `pnpm -F @solana-agent-wallet-adapter/render-web typecheck`
- `pnpm -F @solana-agent-wallet-adapter/render-web test`
- `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck`
- `pnpm -F @solana-agent-wallet-adapter/browser-demo test`
- `pnpm -F @solana-agent-wallet-adapter/browser-demo build`
- `pnpm -F @solana-agent-wallet-adapter/render-web build`
- `pnpm -F @solana-agent-wallet-adapter/mcp-server test`
- `pnpm smoke:render-web:workflow`

Known warning:

- Browser production build still warns that one JS chunk is over 500 kB. This is not a correctness blocker, but code splitting should be a later performance task.

## Remaining Work After This Phase

### Deployment

Local code is implemented and verified. Public launch still requires deploying the latest Render build and confirming:

- `GET https://agentic-signer.com/api/session`
- `GET https://agentic-signer.com/api/ai/status`
- authenticated `/api/plans`
- authenticated `/api/approvals`
- finalization prepare/submit routes

### Future Finalizers

Cloud browser finalization currently supports server-owned SOL transfer finalization. These should remain disabled or private-local until real builders exist:

- SPL transfer finalizer
- swap finalizer
- arbitrary/custom transaction finalizer

### Chain Verification Hardening

Current browser submit path confirms in the browser and submits the confirmed status to the server. A later hardening pass should add server-side signature status verification before marking confirmed.

### Performance

The browser bundle should be split after product behavior stabilizes:

- wallet runtimes
- AI planner code
- recurring dashboard
- evidence receipt lab

## Product Quality Target

After this phase, the product should feel materially closer to launch-ready:

- First-time user flow: clear.
- Trust boundary: explicit.
- Cloud transaction finalization: server-owned for SOL transfers.
- Proof-only path: separated from transaction execution.
- Recurring: stronger and more credible.
- Smoke coverage: covers signed-in cloud, signed-out browser fallback, recurring, evidence, and private local mode.
