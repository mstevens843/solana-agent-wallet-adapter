# Agentic Cloud Workflow Execution Plan

## Current Status

This document tracks the product-level workflow layer that turns Agentic from a local-bridge-first demo into a web app where normal users do not need localhost.

Implemented or currently in review in this checkout:

- The product model is defined: AI drafts, Agentic stores unsigned workflow state, and the wallet remains the only signing authority.
- The local bridge has been repositioned as optional private local mode.
- Shared workflow contracts exist in `packages/workflow`.
- Wallet sign-in, session cookies, runtime store interfaces, and Render API routing exist under `apps/render-web/src/cloud`.
- Cloud one-time plan, approval inbox, completed history, recurring scheduler, and evidence receipt APIs exist under the Render app.
- The `/app` page supports Agentic Cloud, browser workflow fallback, and private local mode through workflow capabilities instead of hardcoded bridge blockers.
- Browser workflow fallback can queue one-time plans, approve/deny requests, create a device-local recurring fallback occurrence, show completed history, and keep evidence-style proofs.
- Hosted BYOK planning has same-origin API routes and remains a drafting path only.
- Persistent Postgres storage, migrations, runtime store selection, production scheduler hooks, and deployment docs exist.
- Smoke coverage exists for cloud auth, approvals, recurring materialization, evidence archive, hosted BYOK status, browser fallback, and private local mode.
- Cloud approve/deny now requires a wallet-verifiable decision proof bound to the exact approval id, wallet, cluster, summary, kind, and params.
- Cloud evidence receipts now verify the submitted signed message against the signed-in wallet before storing `verified: true`.
- Postgres migrations are guarded by a transaction-scoped advisory lock so concurrent startup does not race migration application.
- Route-local unknown 500 errors are redacted before returning JSON to the browser.

Final verification before production release:

- Run the Phase 9 gate in CI/local and against the target Render/Postgres environment before public release.
- Configure production `DATABASE_URL`, `SESSION_SECRET`, `AGENTIC_PUBLIC_ORIGIN`, and recurring materialization cron in Render.
- Deploy the latest Render web service before public launch. As of 2026-05-09, the live `https://agentic-signer.com/api/ai/status`
  endpoint is reachable, but the live Cloud workflow endpoints `/api/session`, `/api/auth/nonce`, and `/api/plans` still return 404,
  which means production is not yet serving the cloud workflow API build.
- Monitor wallet auth, rate-limit, audit-event, and smoke output after deployment. No known local checkout blockers remain;
  deployment blockers are tracked in the Phase 9 handoff below.

## Product Rule

AI path and workflow path are separate.

AI path decides how a plan gets drafted:

- No AI / templates.
- Browser AI.
- Hosted BYOK.
- Local bridge AI.

Workflow path decides where unsigned work is stored:

- Agentic Cloud, default product path.
- Browser workflow fallback, demo/offline path.
- Private local bridge, advanced local-first path.

The app must not require localhost for normal web users.

## Security Rule

Agentic Cloud may store:

- Wallet public key.
- Unsigned intent.
- Recipient.
- Token.
- Amount cap.
- Slippage cap.
- Memo.
- Schedule rules.
- Approval status.
- Signed receipts.
- Risk metadata.
- Audit events.

Agentic Cloud must never store:

- Seed phrase.
- Private key.
- Delegated signer by default.
- Unlimited approval authority.
- Silently executable transactions.
- Provider API key beyond the current hosted BYOK request unless the user explicitly opts into key storage later.

Every money-moving action must still require explicit wallet approval.

## Agent Handoff Rules

Use this doc as the source of truth when assigning implementation work.

Recommended handoff prompt:

```text
Please implement Phase N from AGENTIC_CLOUD_WORKFLOW_PLAN.md.
Only edit files listed in that phase's write scope.
Do not implement other phases.
Return changed files, tests run, and any blockers.
```

Non-overlap rules:

- A phase owns only the files listed in its write scope.
- If a phase needs another phase's behavior, use the documented interface or add a TODO in its own scope.
- Do not edit another phase's files to make your phase easier.
- Do not change local bridge behavior unless the phase explicitly says so.
- Keep browser workflow fallback working until Agentic Cloud fully replaces it as the default signed-in path.

Current phase status:

- Phase 1, Shared Workflow Contracts: implemented/currently in review.
- Phase 2, Cloud Auth And Session Foundation: implemented/currently in review.
- Phase 3, Cloud One-Time Workflow APIs: implemented/currently in review.
- Phase 4, Frontend Cloud Workspace Adapter: implemented/currently in review.
- Phase 5, Cloud Recurring Scheduler: implemented/currently in review.
- Phase 6, Cloud Evidence Receipt Archive: implemented/currently in review.
- Phase 7, AI Setup And Drafting Cleanup: implemented/currently in review.
- Phase 8, Persistent Database And Deployment: implemented/currently in review.
- Phase 9, End-To-End QA And Release Hardening: implemented/currently in review.

Dependency rules for new agent assignments:

- Do not reimplement Phases 1-6 from scratch in this checkout. Review and patch gaps within the phase write scope.
- Future polish should patch the existing implementations instead of restarting any phase from scratch.
- Persistent storage remains owned by the runtime server path; the router default stays memory-backed for unit tests and explicit embeds.
- Release QA should continue to verify both Agentic Cloud default mode and optional private local mode.

## Phase 1: Shared Workflow Contracts

Owner: contracts agent.

Goal:

Create shared TypeScript contracts so the backend, frontend, tests, and future adapters speak the same language.

Write scope:

- `packages/workflow/**`
- `packages/workflow/package.json`
- `packages/workflow/tsconfig.json`
- `packages/workflow/vitest.config.ts`

Do not edit:

- `apps/browser-demo/**`
- `apps/render-web/**`
- `packages/mcp-server/**`

Deliverables:

- New workspace package: `@solana-agent-wallet-adapter/workflow`.
- Shared model types:
  - `WorkflowMode`
  - `WorkflowCapabilities`
  - `WalletSession`
  - `WorkflowUser`
  - `PlanDraftRecord`
  - `ApprovalRequestRecord`
  - `ApprovalStatus`
  - `RecurringScheduleRecord`
  - `RecurringOccurrenceRecord`
  - `CompletedRecord`
  - `EvidenceReceiptRecord`
  - `AuditEventRecord`
- Shared request/response types:
  - `AuthNonceResponse`
  - `VerifyWalletRequest`
  - `SessionResponse`
  - `CreatePlanRequest`
  - `PlanListResponse`
  - `CreateApprovalRequest`
  - `ApprovalListResponse`
  - `CreateRecurringRequest`
  - `RecurringListResponse`
  - `CompletedListResponse`
  - `CreateEvidenceReceiptRequest`
  - `EvidenceReceiptListResponse`
- Transition helpers:
  - `isTerminalApprovalStatus`
  - `isActiveApprovalStatus`
  - `completedFromApproval`
  - `capabilitiesForWorkflowMode`
- Runtime validators for untrusted JSON.

Acceptance criteria:

- `pnpm -F @solana-agent-wallet-adapter/workflow build` passes.
- `pnpm -F @solana-agent-wallet-adapter/workflow test` passes.
- No browser app or render server behavior changes in this phase.

## Phase 2: Cloud Auth And Session Foundation

Owner: backend auth agent.

Goal:

Add wallet sign-in and a pluggable server-side workflow store foundation to the hosted Render server.

Write scope:

- `apps/render-web/src/server.ts`
- `apps/render-web/src/cloud/auth.ts`
- `apps/render-web/src/cloud/cookies.ts`
- `apps/render-web/src/cloud/session.ts`
- `apps/render-web/src/cloud/store.ts`
- `apps/render-web/src/cloud/memoryStore.ts`
- `apps/render-web/src/cloud/router.ts`
- `apps/render-web/src/__tests__/auth.test.ts`
- `apps/render-web/package.json`
- `apps/render-web/tsconfig.json`

Do not edit:

- `apps/browser-demo/**`
- `packages/mcp-server/**`
- `packages/workflow/**` except dependency imports.

Backend endpoints:

- `POST /api/auth/nonce`
- `POST /api/auth/verify-wallet`
- `POST /api/auth/logout`
- `GET /api/session`

Behavior:

- Server creates a short-lived nonce.
- Browser signs a login message with the connected wallet.
- Server verifies wallet address, nonce, domain, issued time, expiration, and signature.
- Server creates an HTTP-only session cookie.
- Session proves wallet ownership only. It grants no spending authority.
- Session-scoped workflow store is available to later phases.
- `apps/render-web/src/cloud/router.ts` should expose one API routing entry point so later backend phases can add routes without editing the top-level server again.

Store foundation:

- Define a `WorkflowStore` interface.
- Provide `MemoryWorkflowStore` for dev/test.
- Store must be scoped by wallet address.
- Store must support audit event insertion even before workflow APIs exist.
- Do not add Postgres in this phase.

Acceptance criteria:

- Sign-in nonce can be created.
- Valid wallet signature creates a session.
- Invalid, expired, or replayed nonce is rejected.
- `GET /api/session` returns signed-in state from cookie.
- `POST /api/auth/logout` clears the session.
- Existing hosted BYOK endpoints still pass.
- `pnpm -F @solana-agent-wallet-adapter/render-web test` passes.

## Phase 3: Cloud One-Time Workflow APIs

Owner: backend workflow agent.

Goal:

Implement cloud APIs for draft plans, one-time approval requests, terminal decisions, and completed history.

Write scope:

- `apps/render-web/src/cloud/workflowRoutes.ts`
- `apps/render-web/src/cloud/workflowService.ts`
- `apps/render-web/src/cloud/workflowValidation.ts`
- `apps/render-web/src/cloud/receiptService.ts`
- `apps/render-web/src/__tests__/workflow-api.test.ts`

Allowed coordination edit:

- `apps/render-web/src/cloud/router.ts`, only to register the new workflow route module if Phase 2 did not leave a registration hook.

Do not edit:

- `apps/browser-demo/**`
- `packages/workflow/**`
- `packages/mcp-server/**`

Backend endpoints:

- `POST /api/plans`
- `GET /api/plans`
- `PATCH /api/plans/:id`
- `DELETE /api/plans/:id`
- `POST /api/approvals`
- `GET /api/approvals`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/deny`
- `POST /api/approvals/:id/cancel`
- `GET /api/completed`
- `DELETE /api/completed/:id`

Behavior:

- Draft plans are unsigned records.
- Approval requests are unsigned intents.
- Approve, deny, and cancel create terminal completed records.
- Terminal items leave the active inbox response.
- All reads and writes are scoped to the signed-in wallet.
- Endpoints reject requests without a valid wallet session.
- No endpoint accepts seed phrases, private keys, delegated signers, or unlimited approval authority.

Acceptance criteria:

- Signed-in user can create/list/update/delete plans.
- Signed-in user can create/list approvals.
- Signed-in user can approve/deny/cancel an approval.
- Approve and deny require a verified wallet decision proof; cancel remains proofless.
- Terminal decisions appear in completed history.
- User A cannot read or mutate User B records.
- `pnpm -F @solana-agent-wallet-adapter/render-web test` passes.

## Phase 4: Frontend Cloud Workspace Adapter

Owner: frontend workflow agent.

Goal:

Connect `/app` to Agentic Cloud when the user is signed in, while keeping browser workflow fallback and private local bridge mode.

Write scope:

- `apps/browser-demo/src/main.ts`
- `apps/browser-demo/src/styles.css`
- `apps/browser-demo/README.md`

Do not edit:

- `apps/render-web/**`
- `packages/workflow/**`
- `packages/mcp-server/**`

Frontend behavior:

- Left rail shows:
  - Wallet connection.
  - Cloud workspace sign-in state.
  - Optional AI planner.
  - Private local mode.
- If user is signed in:
  - One-time drafts save to cloud.
  - Queueable one-time plans move to cloud Approval Inbox.
  - Approve/deny/cancel uses cloud APIs and wallet-signed decision proof when applicable.
  - Completed Plans reads cloud completed history.
- If user is not signed in:
  - Browser workflow fallback remains available.
  - UI clearly says browser workflow is local to this device.
- If local bridge is connected:
  - Private local mode can override cloud workflow for local-only users.
  - Copy should say private local mode, not required setup.

Acceptance criteria:

- User can sign in from `/app`.
- Signed-in one-time plan flow works without localhost.
- Refresh preserves cloud workflow history.
- Browser fallback still works when signed out.
- Local bridge still works when explicitly selected.
- `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck` passes.

## Phase 5: Cloud Recurring Scheduler

Owner: recurring workflow agent.

Goal:

Make recurring plans product-grade through Agentic Cloud, with each due occurrence becoming an Approval Inbox item.

Write scope:

- `apps/render-web/src/cloud/recurringRoutes.ts`
- `apps/render-web/src/cloud/recurringService.ts`
- `apps/render-web/src/cloud/scheduler.ts`
- `apps/render-web/src/__tests__/recurring-api.test.ts`
- Recurring-specific sections of `apps/browser-demo/src/main.ts`
- Recurring-specific sections of `apps/browser-demo/src/styles.css`

Do not edit:

- One-time plan UI outside recurring integration.
- Evidence receipt UI.
- Hosted BYOK planner logic.
- `packages/mcp-server/**`

Backend endpoints:

- `POST /api/recurring`
- `GET /api/recurring`
- `PATCH /api/recurring/:id`
- `DELETE /api/recurring/:id`
- `POST /api/recurring/materialize-due`
- `GET /api/recurring/:id/occurrences`
- `POST /api/recurring/:id/pause`
- `POST /api/recurring/:id/resume`

Behavior:

- Cloud recurring schedule stores unsigned schedule rules.
- Scheduler creates due approval requests.
- Duplicate due occurrences are prevented by schedule id and due window.
- Every occurrence appears in Approval Inbox before any wallet action.
- No recurring schedule auto-signs or auto-submits.
- User can pause, resume, edit, cancel, or delete schedules.
- Schedules can carry expiry, notification settings, next-run previews, lifetime spend views, and policy cap enforcement.
- Webhook reminder delivery is queued separately from materialization and signed with an HMAC header.
- Ended schedules remain visible in Completed Plans.

Frontend behavior:

- Recurring tab uses cloud schedule APIs when signed in.
- Browser recurring fallback remains available when signed out.
- Next occurrence and next-5 preview remain visible before creation.
- Occurrence history uses plain-English statuses and linked approval/receipt summaries.
- Recurring templates remain visible in recurring UI.
- Copy says each run returns for wallet review.

Acceptance criteria:

- Signed-in user can create a recurring schedule without local bridge.
- Materializing due work creates an Approval Inbox item.
- User can approve or deny each occurrence independently.
- Pause/resume/delete works.
- `pnpm -F @solana-agent-wallet-adapter/render-web test` passes.
- `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck` passes.

## Phase 6: Cloud Evidence Receipt Archive

Owner: evidence workflow agent.

Goal:

Move Evidence Receipts from browser-only archive to cloud-backed signed-in archive while preserving local browser fallback.

Write scope:

- `apps/render-web/src/cloud/evidenceRoutes.ts`
- `apps/render-web/src/cloud/evidenceService.ts`
- `apps/render-web/src/__tests__/evidence-api.test.ts`
- Evidence-specific sections of `apps/browser-demo/src/main.ts`
- Evidence-specific sections of `apps/browser-demo/src/styles.css`

Do not edit:

- One-time Approval Inbox behavior.
- Recurring scheduler behavior.
- AI planner generation logic.

Backend endpoints:

- `POST /api/evidence`
- `GET /api/evidence`
- `DELETE /api/evidence/:id`

Receipt types:

- Intent Receipt.
- Policy Receipt.
- Risk Review Receipt.
- Rejection Receipt.
- Tool Output Receipt.

Behavior:

- User enters requested action, constraints, and context/source.
- Wallet signs an evidence-only message.
- Cloud stores full receipt for signed-in users.
- Browser stores local receipt when signed out.
- Archive supports filter, search, copy signed message, copy full JSON, and delete.
- Receipt archive copy explains the difference between signed message and full JSON.

Acceptance criteria:

- Signed-in user can create and archive an evidence receipt.
- Server verifies the evidence receipt signature against the signed-in wallet before storing it as verified.
- Browser-only user can still create and archive local evidence.
- Created receipt appears immediately.
- The exact signed text is visible.
- Receipts clearly say they do not queue, approve, submit, or move funds.
- `pnpm -F @solana-agent-wallet-adapter/render-web test` passes.
- `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck` passes.

## Phase 7: AI Setup And Drafting Cleanup

Owner: AI UX agent.

Goal:

Make AI setup understandable and prove that AI is only a drafting layer.

Write scope:

- `apps/browser-demo/src/planner.ts`
- AI-specific sections of `apps/browser-demo/src/main.ts`
- AI-specific sections of `apps/browser-demo/src/styles.css`
- Hosted BYOK AI-only sections of `apps/render-web/src/server.ts`
- `apps/render-web/src/__tests__/server.test.ts`

Do not edit:

- Cloud workflow storage endpoints.
- Recurring scheduler.
- Evidence receipt archive.
- Local bridge backend.

Behavior:

- AI setup has a `Test AI key` or `Confirm planner` action.
- Browser AI, Hosted BYOK, and Local bridge AI all say they draft only.
- No AI/templates remain first-class and fully usable.
- Hosted BYOK errors are clear and never leak API keys.
- Browser AI limitations are clear:
  - Provider may block browser calls.
  - Key lives in current browser runtime.
  - Browser cannot run background jobs when tab closes.
- Changing AI path does not change workflow capability.

Acceptance criteria:

- User can tell before generating whether AI is ready.
- User can tell AI cannot approve, submit, or sign.
- Template flow works with AI disabled.
- Hosted BYOK tests still pass.
- `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck` passes.
- `pnpm -F @solana-agent-wallet-adapter/render-web test` passes.

## Phase 8: Persistent Database And Deployment

Owner: production backend agent.

Goal:

Replace memory-only cloud workflow storage with production persistence and deployment documentation.

Write scope:

- `apps/render-web/src/cloud/postgresStore.ts`
- `apps/render-web/src/cloud/migrations/**`
- `apps/render-web/src/cloud/store.ts`
- `apps/render-web/src/__tests__/postgres-store.test.ts`
- `apps/render-web/README.md`
- Root deployment docs/scripts only if needed.

Do not edit:

- Browser UI.
- AI planner UI.
- Local bridge backend.

Persistence:

- Use `DATABASE_URL` when present.
- Fall back to memory store only for local dev/test.
- Add schema for:
  - users
  - wallet_sessions
  - nonces
  - plans
  - approval_requests
  - recurring_schedules
  - recurring_occurrences
  - completed_records
  - evidence_receipts
  - audit_events
- Add indexes for wallet address, status, due time, and created time.
- Add cleanup policy for expired sessions and nonces.

Deployment docs:

- `DATABASE_URL`
- session secret
- cookie security
- hosted BYOK behavior
- private local mode behavior
- Render cron or scheduled job setup for recurring materialization

Acceptance criteria:

- Cloud workflow persists across server restarts when `DATABASE_URL` is configured.
- Tests prove wallet scoping.
- Tests prove replayed auth nonces fail.
- Tests prove recurring due jobs do not duplicate occurrences.
- Docs explain required environment variables.

## Phase 9: End-To-End QA And Release Hardening

Owner: QA/release agent.

Goal:

Prove the product flow works end to end and prepare it for public web traffic.

Write scope:

- `scripts/**` test/smoke scripts only.
- `apps/browser-demo/README.md`
- `apps/render-web/README.md`
- `AGENTIC_CLOUD_WORKFLOW_PLAN.md`
- Dedicated test files under existing `__tests__` folders.

Do not edit:

- Product implementation files unless fixing a bug discovered by tests.
- If a product code fix is required, document it and keep it narrowly scoped.

Required smoke flows:

- Signed-out browser fallback one-time flow.
- Signed-in cloud one-time flow.
- Signed-in cloud approval approve flow.
- Signed-in cloud approval deny flow.
- Signed-in completed history refresh.
- Signed-in cloud recurring schedule creation.
- Recurring due materialization into Approval Inbox.
- Evidence receipt creation and archive.
- Hosted BYOK drafting.
- Browser AI unavailable but templates still work.
- Private local bridge still works.

Release checks:

- No UI says localhost is required for the default web app.
- No API route stores private signing material.
- No hosted BYOK error leaks provider keys.
- Terminal inbox records move to Completed Plans.
- Browser fallback remains available.
- Render server returns JSON for `/api/*` and SPA shell for app routes.

Acceptance criteria:

- Full build passes.
- Render web tests pass.
- Browser demo typecheck passes.
- Smoke script documents pass/fail output.
- README explains default cloud workflow, browser fallback, and private local mode.

Phase 9 implementation handoff:

- `scripts/smoke-render-web.mjs` has a `--workflow` mode with structured `PASS`, `FAIL`, and `SKIP` output for the
  required release checks. It uses mocked hosted BYOK and mocked local bridge harnesses for CI-safe coverage. Use
  `--require-local-bridge` only when a real private local bridge is intentionally running.
- The recurring QA path covers signed-in schedule creation, duplicate-safe due materialization, and creation of exactly
  one Approval Inbox item per due occurrence.
- The smoke path covers signed-out browser fallback through completion, UI cloud sign-in plus approve flow, signed-in
  approve/deny API flows, completed history refresh, UI recurring creation, evidence archive, hosted BYOK drafting and
  redaction, template drafting without browser AI, mocked private local bridge mode, and API JSON vs SPA shell routing.
- README handoff lives in `apps/browser-demo/README.md` and `apps/render-web/README.md`, including default Agentic Cloud
  workflow, browser fallback, private local mode, production env vars, and recurring materialization options.
- Narrow product fixes made during QA: recurring occurrences now carry schedule metadata into approval/completed records;
  cloud recurring approvals are de-duplicated across browser and server paths; interrupted recurring occurrence repair is
  limited to stale ready occurrences without an approval request; evidence receipts archive to Agentic Cloud when the
  signed-in wallet matches; server and browser BYOK diagnostics use shared redaction coverage; and the recurring cron
  command uses the same Approval Inbox sink as the web API.
- Final sweep status: the local Phase 9 gate passes, including workflow package tests, render-web tests/build/typecheck,
  browser-demo tests/typecheck, smoke workflow, release-link verification, full build, and whitespace checks.
- Release-only blockers that still require the target environment: run render-web tests with `TEST_DATABASE_URL`, fix the
  live Render smoke failure where `https://agentic-signer.com/api/session` currently returns 404, and run
  `--require-local-bridge` only with a real private bridge. The live release-link verifier is passing.

Recommended Phase 9 gate:

```sh
pnpm build
pnpm render:build
pnpm -F @solana-agent-wallet-adapter/render-web build
pnpm -F @solana-agent-wallet-adapter/render-web typecheck
pnpm -F @solana-agent-wallet-adapter/workflow test
pnpm -F @solana-agent-wallet-adapter/render-web test
pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck
pnpm -F @solana-agent-wallet-adapter/browser-demo test
pnpm smoke:render-web
pnpm smoke:render-web:workflow
pnpm verify:release-links
```

Production-target Phase 9 gate:

```sh
TEST_DATABASE_URL=... pnpm -F @solana-agent-wallet-adapter/render-web test
pnpm smoke:render-web:live
pnpm verify:release-links:live
pnpm smoke:render-web:workflow -- --require-local-bridge
```

## Recommended Parallelization

Safe immediate parallel work:

- Phase 1 can run alone first.
- After Phase 1 lands, Phase 2 can run while a design-only agent reviews Phase 4 UX copy, but Phase 4 implementation should wait for Phase 3 APIs.

Safe backend/frontend split:

- Phase 3 backend workflow APIs and Phase 4 frontend adapter should not be implemented blindly at the same time unless Phase 1 contracts are complete and treated as frozen.
- If parallelized, Phase 4 must use contract types and temporary mocks only, then remove mocks after Phase 3 merges.

Do not parallelize:

- Phase 5 recurring and Phase 3 workflow API unless store interfaces are already stable.
- Phase 6 evidence and Phase 4 frontend adapter if both are editing the same Evidence Receipts UI section.
- Phase 8 persistent database before Phase 2, Phase 3, Phase 5, and Phase 6 have stabilized the store interface.

## Final Product Flow

Default signed-in web flow:

1. Connect wallet.
2. Sign in with wallet ownership message.
3. Choose template or optional AI drafting path.
4. Create one-time plan, recurring schedule, or evidence receipt.
5. Save unsigned workflow state to Agentic Cloud.
6. Review active work in Approval Inbox.
7. Approve, deny, cancel, or sign evidence with wallet.
8. Save terminal records in Completed Plans or Evidence Receipt Archive.

Private local mode:

1. User starts Desktop App or local bridge.
2. Agentic switches workflow mode to private local runtime.
3. Queue, scheduler, receipts, AI session keys, and MCP/Desktop flows run locally.
4. User still signs with wallet.

Browser fallback:

1. User can create demo/offline workflow state in local browser storage.
2. Browser state persists on the current device only.
3. Browser workflow is useful immediately but is not the final cross-device product store.
