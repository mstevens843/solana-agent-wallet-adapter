# Recurring Plans Production Completion Plan

## Summary

Recurring plans are now treated as a production workflow, not just persisted schedule data. The remaining completion work from the sweep focuses on secret-safe webhook reminders, reliable delivery, scalable occurrence history, explicit pause/resume auditing, robust policy loading, browser visibility, and smoke coverage.

The product boundary stays unchanged:

- AI can draft a schedule.
- Cloud can queue due occurrences.
- Each occurrence still returns to the Approval Inbox.
- The wallet is the only signer.
- Receipts and audit events persist.

## Implemented In This Sweep

- Webhook secrets are generated server-side and are revealed only once on create or rotate as `webhookSecretOnce`.
- Notification delivery records no longer persist webhook secrets.
- Webhook delivery signs `timestamp.body` and sends `X-Agentic-Delivery-Id`, `X-Agentic-Timestamp`, and `X-Agentic-Signature`.
- Notification delivery has a fetch timeout, retry state, abandoned audit events, and deterministic occurrence/type delivery ids.
- Materialization no longer depends on notification enqueue success; enqueue failures become audit events.
- Duplicate/recovery materialization paths attempt to repair missing notification deliveries.
- Recurring APIs expose notification status and secret rotation:
  - `GET /api/recurring/:id/notifications`
  - `POST /api/recurring/:id/notifications/rotate`
- Occurrence history hydration can use batch approval/completed lookups instead of scanning all wallet records.
- Pause/resume routes emit explicit audit events in addition to the underlying schedule update.
- Recurring policy config discovery searches up from the current working directory and compares decimal amounts without floating-point conversion.
- Recurring schedules compute `riskMetadata.recurring` with spend estimates, next-run preview, expiry/cap flags, notification enabled flag, and `perRunWalletApproval=true`.
- Browser recurring cards show notification status, secret reveal, rotate-secret controls, and shared cadence previews.

## Public Interfaces

- `POST /api/recurring` may return `webhookSecretOnce` when a webhook URL is supplied.
- `PATCH /api/recurring/:id` may return `webhookSecretOnce` when a webhook URL is newly enabled or changed.
- `GET /api/recurring/:id/notifications` returns the scrubbed notification status and recent deliveries.
- `POST /api/recurring/:id/notifications/rotate` rotates the webhook secret and returns the new secret once.
- MCP/local bridge supports recurring metadata fields but does not run the cloud webhook delivery cron.

## Verification Plan

- Workflow tests: cadence, expiry, spend estimates, labels, and validation.
- Render-web tests: recurring API, notification service, policy enforcement, Postgres store, and route registration.
- Browser tests/typecheck: recurring UI parsing, shared preview behavior, and notification controls.
- Manual smoke: create recurring schedule with webhook, copy one-time secret, materialize, deliver notification, rotate secret, pause/resume, inspect occurrence history, verify every run still requires wallet approval.

## Non-Recurring Test Drift

The evidence receipt audit expectation has been aligned with the current `intent_receipt_v1` schema. The full render-web suite now passes for this phase.

# Evidence Receipts Completion Sweep

## Summary

Evidence Receipts now need to behave like concrete wallet-bound proof objects, not an abstract lab feature. The completion target is:

- A user can sign proof of intent, policy, review, or rejection from the exact approval card.
- The wallet message explains the request, the proof use case, the receipt fields, and the evidence-only boundary.
- Receipt archives are searchable by request, policy, signed text, metadata, and linked approval.
- Cloud audit events can be filtered by the approval that caused the receipt.
- Activity panels load reliably and can be refreshed without requiring a full workspace sync.

## Implementation Decisions

- Keep the public `POST /api/evidence`, `GET /api/evidence`, and `GET /api/audit` shapes backward-compatible.
- Store source linkage in optional metadata only. Older receipts remain readable.
- Treat rejection as an action: `Deny with proof` signs a rejection receipt and then denies the approval. The standard `Deny request` button remains available for users who do not want an extra receipt.
- Canonical receipt types use stable values such as `intent_receipt_v1` rather than display titles.
- Server audit metadata records evidence identity separately from source identity:
  - `recordType=evidence`, `recordId=<receipt id>`
  - `sourceRecordType=approval`, `sourceRecordId=<approval id>`
  - `approvalId`, `proofUseCase`, `labId`, `browserArtifactId` when present

## Completed Hardening

- Evidence service audit events now preserve safe receipt/source metadata for `evidence.created` and `evidence.deleted`.
- Real evidence-created audit events are queryable through `/api/audit?recordType=approval&recordId=<approval id>`.
- Related receipt matching accepts `recordType/recordId`, `sourceRecordType/sourceRecordId`, `subjectType/subjectId`, and `approvalId`.
- Related receipt rows now support sharing, not only copy text/JSON.
- Receipt archive search includes signing messages, receipt type, field values, and metadata.
- Activity panels auto-load when rendered open and expose a manual refresh control.
- Inline rejection now reads as `Deny with proof` and performs the denial after signing the receipt.
- Receipt signing messages now include the use case, wallet, cluster, request text, receipt fields, proof statement, effect boundary, and pre-signature hash.

## Verification Plan

- `pnpm -F @solana-agent-wallet-adapter/render-web typecheck`
- `pnpm -F @solana-agent-wallet-adapter/render-web test`
- `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck`
- `pnpm -F @solana-agent-wallet-adapter/browser-demo test`
- Manual smoke:
  - create a cloud approval
  - sign intent/policy/review receipts
  - use `Deny with proof`
  - verify the related receipt block appears
  - open and refresh Activity
  - confirm `/api/audit?recordType=approval&recordId=<id>` includes `evidence.created`
