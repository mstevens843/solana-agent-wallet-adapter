# Recurring Plans → Production-Grade

> **Scope of this push:** *only* user-prompt item **#6 — Recurring plans need to feel production-grade.* All other items (deploy, tx finalization, AI guardrails, evidence receipts, growth) are explicitly out of scope.
>
> **Plan file destination:** This document is mirrored in the repo root as `/Users/devlegacy/Desktop/projects/solana-agent-wallet-adapter/RECURRING_PLANS_PRODUCTION_PLAN.md` as the first action when implementation starts. The kind-petting-map.md copy is the plan-mode working file; the root copy is the source-of-truth artifact going forward.

---

## Context

The recurring layer in this monorepo already has a strong engineering core: cloud schedules persist in Postgres, a 60-second materializer cron (`render.yaml:34-46`) creates per-occurrence approval requests, and the local-bridge MCP path mirrors the same data model. What it does *not* have is the surface area that makes it feel like a product feature instead of a primitive.

The user's stated targets, verbatim:

> 6. Recurring plans need to feel production-grade.
>    They should become one of the main killer features:
>    - next occurrence preview
>    - pause/resume
>    - spend caps
>    - expiry
>    - per-run approval
>    - completed occurrence history
>    - notification/reminder path eventually

Mapped against the actual codebase, only **two** of those seven targets are end-to-end production-quality today (next-occurrence computation and per-run approval). The other five are partial, missing, or invisible to the user. This plan closes every gap, in phases that each ship independently.

The end state: a Solana wallet holder can create a weekly recurring payment, see exactly what it will cost over its lifetime, set a hard expiry, get a webhook ping when each run is ready to approve, see a clean history of every past occurrence with a plain-English status, and pause/resume in one tap. Each individual run still requires a wallet signature — the wallet remains the only signer. Recurring becomes a killer workflow, not a hidden tool.

---

## Completion Sweep Addendum

The follow-up production sweep found and closed the remaining gaps that mattered most for a launch-grade recurring workflow:

- Webhook secrets now have one-time reveal semantics on create/rotate and are never returned from normal schedule reads.
- Delivery records no longer store webhook secrets; webhook delivery signs `timestamp.body` with the current schedule secret.
- Notification enqueue is best-effort and duplicate/recovery materialization paths repair missing delivery records.
- Notification status and secret rotation are exposed through schedule-specific cloud APIs and browser controls.
- Occurrence history hydration can use batch approval/completed lookups instead of scanning entire wallet history.
- Pause/resume routes now emit explicit audit event names.
- Policy config lookup is robust to package-vs-root current working directories, and decimal cap checks avoid floating-point comparison.
- Browser fallback preview uses the shared cadence helper instead of the old local interval helper.
- `plan.md` is now the short source-of-truth completion plan; this file remains the deep historical implementation plan.

---

## Current State (audited, line-grounded)

### Data model (what exists)

`packages/workflow/src/index.ts:375-402` — `RecurringScheduleRecord` fields:
```
id, status, walletAddress, cluster, token, recipient, amount,
cadence, createdAt, updatedAt,
dayOfWeek?, dayOfMonth?, intervalDays?, intervalHours?, intervalMinutes?,
localTime?, startAt?, maxOccurrences?, occurrencesCreated?,
nextDueAt?, lastMaterializedAt?, slippageBps?, memo?, note?,
riskMetadata?, metadata?
```

`packages/workflow/src/index.ts:404-418` — `RecurringOccurrenceRecord` fields:
```
id, recurringScheduleId, walletAddress, cluster, status,
occurrenceKey, dueAt, createdAt, updatedAt,
approvalRequestId?, completedRecordId?, error?, metadata?
```

`packages/workflow/src/index.ts:625-644` — `CreateRecurringRequest`: same field set as the record (no `expiresAt`, no `notifications`).

`packages/mcp-server/src/preparedActions.ts:44-65` — Bridge-side `RecurringPayment` mirror, intentionally narrower (no `cluster`-as-WorkflowCluster, no slippage, no riskMetadata).

### Service & routes (what works)

| Capability | File | Status |
|---|---|---|
| Create / list / get / update / delete schedule | `apps/render-web/src/cloud/recurringService.ts:222-300` | ✅ |
| Status sync from approval system | `recurringService.ts:312-347` | ✅ |
| Materialize-due (idempotent, 30s repair window) | `recurringService.ts:302-540` | ✅ |
| Compute next-due (cadence math) | `recurringService.ts:542-590` | ✅ |
| Background scheduler (60s tick) | `apps/render-web/src/cloud/scheduler.ts:1-89` | ✅ |
| Materializer cron job | `render.yaml:34-46` | ✅ |
| HTTP routes: GET/POST `/api/recurring`, GET/PATCH/DELETE `/api/recurring/:id`, POST `/api/recurring/materialize-due` | `apps/render-web/src/cloud/recurringRoutes.ts:184-248` | ✅ |
| MCP tools: create / list / pause / resume / delete | `packages/mcp-server/src/actionTools.ts:198-260` | ✅ |
| Bridge-side materialize-due | `packages/mcp-server/src/preparedActions.ts:121, 277-321` | ✅ |
| `nextDueAt` view computation | `recurringService.ts:250, 286, 542-590`, `preparedActions.ts:433` | ✅ |

### Gaps (what's missing or invisible)

1. **No `expiresAt`** — `maxOccurrences` is the only stop condition. A user cannot say "stop after 2026-12-31."
2. **No occurrence-history endpoint** — `RecurringStore.listOccurrences(wallet, scheduleId?)` exists in the data layer (`recurringService.ts:65`) but is *not* exposed via HTTP. The materialize handler returns occurrences indirectly, but there is no `GET /api/recurring/:id/occurrences` for the UI.
3. **No notification infrastructure** — `RecurringScheduler.options.onTick` (`scheduler.ts:8`) is the only hook. Nothing in render-web consumes it. No webhook delivery service, no in-app badge, no email plumbing.
4. **`riskMetadata` field exists but is never populated at creation** — `recurringService.ts:247` passes `input.riskMetadata` straight through; no automated risk computation (lifetime spend, automation rate, recipient class).
5. **No spend-cap enforcement at creation** — schedules silently accept any amount × any cadence. Aggregate weekly/monthly spend is never compared to a wallet-level policy.
6. **No spend-cap surfacing** — even ignoring enforcement, the UI never shows "this schedule will spend up to X over Y runs." Users have to do mental math.
7. **Pause/resume is PATCH-only on cloud** — `actionTools.ts:223-247` exposes dedicated MCP tools, but cloud has only `PATCH /api/recurring/:id` with `{status: 'paused'|'active'}`. The browser UI has to know the status enum to flip it. Not a bug, but inconsistent and error-prone.
8. **Cadence math duplicated three times** — `nextRecurringDueAt` (`preparedActions.ts:433`), `nextFutureOccurrence` (`recurringService.ts:593`), `computeNextOccurrence` (`recurringService.ts:676`). `clampedMonthlyDate` lives in both `preparedActions.ts:658` and `recurringService.ts:783`. Risk: one bug fix in three places. Will compound when we add expiry support.
9. **Status enum exposed as raw strings** — `RecurringOccurrenceStatus` includes `ready`, `approval_pending`, `completed`, `failed`, `cancelled`, `skipped`. Per the receipt-language memory note, primary UX should show plain English: *Awaiting approval / Approved / Executed / Skipped / Failed*. Today the browser likely renders raw enum tokens.
10. **Trust messaging absent** — no copy anywhere telling the user "each run requires your wallet signature; nothing executes automatically." This is the product's defining promise and it's invisible on the recurring tab.
11. **MCP tools missing the new fields** — once we add `expiresAt` and `notifications`, the MCP tool surface (`actionTools.ts:198-260` + bridge `preparedActions.ts:44-65`) needs parity, otherwise local-bridge users can't access the new features.
12. **No "preview the next N runs" capability** — `nextDueAt` is a single timestamp. UX wants "next 5 occurrences" so users can confirm the schedule before signing.
13. **Browser-fallback recurring** (offline mode) doesn't mirror these features either — but per existing project rules ("Keep browser workflow fallback working until Agentic Cloud fully replaces it as the default signed-in path"), we update it to at least display the new fields read-only and not crash on schedules created in cloud mode.

---

## Phases

Each phase is independently mergeable. Within a phase, tasks are listed in a recommended order.

---

### Phase 1 — Foundation: schema additions + cadence consolidation (non-breaking)

Goal: add the data fields and helper functions that all later phases depend on, without changing user-visible behavior.

**1.1 Hoist cadence math to a shared module.**
- New file: `packages/workflow/src/cadence.ts`.
- Move (don't reimplement) `computeNextOccurrence`, `nextFutureOccurrence`, `clampedMonthlyDate`, `parseLocalTime`, and a new `previewUpcoming(schedule, now, count)` that returns the next N occurrences as ISO strings.
- Re-export from `packages/workflow/src/index.ts` so consumers import from the workflow package, not the server.
- Update `apps/render-web/src/cloud/recurringService.ts` to import from `@solana-agent-wallet-adapter/workflow` instead of using its private copy. Delete the duplicated private functions there.
- Update `packages/mcp-server/src/preparedActions.ts` to import from the same module. Delete `nextRecurringDueAt` and the local `clampedMonthlyDate`. The `RecurringPayment` shape diverges from `RecurringScheduleRecord`, so write a thin `paymentToScheduleLike()` adapter in `preparedActions.ts` that maps fields for the shared cadence helpers.
- Add `previewUpcoming` unit tests covering: weekly w/ dayOfWeek+localTime, monthly w/ dayOfMonth+localTime (including 31st rolling to Feb), interval_days/hours/minutes, cadence + `expiresAt` (Phase 2 hook — accept the param now, ignore until Phase 2 wires expiresAt).
- **Acceptance:** every existing recurring test still passes; the deleted private functions no longer appear in the codebase; `pnpm -r test` is green.

**1.2 Add `expiresAt` to schema (additive, no behavior yet).**
- Add `expiresAt?: string` (ISO timestamp) to `RecurringScheduleRecord` (`packages/workflow/src/index.ts:402`), `CreateRecurringRequest` (`:644`), and `UpdateRecurringRequest` (`:666`).
- Update `parseRecurringScheduleRecord` (`packages/workflow/src/index.ts:1379`) and validators (`validateCreateRecurringRequest`, `validateUpdateRecurringRequest`) to accept and round-trip the field.
- Add `expiresAt?: string` to bridge-side `RecurringPayment` (`packages/mcp-server/src/preparedActions.ts:65`) and to the MCP `recurringInputSchema` (`packages/mcp-server/src/actionTools.ts:387`).
- Add Postgres migration `apps/render-web/src/cloud/migrations/00X_add_recurring_expires_at.ts` that adds `expires_at TIMESTAMPTZ NULL` to the schedules table and an index `(expires_at) WHERE expires_at IS NOT NULL`. Update `postgresStore.ts` mappers to read/write the column.
- **Acceptance:** schedules created with `expiresAt` round-trip through cloud and MCP without loss; migration applies cleanly on a fresh DB and idempotently on a populated one.

**1.3 Add `notifications` to schema (additive, no delivery yet).**
- Add to `RecurringScheduleRecord`: `notifications?: { inApp?: boolean; webhookUrl?: string; webhookSecret?: string; }` — note: `webhookSecret` is store-internal, never returned to the client; the API serializer strips it on read.
- Mirror through `CreateRecurringRequest`, `UpdateRecurringRequest`, validators, parsers.
- Postgres migration `00X_add_recurring_notifications.ts` adds `notifications JSONB NULL`.
- For the bridge `RecurringPayment`, add the `inApp` and `webhookUrl` mirror fields only (no secret on local bridge).
- **Acceptance:** notifications round-trip; webhookSecret never appears in any API response (covered by a new test in `apps/render-web/src/__tests__/recurring-routes.test.ts`).

**Files in scope (Phase 1):**
- `packages/workflow/src/cadence.ts` (new)
- `packages/workflow/src/index.ts` (re-exports, schema, validators, parsers)
- `apps/render-web/src/cloud/recurringService.ts` (delete duplicates, import shared)
- `apps/render-web/src/cloud/postgresStore.ts` (column read/write)
- `apps/render-web/src/cloud/migrations/00X_add_recurring_expires_at.ts` (new)
- `apps/render-web/src/cloud/migrations/00X_add_recurring_notifications.ts` (new)
- `packages/mcp-server/src/preparedActions.ts` (import shared, add field)
- `packages/mcp-server/src/actionTools.ts` (schema + tool input)

---

### Phase 2 — Expiry behavior + lifetime spend cap

Goal: `expiresAt` actually stops the schedule. Lifetime spend is computed and surfaced.

**2.1 Honor `expiresAt` in materialization.**
- In `materializeSchedule` (in `recurringService.ts`, around the existing materialize logic before line 540), short-circuit when `expiresAt && now >= expiresAt`. Mark the schedule `status: 'completed'`, set `nextDueAt = undefined`, append audit event `recurring.schedule.expired`. Return `MaterializeResult { reason: 'completed' }`.
- Mirror in bridge `preparedActions.ts` `materializeDueRecurring` (`:277`).
- Make `previewUpcoming` (Phase 1.1) respect `expiresAt`: stop yielding occurrences past the expiry.
- Update `computeNextDueAtIso` (`recurringService.ts:542`) so `nextDueAt` is `undefined` when next computed time is past `expiresAt`.
- **Acceptance:** create a schedule with `expiresAt = +5min`, run scheduler, observe completion within one tick after the expiry; UI shows it as completed.

**2.2 Lifetime spend computation.**
- New helper in `packages/workflow/src/cadence.ts`: `lifetimeSpendEstimate(schedule)` returning `{ runs: number | 'indefinite'; totalAmount: string; perWeek: string; perMonth: string }`. `runs = min(maxOccurrences, occurrencesUntil(expiresAt))` if either is set, else `'indefinite'`. Amount math uses BigInt-safe decimal arithmetic — reuse `parseDecimalAmount` / `formatRawAmount` from `packages/mcp-server/src/amounts.ts` (move to `packages/workflow` if needed for browser compatibility, or duplicate the pure-string version there).
- Surface on schedule reads: extend the API response shape (a wrapping `view` object: `{ schedule, lifetimeSpend, nextRuns: previewUpcoming(schedule, now, 5) }`). Do NOT modify `RecurringScheduleRecord` itself — keep the record pure data, the view is a derived projection at the route layer.
- Update `GET /api/recurring` and `GET /api/recurring/:id` to return the view shape. Browser clients can ignore the new fields; the existing schedule shape is unchanged.
- **Acceptance:** view fields are present, math is right (covered by a unit test of `lifetimeSpendEstimate` for weekly/monthly/interval with and without caps).

**2.3 Wallet-level spend-cap policy.**
- Read the wallet policy from `agent-wallet.config.json` if present (existing config surface; check `packages/core/src/config.ts` for the loader). Fields needed: `recurring.maxLifetimeAmount`, `recurring.maxPerWeekAmount`, `recurring.maxPerMonthAmount`, all per token. If absent, no enforcement (do not break existing flows).
- In `RecurringService.createSchedule` and `updateSchedule`, after building the prospective record, compute `lifetimeSpendEstimate` and reject with `RecurringServiceError(409, 'recurring_exceeds_policy', '...')` if any computed total exceeds the policy. Error message is plain English: *"This schedule would spend up to 35 USDC per month, exceeding your configured cap of 20 USDC per month."*
- Mirror in MCP layer's `service.createRecurringPayment` so local-bridge users get the same enforcement.
- **Acceptance:** with a config cap of `recurring.maxPerWeekAmount.SOL = 0.5`, a weekly schedule for `1.0 SOL` is rejected with the plain-English error; without the config field set, creation succeeds.

**Files in scope (Phase 2):**
- `packages/workflow/src/cadence.ts` (lifetimeSpendEstimate, previewUpcoming-with-expiry)
- `apps/render-web/src/cloud/recurringService.ts` (expiry honoring, view shape, policy enforcement)
- `apps/render-web/src/cloud/recurringRoutes.ts` (return view shape)
- `packages/mcp-server/src/preparedActions.ts` (mirror expiry)
- `packages/mcp-server/src/actionService.ts` (cap enforcement on bridge create)
- `packages/core/src/config.ts` (extend policy schema if needed)
- `agent-wallet.config.example.json` (document the new policy keys)

---

### Phase 3 — Occurrence history endpoint + UI

Goal: every schedule has a clean, plain-English timeline.

**3.1 Occurrence history endpoint.**
- New route: `GET /api/recurring/:id/occurrences?status=&cursor=&limit=` in `recurringRoutes.ts`.
- Service method `RecurringService.listScheduleOccurrences(session, scheduleId, { status?, cursor?, limit? })` that calls `store.listOccurrences(walletAddress, scheduleId)`, filters by status if provided, paginates by `createdAt DESC`, returns `{ occurrences, nextCursor }`.
- For each occurrence, hydrate `approval` (lightweight `{ id, status, decidedAt, txid, txStatus, explorerUrl }`) and `completed` (`{ id, txid, confirmedAt }`) by joining via `approvalRequestId` and `completedRecordId`. Both already exist on the occurrence record. Add `WorkflowStore.listApprovalRequestsByIds(wallet, ids[])` and `listCompletedByIds(wallet, ids[])` to avoid N+1 queries.
- Postgres path: extend `postgresStore.ts` with the two batch lookups using `ANY($1::uuid[])`.
- Memory path: extend `memoryStore.ts` with array filters.
- **Acceptance:** GET returns paginated occurrences with hydrated approval/completed sub-objects; deep tests for filtering by status and cursor pagination.

**3.2 Plain-English status mapper.**
- New helper in `packages/workflow/src/index.ts` (or a new `packages/workflow/src/labels.ts`): `formatOccurrenceStatus(status, approval?)` returning `{ label, tone }` where label is one of *Awaiting approval | Approved | Executed | Skipped | Failed | Cancelled* and tone is one of `info | success | warning | danger | muted`. Logic:
  - `ready` + no approval → "Awaiting approval" (info)
  - `approval_pending` → "Awaiting approval" (info)
  - `completed` + approval.txStatus = 'confirmed' → "Executed" (success)
  - `completed` + no txid → "Approved" (success)
  - `failed` → "Failed" (danger) with error tooltip
  - `cancelled` → "Cancelled" (muted)
  - `skipped` → "Skipped" (warning)
- This honors the memory note about plain-English receipt language. No raw enum tokens in primary UX.
- **Acceptance:** unit test covers all branches; UI uses only labels from this mapper, never raw status strings.

**3.3 Occurrence history UI.**
- In `apps/browser-demo/src/main.ts`, on the recurring schedule detail view, add a tabbed section: **Upcoming runs** (from `previewUpcoming`) and **History** (from `GET /api/recurring/:id/occurrences`).
- Each row: due date (relative + absolute), status pill via `formatOccurrenceStatus`, action affordances (View approval, View receipt, Copy txid). Failed rows expand to show the `error` text.
- Empty state: "No runs yet. Your first run is scheduled for {nextDueAt}. Each run will appear here once it materializes."
- Pagination: "Show older" loads next cursor.
- Trust strip at top of recurring detail view: *"Each run appears in your Approval Inbox. Nothing executes without your wallet signature."*
- **Acceptance:** manual smoke — create a schedule, force-tick the materializer, see the new occurrence with "Awaiting approval"; approve it, see "Approved"; wait for tx confirmation polling (out of this push's scope but the field is there), see "Executed".

**Files in scope (Phase 3):**
- `apps/render-web/src/cloud/recurringRoutes.ts` (new route)
- `apps/render-web/src/cloud/recurringService.ts` (listScheduleOccurrences)
- `apps/render-web/src/cloud/postgresStore.ts` (batch lookups)
- `apps/render-web/src/cloud/memoryStore.ts` (batch lookups)
- `packages/workflow/src/labels.ts` (new — plain-English status mapper)
- `packages/workflow/src/index.ts` (export labels)
- `apps/browser-demo/src/main.ts` (history UI + trust strip)
- `apps/browser-demo/src/styles.css` (status pill styles)

---

### Phase 4 — Notifications: in-app + webhook (defer email)

Goal: when an occurrence becomes ready for approval, the user finds out.

**4.1 In-app badge.**
- The Approval Inbox tab already counts pending items. Confirm it includes `recurringOccurrenceId`-linked approvals (it should — they go through the same approval path). Add a visual ping (CSS animation) when a *new* recurring-originated approval arrives since the last visit. Track last-seen timestamp in `localStorage` keyed by wallet.
- No backend change required if the inbox already shows recurring approvals. If not, audit `WorkflowService.listApprovals` (`workflowService.ts:138-200` neighborhood) and ensure recurring-sourced approvals are included.
- **Acceptance:** create a schedule due in 30s, leave the page open, see a ping appear on the inbox tab when materializer fires.

**4.2 Webhook delivery service.**
- New file: `apps/render-web/src/cloud/notificationService.ts`.
- Public API: `enqueueOccurrenceReady(walletAddress, scheduleId, occurrenceId)`. Reads the schedule, checks `notifications.webhookUrl`, builds payload `{ type: 'recurring.occurrence.ready', scheduleId, occurrenceId, dueAt, summary, walletAddress, cluster, amount, token, recipient }`, signs with HMAC-SHA256 over the JSON body using `notifications.webhookSecret`, sends `POST` with header `X-Agentic-Signature: sha256=<hex>` and `X-Agentic-Delivery-Id: <uuid>`.
- Delivery state stored in a new table `recurring_notification_deliveries`: `id, schedule_id, occurrence_id, payload, status (pending|delivered|failed|abandoned), attempts, next_attempt_at, last_error, created_at, updated_at`. Postgres migration.
- Retry strategy: exponential backoff at 30s, 2m, 10m, 1h, 6h, 24h. After 6 failed attempts, mark `abandoned` and append audit event `recurring.notification.abandoned`. Successful 2xx → `delivered`.
- Delivery tick: separate from the materialize cron to avoid coupling. Add a `pnpm -F render-web notifications:deliver` script that processes pending/due deliveries; add a third Render cron in `render.yaml` running every minute.
- **Acceptance:** smoke test with a local webhook receiver (e.g., webhook.site) — schedule materializes, webhook fires within one cron cycle, signature verifies.

**4.3 Wire the materializer to enqueue.**
- After successful occurrence creation in `recurringService.ts` materialization (around the existing `claimOccurrence` success path), if `schedule.notifications?.webhookUrl` is set, call `notificationService.enqueueOccurrenceReady`.
- The scheduler's `onTick` callback (`scheduler.ts:8`) is *not* used for this — coupling delivery to tick cadence makes failures cascade. Direct enqueue from the materializer is cleaner.
- **Acceptance:** integration test that mocks the notification service, verifies enqueue is called exactly once per occurrence, never on duplicate-claim paths.

**4.4 UI for notifications setting.**
- On the schedule create form: add an optional "Webhook URL" input. When present, generate a 32-byte secret server-side and return it once to the client (only in the create response — never on subsequent reads). UI shows the secret with a "Copy and store this — we won't show it again" affordance.
- On the schedule detail view: show a "Notifications" panel — webhook URL (if set), last delivery attempt, last delivery status. Allow "Rotate secret" (generates and returns a new one once).
- **Acceptance:** create a schedule with webhook → secret shown once → webhook delivers signed payload → secret rotation invalidates old signatures.

**4.5 Email is explicitly deferred.**
- Add a TODO marker in `notificationService.ts` and a `notifications.email?` field reservation in the schema (commented as future). Choosing a transactional provider (Resend, Postmark, AWS SES) is a separate decision and requires API keys — out of scope here.

**Files in scope (Phase 4):**
- `apps/render-web/src/cloud/notificationService.ts` (new)
- `apps/render-web/src/cloud/migrations/00X_add_recurring_notification_deliveries.ts` (new)
- `apps/render-web/src/cloud/postgresStore.ts` (delivery CRUD)
- `apps/render-web/src/cloud/memoryStore.ts` (delivery CRUD for tests)
- `apps/render-web/src/cloud/recurringService.ts` (enqueue on materialize)
- `apps/render-web/src/cli.ts` (add `notifications:deliver` script entry)
- `apps/render-web/package.json` (script: `notifications:deliver`)
- `render.yaml` (third cron job)
- `apps/browser-demo/src/main.ts` (webhook URL + secret UI)

---

### Phase 5 — Polish: countdown, risk preview, copy

Goal: the schedule create flow shows the user what they're about to commit to.

**5.1 Risk metadata at creation.**
- In `RecurringService.createSchedule`, after building the prospective record, compute `riskMetadata`:
  - `lifetimeSpend` (from Phase 2.2)
  - `automationRate` — runs per day implied by the cadence
  - `recipientClass` — `'self' | 'allowlisted' | 'known' | 'new'` based on whether recipient is the wallet itself, in any allowlist (e.g., `USDC_ALLOWLIST` referenced in config), or has been a recipient of any prior approval for this wallet (query `WorkflowStore.hasPriorRecipient(wallet, recipient)`).
  - `slippageBpsCap` (mirror of the field) for swaps
- Persist on the record. Surface on the view.
- **Acceptance:** new schedule has `riskMetadata` populated; existing schedules created before this phase still load (riskMetadata stays undefined).

**5.2 "Next 5 runs" preview in create flow.**
- Browser create form: live-preview the next 5 occurrences as the user types (using `previewUpcoming`). Show as a compact list: *"Next runs: Fri Nov 13 10:00 → Fri Nov 20 10:00 → Fri Nov 27 10:00 → ..."*.
- Show lifetime spend: *"This schedule will run up to 12 times and spend up to 60 USDC total."*
- If a wallet policy cap is in effect (Phase 2.3), show it inline: *"Within your configured cap of 100 USDC/month."*
- **Acceptance:** changing cadence/amount updates the preview without a server roundtrip (cadence helpers run client-side via the workflow package).

**5.3 Trust strip on recurring tabs.**
- One-line copy at the top of every recurring view: *"Each run requires your wallet signature. Agentic never signs for you."*
- Lock icon. Color: brand neutral. Per the Saturn-glow memory note, avoid blue glow if any icon variant is used near it; use the SaturnPng (green) variant exclusively.
- **Acceptance:** copy is visible on create form, list view, detail view.

**5.4 Pause/resume polish.**
- Add convenience routes: `POST /api/recurring/:id/pause` and `POST /api/recurring/:id/resume` that internally call `updateSchedule` with the right status. Existing PATCH continues to work.
- Add matching audit events: `recurring.schedule.paused`, `recurring.schedule.resumed`.
- Browser detail view: a single primary button that flips between "Pause" and "Resume" based on current status.
- **Acceptance:** one-tap pause/resume from the UI; audit trail shows the action.

**Files in scope (Phase 5):**
- `apps/render-web/src/cloud/recurringService.ts` (riskMetadata computation, pause/resume helpers)
- `apps/render-web/src/cloud/recurringRoutes.ts` (pause/resume routes)
- `apps/render-web/src/cloud/postgresStore.ts` (`hasPriorRecipient` query — uses existing approvals table indexed on recipient)
- `apps/browser-demo/src/main.ts` (next-5 preview, lifetime spend display, trust strip, pause/resume button)

---

### Phase 6 — MCP parity for new fields

Goal: local-bridge users get the same features.

**6.1 Expose `expiresAt`, `notifications.webhookUrl`, `notifications.inApp` through MCP.**
- Update `recurringInputSchema` in `packages/mcp-server/src/actionTools.ts:387-410`:
  - `expiresAt: z.string().datetime().optional()`
  - `notifications: z.object({ inApp: z.boolean().optional(), webhookUrl: z.string().url().optional() }).optional()`
- Bridge `RecurringPayment` (`preparedActions.ts:44-65`) gets matching fields. The webhook *secret* is local-bridge-generated on-the-fly (no Postgres there); store in the JSON-backed file alongside the payment record.
- Bridge-side notification delivery is best-effort (single attempt at materialize time, logged, no retry queue) — persistence and retries are a cloud-only feature for this push.
- Update `service.createRecurringPayment`, `service.listRecurringPayments` to round-trip the new fields.
- Update `solana_create_recurring_payment` tool description to mention the new options.

**6.2 Document the new tool surface.**
- Update `packages/mcp-server/README.md` (recurring section) with a snippet showing `expiresAt` and `notifications.webhookUrl`.
- Update `docs/SCENARIO_TESTS.md` with one new prompt: *"Create a weekly USDC payment that expires on 2026-12-31 and notify webhook https://...".*
- **Acceptance:** Claude Desktop with the MCP can create a schedule with the new fields; bridge stores them in `.agent-wallet/prepared-actions.json`.

**Files in scope (Phase 6):**
- `packages/mcp-server/src/actionTools.ts`
- `packages/mcp-server/src/actionService.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `packages/mcp-server/README.md`
- `docs/SCENARIO_TESTS.md`

---

### Phase 7 — Tests, smoke, and stale-document updates

Goal: lock in correctness and update internal docs to reflect the new surface.

**7.1 Test coverage additions.**
- `packages/workflow/src/__tests__/cadence.test.ts` (new) — `previewUpcoming` and `lifetimeSpendEstimate` across all cadences, with and without caps and expiry.
- `apps/render-web/src/__tests__/recurring-routes.test.ts` (extend) — webhook secret never returned on read after create; pause/resume routes; occurrence history pagination + filter.
- `apps/render-web/src/__tests__/notification-service.test.ts` (new) — HMAC signature correctness, retry backoff, abandonment after 6 failures, no double-delivery on duplicate enqueue.
- `apps/render-web/src/__tests__/recurring-policy.test.ts` (new) — schedule creation rejected when over policy cap; accepted when under; passes when no policy is configured.
- `packages/mcp-server/src/__tests__/recurring.test.ts` (extend) — bridge-side `expiresAt` honored at materialize time.

**7.2 Smoke guide.**
- New file `docs/smoke/recurring-production.md` — manual end-to-end checklist:
  1. Sign in to cloud, create weekly schedule with maxOccurrences=3 and expiresAt=+10days
  2. Force-tick materializer, observe inbox item
  3. Approve in wallet, observe completed
  4. Re-tick, observe second occurrence
  5. Set webhook URL (use webhook.site), re-tick, observe signed payload delivered
  6. Pause schedule, re-tick, observe no new occurrences
  7. Resume schedule, set expiresAt to 1 minute in past, re-tick, observe schedule completed
  8. Try to create schedule that exceeds policy cap, observe plain-English rejection
  9. Open occurrence history, confirm plain-English status labels and Trust strip visible

**7.3 Update existing planning docs.**
- Update `AGENTIC_CLOUD_WORKFLOW_PLAN.md` "Phase 5, Cloud Recurring Scheduler" status block: reference this plan for the production-grade upgrade work; do not re-open Phase 5 there.
- Update `STATUS.md` and `PROGRESS.md` with a section for "Recurring production-grade upgrade" linking to the root `RECURRING_PLANS_PRODUCTION_PLAN.md`.
- Do **not** touch `feedback_*.md` memory files — those are user feedback memories.

**Files in scope (Phase 7):**
- `packages/workflow/src/__tests__/cadence.test.ts` (new)
- `apps/render-web/src/__tests__/recurring-routes.test.ts`
- `apps/render-web/src/__tests__/notification-service.test.ts` (new)
- `apps/render-web/src/__tests__/recurring-policy.test.ts` (new)
- `packages/mcp-server/src/__tests__/recurring.test.ts`
- `docs/smoke/recurring-production.md` (new)
- `AGENTIC_CLOUD_WORKFLOW_PLAN.md`, `STATUS.md`, `PROGRESS.md` (status notes)

---

## Critical Files Index (full set, deduped)

| Area | File |
|---|---|
| Shared schema | `packages/workflow/src/index.ts` |
| Shared cadence | `packages/workflow/src/cadence.ts` (new) |
| Plain-English labels | `packages/workflow/src/labels.ts` (new) |
| Cloud service | `apps/render-web/src/cloud/recurringService.ts` |
| Cloud routes | `apps/render-web/src/cloud/recurringRoutes.ts` |
| Cloud notification service | `apps/render-web/src/cloud/notificationService.ts` (new) |
| Cloud migrations | `apps/render-web/src/cloud/migrations/00X_add_recurring_expires_at.ts`, `..._notifications.ts`, `..._notification_deliveries.ts` (all new) |
| Cloud Postgres | `apps/render-web/src/cloud/postgresStore.ts` |
| Cloud Memory store | `apps/render-web/src/cloud/memoryStore.ts` |
| CLI entry | `apps/render-web/src/cli.ts`, `apps/render-web/package.json` |
| Render config | `render.yaml` |
| Bridge data | `packages/mcp-server/src/preparedActions.ts` |
| Bridge service | `packages/mcp-server/src/actionService.ts` |
| Bridge MCP tools | `packages/mcp-server/src/actionTools.ts` |
| Browser UI | `apps/browser-demo/src/main.ts`, `apps/browser-demo/src/styles.css` |
| Config | `packages/core/src/config.ts`, `agent-wallet.config.example.json` |
| Docs | `packages/mcp-server/README.md`, `docs/SCENARIO_TESTS.md`, `docs/smoke/recurring-production.md` (new) |
| Status docs | `AGENTIC_CLOUD_WORKFLOW_PLAN.md`, `STATUS.md`, `PROGRESS.md` |

## Reusable Utilities (do NOT reinvent)

| Utility | Location | Reuse for |
|---|---|---|
| `verifyWalletSignature` | `apps/render-web/src/cloud/auth.ts` | webhook secret HMAC pattern is parallel — copy structure, not the function |
| `redactSecrets` | `apps/render-web/src/cloud/redaction.ts` | error messages on cap-exceedance and notification failures |
| `parseDecimalAmount` / `formatRawAmount` | `packages/mcp-server/src/amounts.ts` | lifetime spend math |
| Postgres advisory locks | `apps/render-web/src/cloud/postgresStore.ts` migration helpers | reuse for new migrations |
| Approval-sink pattern | `apps/render-web/src/cloud/recurringApprovalSink.ts` | already wires per-run approvals — do not duplicate |
| `RecurringScheduler.onTick` | `apps/render-web/src/cloud/scheduler.ts:8` | leave as-is; notifications enqueue from materializer instead |

---

## Verification Matrix

| Phase | What to verify | How |
|---|---|---|
| 1 | Cadence math identical post-consolidation; new fields round-trip | `pnpm -r test`; manual create with `expiresAt` and `notifications` set, GET back, confirm |
| 2 | Schedule auto-completes at expiry; lifetime spend correct; policy rejection plain-English | Smoke step 7+8 from `docs/smoke/recurring-production.md` |
| 3 | Occurrence history paginates, filters, hydrates approval/completed; status labels plain-English | Smoke step 9; route tests |
| 4 | Webhook fires once per occurrence with valid HMAC; retries on 5xx; abandons after 6 failures | Smoke step 5; `notification-service.test.ts` |
| 5 | Risk metadata populated; next-5 preview live; pause/resume one-tap | Smoke steps 6+; manual UI walkthrough |
| 6 | MCP can create schedules with `expiresAt` + webhook; bridge fires single-shot delivery | Manual via Claude Desktop; bridge JSON file inspection |
| 7 | All tests green; smoke guide passes end-to-end on staging | `pnpm -r test`; manual smoke run on Render staging URL |

---

## Sequencing & Estimates

| Phase | Description | Est. effort | Blocks |
|---|---|---|---|
| 1 | Schema + cadence consolidation | 1 day | foundation for 2-7 |
| 2 | Expiry + spend cap | 1.5 days | enables 5.2 |
| 3 | Occurrence history endpoint + UI | 1.5 days | none |
| 4 | Webhook notification service | 2 days | none (after 1) |
| 5 | Risk preview + UI polish | 1.5 days | benefits from 2 |
| 6 | MCP parity | 1 day | after 1 |
| 7 | Tests, smoke, stale-doc updates | 1 day | last |
| **Total** | | **~9.5 days** | |

Phases can interleave: 3 and 4 are independent after 1; 5 benefits from but does not require 2; 6 is independent.

---

## Out-of-Scope (intentional)

- Email notifications (deferred — no provider chosen, no API keys to spend)
- The other 8 items from the user's roadmap list (production deploy, tx finalization, AI guardrails, evidence receipts, growth, advanced signing, etc.) — captured in earlier draft but not part of this push
- Cross-chain recurring (Solana-only)
- Recurring schedule sharing or multi-signer approval workflows
- Smart-account or session-key delegation for recurring (would defeat the per-run wallet-approval boundary, which is the product's core promise)
- Mobile-app changes (browser-demo is responsive; native iOS/Android apps are not in scope)
- Marketing/landing copy about recurring being "the killer feature" — content/growth work belongs in user-prompt item #8, which is explicitly excluded from this push

---

## Recurring connector + Blink policy (added 2026-05-13)

This section captures the rules for **recurring connector actions** (Kamino deposit on a schedule, Marginfi repay on a schedule, etc.) and **recurring Blink actions** (Solana Action URLs run on a schedule). It supplements the cascading-dropdown + Blink-classifier work described in `CONNECTOR_GRANULARITY_PLAN.md`.

### Schema

`RecurringPayment.actionKind` may be `'transfer' | 'swap' | 'connector' | 'blink'`. For connector/blink kinds, `connectorActionTemplate` carries:

- `connectorId` — the Solana protocol connector id (e.g. `kamino`, `jupiter`, `meteora`)
- `actionType` — the PreparedActionKind to re-prepare each occurrence (e.g. `kamino_deposit`, `jupiter_lend_earn_deposit`)
- `subActionId` — optional sub-action branch id (e.g. `earn-deposit`, `cpmm-add`)
- `params` — the parametric form values captured at create time (token, amount, reserveMint, vaultAddress, etc.)
- `blinkUrl` — only for `actionKind === 'blink'`

`materializeDueRecurring` emits one prepared action per occurrence with the template's params plus `pendingPrepare: 'true'`. The existing approval+execute pipeline runs the prepare → review → wallet-signature flow per occurrence; we never freeze stale transaction bytes.

### Cadence floor

Recurring Blinks require **cadence ≥ 1 day**. Sub-daily cadences (`interval_minutes`, `interval_hours` with intervalMinutes < 60×24) are rejected at create time with a `invalid_request` error. Connector recurring (non-Blink) inherits the same cadence rules as transfer/swap.

### Initial classification gate (deferred)

The full multi-reviewer Blink classifier runs **per occurrence** via `aiReviewMessages` (`packages/mcp-server/src/aiPlanner.ts`) when the prepared action is reviewed before wallet approval. The taxonomy in `packages/mcp-server/src/blinkClassification.ts` maps categories to default verdicts:

- `disguised_transfer`, `token_account_drain` → `deny`
- `unknown_program_interaction`, `unparseable` → `needs_input`
- `safe_claim`, `safe_governance_vote`, `safe_donation_or_tip`, `lp_position_management`, `nft_marketplace`, `mint_or_buy` → `approve`

Because every occurrence still passes through wallet approval, a Blink whose classification drops between occurrences (e.g. the host swapped the response shape) will be caught by the per-occurrence review and surface as a needs-input/deny inbox item. The user can pause or delete the schedule from there.

A stricter **create-time classification gate** (rejecting a recurring Blink whose initial simulation already trips `closesTokenAccount` or `transfersSpl` to unknown recipients) is deferred — the per-occurrence reviewer is the primary safeguard, and front-running the gate requires fetching/simulating the Blink at create time with side-effects to the Blink host.

### Host allowlist

Per `feedback_allowlist_user_feature` in memory, allowlists are a **user feature, not backend enforcement**. The backend does not maintain a global recurring Blink allowlist; users decide what they trust via the existing token/recipient allowlist controls in the UI.

### Failure handling

`materializeDueRecurring` emits each occurrence into the prepared-actions store. If the per-occurrence prepare step fails (pool removed, reserve closed, Blink host offline), the prepared action is marked `failed` with the error in `txError`. The recurring schedule keeps running by default; product can later add a `consecutiveFailures` auto-pause threshold (the field is already on the `RecurringPayment` schema).

### Out of scope here

- Auto-deleting recurring schedules — paused but not deleted; user must explicitly delete
- Mid-flight reclassification telemetry/UX (notification when category drifts)
- Per-occurrence dry-run preview before promotion to wallet approval
