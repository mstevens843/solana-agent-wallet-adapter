# Connector Execution Plan — End-to-end on-chain submission for every protocol connector

> Multi-track plan. Tracks A–E are designed to be executed **in parallel** by separate agents.
> Each track has its own files, scope, and acceptance criteria. Tracks integrate through the
> **Shared Contracts** section below; if every agent honors those contracts, the work composes
> without coordination.

## 0. Context and problem

Today a user can draft and queue a connector action (e.g., **Kamino deposit**, MarginFi borrow,
Jito unstake, Magic Eden bid, Squads approve, etc.). They click **Sign approval proof** in
Needs Approval. Backpack pops up an **Approve Solana Message** dialog. They approve.
The UI says **"Approval recorded"** and an entry lands in **Done** marked `approved`.

**Nothing happens on chain.** Solscan shows no Kamino transaction. The wallet only signed a
plain-text "Agentic browser workflow decision" message — not a real transaction.

Root cause: `apps/browser-demo/src/main.ts:22414–22427` — when the action's `kind` is not in
the small whitelist `EXECUTABLE_BROWSER_ACTION_KINDS = ['transfer_sol','transfer_spl','swap','custom_transaction']`,
the execute handler short-circuits into `signBrowserWorkflowDecision(...)` (`main.ts:22707`)
which calls `signingClient.signMessage(...)` — never a transaction signature, never an RPC submit.
The receipt gets a `proofSignature` but no `txid`. Every other connector kind funnels here.

Every protocol adapter under `packages/mcp-server/src/adapters/<connector>/*.ts` already builds
a real serialized transaction in its `execute(action, ctx)` method and hands the base64 to
`ctx.signAndBroadcast(...)`. The server-side code is correct. The browser dispatch is the gap.

Goal of this plan: every connector dropdown and sub-dropdown — Kamino reserves, MarginFi banks,
Save reserves, Drift markets/vaults, Lulo pools, Jupiter Lend (Earn + Borrow), Jupiter Triggers
(single/OCO/OTOCO/cancel/edit), Jupiter Recurring, Marinade stake/unstake/claim, Jito stake/unstake
(both `stake_account` and `reserve_sol` modes), Sanctum LST variants, Meteora DLMM pools/positions,
Orca whirlpools, Raydium pools/farms, Magic Eden bid (NFT vs Collection), Tensor bid (NFT vs
Collection)/sweep, Squads (create/approve/reject/execute/cancel), Realms vote/relinquish/deposit/
withdraw, Wormhole transfer/redeem/recover, Pyth post — **submits a real transaction**, returns a
real txid, shows an explorer link in Done.

## 1. Architecture overview

```
                              ┌──────────────────────────────┐
                              │ Browser-demo (apps/browser-   │
                              │ demo) — runs in the user's    │
                              │ browser, holds wallet client  │
                              └──────────────┬───────────────┘
                                             │
        ┌────────────────────────────────────┼─────────────────────────────────────┐
        │                                    │                                     │
        ▼                                    ▼                                     ▼
┌──────────────────┐               ┌────────────────────┐                ┌─────────────────────┐
│ Local bridge     │               │ Cloud (render-web) │                │ Solana RPC          │
│ (mcp-server)     │               │ apps/render-web    │                │ (mainnet / devnet)  │
│ /bridge/...      │               │ /api/...           │                │                     │
└──────┬───────────┘               └──────────┬─────────┘                └─────────────────────┘
       │                                      │                                     ▲
       │ uses adapter capture                 │ uses adapter capture                │
       ▼                                      ▼                                     │
   ┌───────────────────────────────────────────────┐                                │
   │ Adapter capture infra (mcp-server)            │                                │
   │ packages/mcp-server/src/preparedActionTx*     │                                │
   │  - registry: kind -> adapter                  │                                │
   │  - prepareTransactionForApproval(action, …)   │                                │
   │  - returns { transactionBase64, summary, ... }│                                │
   └───────────────────────────────────────────────┘                                │
                                                                                    │
The wallet signs the base64 in the browser, then the browser broadcasts to Solana RPC ──┘
```

End-to-end flow for a connector action:

1. Browser → POST `/api/approvals/:id/prepare-transaction` (cloud) **OR**
   `/bridge/prepared-actions/:id/prepare-transaction` (local bridge).
2. Backend looks up the approval, finds the adapter for `action.kind`, runs `adapter.execute(action, ctx)`
   where `ctx.signAndBroadcast(base64, summary)` is a **capture** function that records the base64
   instead of signing. Returns `{ transactionBase64, summary, preview }` to the browser.
3. Browser calls `signingClient.signTransaction(base64, { cluster, summary })`. Wallet shows the real
   tx, not a message. User approves.
4. Browser broadcasts via the existing `signAndBroadcastBrowserTransactionBase64` helper
   (`apps/browser-demo/src/main.ts:23392`) — same path Jupiter swap already uses.
5. Browser POSTs the resulting `txid` + status to `/api/approvals/:id/wallet-execution` (cloud)
   or the bridge equivalent. Receipt now carries a real txid, explorer link, confirmation poll, etc.

This mirrors the working Jupiter swap browser execution at `executeBrowserSwap`
(`apps/browser-demo/src/main.ts:23257`).

## 2. Shared Contracts (frozen — all tracks integrate here)

These are the wire formats every track must honor. **Do not deviate without updating this section
and notifying the other tracks.**

### 2.1 Cloud route: prepare a connector transaction

`POST /api/approvals/:id/prepare-transaction`

- Auth: existing cloud session cookie.
- Body: none required; the approval id in the path is sufficient.
- Success (200) response:
  ```ts
  {
    transactionBase64: string;   // unsigned, fee payer = approval.walletAddress, recentBlockhash set
    summary: string;              // human label for wallet UI ("Deposit 0.01 SOL into Kamino")
    preview?: Record<string, unknown>;  // adapter-specific (apy, decimals, reserveAddress, etc.)
    expiresAt?: string;           // ISO; blockhash lifetime hint, optional
    cluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
  }
  ```
- 404 if approval missing / not owned by session wallet.
- 409 if approval already terminal (`approved`/`rejected`/`failed`).
- 422 if no adapter registered for `action.kind` (returned by Track A registry).
- 502 if adapter build fails (e.g., RPC unreachable, SDK error). Body: `{ error: string }`.

### 2.2 Bridge route: prepare a connector transaction (parity)

`POST /bridge/prepared-actions/:id/prepare-transaction`

Same body + response shape as 2.1. Used when `state.bridgeActive === true`.

### 2.3 Backend helper (shared by both routes)

```ts
// packages/mcp-server/src/preparedActionTransactionBuilder.ts
export interface PreparedTransactionPayload {
  transactionBase64: string;
  summary: string;
  preview?: Record<string, unknown>;
  cluster: Cluster;
}

export async function prepareTransactionForApproval(
  action: PreparedAction,
  ctx: DAppAdapterContext,          // real connection, real backend.getAddress(), but…
): Promise<PreparedTransactionPayload>;
// …passes ctx.signAndBroadcast = capture; throws if no adapter is registered for action.kind.
```

The capture context replaces `ctx.signAndBroadcast` with:
```ts
async (base64: string, summary: string) => {
  captured = { transactionBase64: base64, summary };
  return '__captured__';   // sentinel; adapter.execute returns {txid:'__captured__', …} and we drop it
};
```

The function returns the captured payload. Every adapter currently calls `ctx.signAndBroadcast(base64, summary)`
as its last step (see `packages/mcp-server/src/adapters/kamino/deposit.ts:129`,
`marginfi/deposit.ts`, `drift/vaultDeposit.ts`, etc.), so this works with zero per-adapter changes.

### 2.4 Adapter registry

```ts
// packages/mcp-server/src/adapterRegistry.ts (new or existing — Track A confirms)
export function adapterForKind(kind: PreparedActionKind): AdapterAction<unknown> | undefined;
```

Maps every `PreparedActionKind` in `CONNECTOR_APPROVAL_ACTION_TYPES`
(`apps/browser-demo/src/main.ts:705`) to the matching exported adapter from `packages/mcp-server/src/adapters/*`.
Track A is the source of truth.

### 2.5 Browser-side dispatcher contract

```ts
// apps/browser-demo/src/main.ts
async function executeBrowserConnectorAction(
  action: PreparedAction,
  toastContext: TransactionToastContext,
): Promise<BrowserTransactionExecution>;
```

- If `state.bridgeActive`, calls `bridgeRequest('/bridge/prepared-actions/:id/prepare-transaction')`.
- Else if `cloudSessionMatchesWallet()`, calls `cloudRequest('/api/approvals/:id/prepare-transaction')`.
- Else throws `"Connector execution requires Agentic Cloud or Private Local Mode."`
- After receiving base64: signs via `signingClient.signTransaction(...)`, broadcasts via
  `signAndBroadcastBrowserTransactionBase64(action, base64, summary, toastContext)` (existing helper),
  records txid via `recordWalletExecution` (existing helper).
- Returns `{ txid, txStatus, explorerUrl }` matching the shape that
  `executeBrowserPreparedActionRecord` already produces for swap/transfer.

### 2.6 Cloud `BROWSER_WALLET_EXECUTION_KINDS` expansion

`apps/render-web/src/cloud/workflowService.ts:125` currently:
```ts
const BROWSER_WALLET_EXECUTION_KINDS = new Set(['swap', 'blink_action']);
```
Becomes:
```ts
const BROWSER_WALLET_EXECUTION_KINDS = new Set<string>([
  'swap',
  'blink_action',
  ...CONNECTOR_APPROVAL_ACTION_TYPES,  // re-exported from a shared module; Track A
]);
```
The exact set of connector kinds is whatever `adapterForKind(kind) !== undefined` returns true for.

## 3. Tracks

Each track is a self-contained agent task. The tracks can be claimed and executed in parallel.
The dependency graph (Section 4) tells you which tracks can start immediately and which must wait
for a contract from another track.

---

### Track A — Adapter capture infrastructure (`packages/mcp-server`)

**Scope.** Provide the shared "build a transaction without signing" helper that every other track
consumes via the Shared Contracts in §2.3 and §2.4.

**Files to create / edit.**
- `packages/mcp-server/src/adapterRegistry.ts` (create) — exports `adapterForKind(kind)` and the
  exported set `CONNECTOR_APPROVAL_ACTION_TYPES` if it doesn't already live in a shared module.
- `packages/mcp-server/src/preparedActionTransactionBuilder.ts` (create) — exports
  `prepareTransactionForApproval(action, ctx)`. Internally builds a capture context that wraps
  `ctx` and replaces `signAndBroadcast` with the capture function described in §2.3.
- `packages/mcp-server/src/index.ts` (edit) — re-export the new helpers so render-web and the
  bridge can import them.
- `packages/mcp-server/src/__tests__/preparedActionTransactionBuilder.test.ts` (create).

**Implementation notes.**
- The registry can be a static `Map<PreparedActionKind, AdapterAction<unknown>>` populated at
  module init. Walk `adapters/*` and register each `<Connector>DepositAction`, `<Connector>WithdrawAction`,
  etc. by their `.kind` property.
- If `adapterForKind` returns undefined, `prepareTransactionForApproval` throws a typed error
  (e.g., `new AdapterError('registry', 'unknown_kind', kind)`) so Track B / Track C can map to 422.
- The capture context **must** pass through the real `connection`, `backend.getAddress`, and
  `config.cluster` from the caller's context — adapters need those for blockhash, SDK calls, and
  wallet-ownership checks.
- The capture's `signAndBroadcast` returns the sentinel string `'__captured__'`. The helper
  discards whatever `execute()` returns as `txid` and uses the captured base64 instead.
- Edge cases:
  - Adapter `execute()` that calls `signAndBroadcast` more than once → only the **first** call
    counts; throw if a second capture is attempted (indicates multi-tx flow we don't support yet).
  - Adapter `execute()` that never calls `signAndBroadcast` (e.g., read-only adapter) → throw
    `not_executable`. Track B / Track C map to 422.

**Tests.**
- `prepareTransactionForApproval` for a synthetic Kamino-deposit `PreparedAction` returns a base64
  matching what the Kamino adapter produces (mock `getKaminoClient().buildDepositTransaction` to
  return a known `Transaction`).
- Throws on unknown kind.
- Throws on adapter that double-signs.
- Throws on adapter that doesn't call `signAndBroadcast`.

**Acceptance.** `pnpm --filter @solana-agent-wallet-adapter/mcp-server test` green. Helper
importable from `@solana-agent-wallet-adapter/mcp-server`. No changes to existing adapter files.

**Owner:** one agent. **Effort:** ~3 hours.

**Depends on:** nothing. **Blocks:** Tracks B and C.

---

### Track B — Cloud route `/api/approvals/:id/prepare-transaction` (`apps/render-web`)

**Scope.** Wire the cloud router to expose §2.1. Expand `BROWSER_WALLET_EXECUTION_KINDS` so the
existing `/api/approvals/:id/wallet-execution` route accepts txids for connector kinds.

**Files to edit.**
- `apps/render-web/src/cloud/router.ts` — register `'POST /api/approvals/:id/prepare-transaction'`
  in `REGISTERED_API_ROUTES`, add handler that:
  1. resolves the session and loads the approval via `workflowService.getApproval(id)`,
  2. builds a `DAppAdapterContext` with a Solana `Connection` (use the existing cluster→RPC mapping
     in this file) and a backend that exposes only `getAddress = () => approval.walletAddress`,
  3. calls `prepareTransactionForApproval(approval, ctx)` from Track A,
  4. returns the §2.1 response.
- `apps/render-web/src/cloud/workflowService.ts` — replace the hard-coded
  `BROWSER_WALLET_EXECUTION_KINDS` (line 125) with the union described in §2.6. Import the set
  from the mcp-server package (Track A re-export).
- `apps/render-web/src/cloud/workflowRoutes.ts` — add pathname matcher for the new route
  (matches the pattern used for `wallet-execution` and `finalization/prepare` at lines 138, 145).
- `apps/render-web/src/__tests__/server.test.ts` — add tests (see below).

**Implementation notes.**
- The cloud doesn't have the user's key. It only **prepares** the transaction; the browser signs.
- Reuse the existing Solana `Connection` creation pattern from `/api/solana/latest-blockhash`
  (already in `router.ts`).
- The `DAppAdapterContext.backend` shape only needs `getAddress`. Other backend methods
  (`signAndBroadcast`, `signMessage`) should throw if invoked — capture context overrides
  `signAndBroadcast` and nothing should reach `signMessage` during prepare.
- Error mapping:
  - `AdapterError('registry', 'unknown_kind', …)` → HTTP 422 `{error: 'No adapter registered for kind …'}`.
  - `ProtocolError('unauthorized', …)` → 403.
  - Other thrown errors → 502 with redacted message.
- The route handler must be rate-limited under the existing `WRITE_RATE_LIMIT_*` rules in this file.

**Tests.**
- POST returns 200 with base64 for a Kamino-deposit approval. Mock the adapter to assert
  `prepareTransactionForApproval` is called once with the approval and a connection.
- POST returns 422 for `manual_review` (no adapter).
- POST returns 409 for a terminal approval.
- POST returns 404 for an approval owned by a different wallet.
- Existing `/api/approvals/:id/wallet-execution` accepts a `kamino_deposit` txid after the
  whitelist expansion (regression test).

**Acceptance.** `pnpm --filter @solana-agent-wallet-adapter/render-web test` green. Manual smoke:
`curl -X POST localhost:8787/api/approvals/<id>/prepare-transaction -b session=…` returns base64.

**Owner:** one agent. **Effort:** ~3 hours.

**Depends on:** Track A contract (§2.3, §2.4, §2.6). **Blocks:** Track D Phase 2.

---

### Track C — Bridge route `/bridge/prepared-actions/:id/prepare-transaction` (`packages/mcp-server`)

**Scope.** Mirror Track B on the local bridge so Private Local Mode also executes connector
actions end-to-end without the cloud.

**Files to edit.**
- `packages/mcp-server/src/bridgeServer.ts` — register the route, handler resolves the approval
  from the bridge's prepared-action store, builds the adapter context with the bridge's existing
  `Connection` and wallet backend, calls `prepareTransactionForApproval` from Track A, returns
  the §2.2 response.
- `packages/mcp-server/src/__tests__/bridgeServer.test.ts` — add tests.

**Implementation notes.**
- The bridge has a real wallet backend, but for prepare-only we must override `signAndBroadcast`
  with capture (per Track A). The original backend still provides `getAddress`.
- Existing bridge route patterns to copy: any `/bridge/prepared-actions/...` route already in
  this file (e.g., the inbox refresh route).
- Error mapping identical to Track B.

**Tests.**
- Bridge route returns base64 for a Kamino-deposit prepared action.
- Returns 422 for unknown kind.
- Returns 409 for terminal action.

**Acceptance.** `pnpm --filter @solana-agent-wallet-adapter/mcp-server test` green. Local smoke
via the dev script: `pnpm dev` then trigger a connector action with the bridge active and confirm
the route returns base64.

**Owner:** one agent. **Effort:** ~2 hours.

**Depends on:** Track A. **Blocks:** Track D Phase 2 (bridge path only).

---

### Track D — Browser-demo: safety stop → real execution → UI polish (`apps/browser-demo`)

This track has three **sequential phases** internally, but is independent of Tracks A/B/C until
Phase 2.

#### Phase D1 — Safety stop (ship first, doesn't need any other track)

Goal: never tell the user "Approval recorded" for a connector kind when no transaction was sent.

**Files to edit.** `apps/browser-demo/src/main.ts` only.

**Changes.**
- Add a helper `isConnectorApprovalKind(action: PreparedAction): boolean` that returns true
  when `CONNECTOR_APPROVAL_ACTION_TYPES.has(action.kind)`. The constant already exists at line
  `apps/browser-demo/src/main.ts:705`.
- Add `BROWSER_PROOF_ONLY_KINDS = new Set<PreparedActionKind>([ /* manual_review, read_only,
  any audit-only adapter kinds */ ])` — explicit allowlist for kinds where signing only a decision
  proof is the **intended** behavior.
- In the `case 'execute'` block at `main.ts:22414–22427`, before the existing fallback to
  `signBrowserWorkflowDecision`, insert:
  ```ts
  if (isConnectorApprovalKind(action)) {
    throw new Error(
      `${action.kind.replace(/_/g, ' ')} cannot execute from this device yet. ` +
      `Connect Private Local Mode or wait for cloud connector execution.`
    );
  }
  if (!BROWSER_PROOF_ONLY_KINDS.has(action.kind)) {
    throw new Error(`Browser workflow cannot execute ${action.kind} in this mode.`);
  }
  ```
- `inboxApprovalCard` (rendering, search `data-action-op="execute"` around `main.ts:28215`):
  add a `disabled` state and tooltip for connector actions when no execution path is available
  yet (no bridge, and Phase D2 not landed). Button label remains "Sign approval proof" only for
  `BROWSER_PROOF_ONLY_KINDS`.

**Acceptance.** Clicking the (now disabled-with-reason) approve button on a Kamino deposit in
browser-workflow mode shows a tooltip and refuses to sign. Existing transfer/swap/custom-tx
paths unaffected. `pnpm --filter @solana-agent-wallet-adapter/browser-demo test` + typecheck green.

**Owner:** one agent. **Effort:** ~2 hours. **Depends on:** nothing. **Blocks:** nothing.

#### Phase D2 — Real connector execution dispatcher

Goal: when the user clicks approve on a connector action, prepare the tx via cloud or bridge,
sign with the wallet, broadcast, record the txid.

**Files to edit.** `apps/browser-demo/src/main.ts` only.

**Changes.**
- Add `async function executeBrowserConnectorAction(action, toastContext): Promise<BrowserTransactionExecution>`
  implementing the contract in §2.5.
  - `prepareEndpoint = state.bridgeActive
      ? bridgeRequest(\`/bridge/prepared-actions/\${action.id}/prepare-transaction\`, { method: 'POST' })
      : cloudRequest(\`/api/approvals/\${action.id}/prepare-transaction\`, { method: 'POST' })`
  - If neither path is available, throw the message established in Phase D1.
  - Parse the response per §2.1/§2.2 with the same validators used in `executeBrowserSwap`
    (`requiredResponseString(...)`).
  - Sign with `signingClient.signTransaction(transactionBase64, { cluster: action.cluster, summary })`.
  - Broadcast via existing `signAndBroadcastBrowserTransactionBase64(action, base64, summary, toastContext)`
    (no change needed there — it already handles retry, ledger upserts, status polling).
  - After success, POST txid + status to existing `/api/approvals/:id/wallet-execution`
    (cloud) or its bridge analog. Track B's whitelist expansion ensures this is accepted.
- Update `executeBrowserPreparedActionRecord` (`main.ts:23142`):
  ```ts
  switch (action.kind) {
    case 'transfer_sol': return executeBrowserSolTransfer(action, toastContext);
    case 'transfer_spl': return executeBrowserSplTransfer(action, toastContext);
    case 'swap':         return executeBrowserSwap(action, toastContext);
    case 'custom_transaction': return executeBrowserCustomTransaction(action, toastContext);
    default:
      if (isConnectorApprovalKind(action)) return executeBrowserConnectorAction(action, toastContext);
      throw new Error(`Browser workflow cannot broadcast ${action.kind}.`);
  }
  ```
- Update `isExecutableBrowserAction(action)` (`main.ts:22728`):
  ```ts
  function isExecutableBrowserAction(action: PreparedAction): boolean {
    if (action.workflowSource === 'cloud') {
      // existing cloud-browser-executable path
      return EXECUTABLE_BROWSER_ACTION_KINDS.has(action.kind);
    }
    if (EXECUTABLE_BROWSER_ACTION_KINDS.has(action.kind)) return true;
    if (isConnectorApprovalKind(action) && connectorPrepareEndpointAvailable()) return true;
    return false;
  }
  function connectorPrepareEndpointAvailable(): boolean {
    return state.bridgeActive || cloudSessionMatchesWallet();
  }
  ```
- Replace the Phase D1 throw with the real dispatch (the Phase D1 throw remains the fallback
  when neither cloud nor bridge is available).

**Acceptance.** Manual smoke on devnet: draft a Kamino deposit with a small amount, send for
approval, click Approve & send, Backpack shows a real transaction (not a message), approve in
wallet, Done tab shows an explorer link, Solscan shows the on-chain deposit. Repeat for at least
one example per connector family (lending: Kamino/MarginFi/Save; LST: Marinade/Jito/Sanctum;
NFT: Magic Eden bid; governance: Squads approve). Existing tests green.

**Owner:** one agent. **Effort:** ~4 hours. **Depends on:** Track B contract (§2.1, §2.5),
optionally Track C contract for bridge path. Phase D1 should already be merged.

#### Phase D3 — UI polish

**Changes.**
- Button label: dynamic per action — `"Approve & send"` if executable connector, `"Sign approval proof"`
  only for `BROWSER_PROOF_ONLY_KINDS`. Tooltip explains the difference.
- "What this decision does" copy under the card (`main.ts` search `"approval-effect"`): switch
  text to `"Wallet signs the prepared transaction; Agentic submits it to Solana RPC."` when the
  action is executable.
- Done tab: explorer link visible for receipts with `txid`. Receipts that only have `proofSignature`
  (audit-only kinds) display a small "decision proof — no transaction" pill.
- "Use" / "Full details" footer actions stay unchanged.

**Acceptance.** Visual review: button labels, tooltips, and Done explorer links match the new
behavior. No regressions in existing transfer/swap UI.

**Owner:** same agent as Phase D2 or a separate UI-focused agent. **Effort:** ~2 hours.
**Depends on:** Phase D2. **Blocks:** nothing.

---

### Track E — End-to-end verification + receipt schema audit

**Scope.** Independent verification track that consumes Tracks A–D as they land.

**Files to edit / create.**
- `apps/browser-demo/src/__tests__/connectorExecution.test.ts` (create) — mocks `cloudRequest`
  and `signingClient`, calls `executeBrowserConnectorAction` for at least two adapter kinds
  (Kamino deposit, Magic Eden bid), asserts the dispatch order: prepare → sign → broadcast →
  record. Asserts the receipt ends up with a non-empty `txid`.
- Audit pass on `apps/browser-demo/src/main.ts` `completeBrowserPreparedAction` /
  `completedReceiptFromAction` paths so a receipt with both `proofSignature` and `txid` keeps
  both, and a receipt with only one displays correctly in Done.
- Spot-check the recurring-payment occurrence handler so an active connector-based recurring
  schedule (e.g., Recurring Kamino deposit) follows the new execute path when its occurrence
  fires.

**Acceptance.** `pnpm test` across all packages green. Verification doc updated:
`apps/browser-demo/src/__tests__/connectorExecution.test.ts` covers happy path + cloud failure
+ bridge fallback + insufficient signing capability.

**Owner:** one agent. **Effort:** ~3 hours. **Depends on:** Tracks A + B + D2 merged (E can be
designed in parallel and the tests stubbed against the contract, then activated after merges).

## 4. Dependency graph

```
Track A (capture infra)  ────┐
                              ├──► Track B (cloud route) ──┐
                              ├──► Track C (bridge route) ─┤
                                                            ├──► Track D Phase 2 (browser dispatcher)
                                                            │      │
                                                            │      └──► Track D Phase 3 (UI polish)
                                                            │
Track D Phase 1 (safety stop) ─── independent, ship first ──┘

                                                            ├──► Track E (verification)
```

Recommended parallelization:
- **Start at the same time:** Track A, Track D Phase 1, Track E (scaffold tests against the
  contracts — they will fail until tracks land).
- **Once A is merged:** Track B and Track C can start (they consume A's helper).
- **Once B (or C) and D1 are merged:** Track D Phase 2 starts.
- **Once D2 merges:** Track D Phase 3 and Track E activate.

Total wall-clock with three concurrent agents and good handoff: ~1 working day.

## 5. Verification (end-to-end, after all tracks land)

1. Smoke matrix on devnet, one action per family. Each action must produce a real txid that
   resolves on Solscan:
   - Kamino deposit (lending). Reserve = SOL.
   - MarginFi deposit (lending, isolated banks).
   - Save deposit (lending, health-aware withdraw must also work).
   - Marinade liquid stake (LST).
   - Jito unstake JitoSOL — both `stake_account` and `reserve_sol` modes.
   - Sanctum stake SOL → bonkSOL.
   - Meteora DLMM add liquidity.
   - Orca whirlpool increase liquidity.
   - Raydium farm stake.
   - Magic Eden bid — once as Single NFT, once as Collection.
   - Tensor sweep.
   - Squads approve proposal.
   - Realms cast vote.
   - Wormhole transfer (Solana → another chain).
   - Pyth post price update.
2. Confirm Done tab shows an explorer link with the correct txid for every entry. No more
   `proofSignature`-only receipts for connector kinds.
3. Confirm receipts written before this plan landed still display correctly (no regressions on
   historical proof-only entries).
4. Confirm denial flow still works — clicking Deny still produces a decision-proof signature and
   marks the action `rejected`.
5. Confirm a user without cloud session **and** without local bridge sees a clear actionable error
   when they try to approve a connector action (no silent proof signing).

## 6. Out of scope (do not let scope creep into these)

- Adapter refactors. The capture pattern is intentionally zero-touch on adapter source code.
- New connectors. This plan covers every connector with an existing `prepare/execute` adapter.
- Cloud-side execution where the cloud holds custody. The wallet always signs in the browser.
- Custom RPC routing or fee-payer rebates.
- Receipt schema changes beyond the existing `txid` / `proofSignature` fields.

## 7. Rollback

- Phase D1 is fully reversible by deleting the new `isConnectorApprovalKind` early-throw block.
- Tracks B / C / D2: the prepare-transaction routes can be removed and `isExecutableBrowserAction`
  reverted to the original whitelist. The wallet-execution endpoint whitelist expansion is the
  only persistent schema-ish change; rolling back is harmless (it just rejects future calls).
- Track A's helper is library code with no side effects; removing it leaves the existing adapter
  `execute()` methods unchanged.
