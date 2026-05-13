# Cloud Workflow And Recurring Agent Backend Plan

## Ownership

This workstream owns only:

- `packages/workflow/**`
- `apps/render-web/**`

Do not edit:

- `apps/browser-demo/**`
- `packages/mcp-server/**`
- `docs/**`
- `scripts/**`
- `spec/**`

## Goal

Make hosted Agentic Cloud fully support agent-reviewed recurring schedules and connector-shaped action metadata without depending on browser-local assumptions.

## Current Baseline

Already implemented:

- `CreateRecurringRequest` accepts optional `status`.
- Cloud recurring service can create paused schedules.
- Cloud recurring schedule metadata can carry `agentReview`.
- Cloud recurring swaps can materialize swap approvals.

Still incomplete:

- Cloud recurring API does not have a first-class agent-review audit story.
- Cloud recurring materialization does not yet expose enough review metadata on occurrences.
- Cloud recurring updates do not deeply validate agent-review metadata.
- Cloud workflow does not have connector fact/action metadata conventions.

## Non-Goals

This workstream must not implement browser UI.

This workstream must not implement MCP connector reads or writes.

This workstream must not create eval scripts outside existing cloud/workflow tests.

## Required Outcomes

### 1. Agent Review Metadata Contract

Define and validate a stable metadata shape for recurring schedule review state.

Suggested shape:

```ts
interface RecurringAgentReviewMetadata {
  agentReview?: JsonObject;
  agentReviewStatus?: 'checking' | 'approved' | 'denied' | 'needs_input' | 'error';
  agentReviewDecision?: 'approve' | 'deny' | 'needs_input' | '';
  agentReviewCheckedAt?: string;
  agentReviewProvider?: string;
  agentReviewModel?: string;
}
```

Requirements:

- Validation must reject forbidden secrets in nested metadata.
- Validation must allow flexible findings and facts.
- Validation must preserve unknown safe metadata keys.
- Validation must not require the browser's exact TypeScript type.

Definition of done:

- Create recurring with paused review metadata succeeds.
- Create recurring with forbidden secret in review metadata fails.
- Patch recurring review metadata succeeds.

### 2. Recurring Agent Audit Trail

Cloud audit events should clearly show agent involvement.

Add or enrich audit events for:

- schedule created active by agent approval
- schedule created paused by agent denial
- schedule paused by agent re-review
- schedule resumed by agent re-review
- schedule manually paused/resumed by user

Requirements:

- Audit event metadata must include status transition.
- Audit event metadata must include safe review summary fields only.
- No secrets or full raw prompts in audit metadata.

Definition of done:

- Tests assert audit event types and transition metadata.

### 3. Occurrence Metadata Propagation

When a recurring schedule materializes an occurrence, approval requests should carry enough schedule/review context for downstream UI.

Requirements:

- Approval params or metadata should include:
  - recurring schedule id
  - occurrence id
  - occurrence key
  - action kind
  - connector id if present
  - agent review status if present
  - review summary or reason if present
- Do not duplicate large raw review objects unless already part of the schedule metadata contract.
- Preserve existing recurring occurrence behavior.

Definition of done:

- Materialized recurring approval can be traced back to review status.
- Existing recurring tests still pass.

### 4. Connector-Shaped Cloud Metadata

Cloud workflow contracts should accept connector metadata for future browser/MCP integration.

Suggested safe keys:

- `connectorId`
- `connectorName`
- `operation`
- `market`
- `pool`
- `reserve`
- `readiness`
- `factLabels`
- `actionSource`
- `approvalBoundary`

Requirements:

- These keys can be present in recurring schedule metadata and approval metadata.
- Forbidden secrets remain blocked.
- Unknown safe metadata remains allowed.

Definition of done:

- Tests cover connector metadata on approval and recurring schedule creation.

### 5. Cloud Recurring API Behavior

Ensure hosted recurring behavior matches product semantics:

- Active schedules can materialize occurrences.
- Paused schedules do not materialize occurrences.
- Agent-denied schedules are paused.
- User can later patch status to active.
- Max occurrences and expiry still work.
- Recurring swaps still materialize as swap approvals.

Definition of done:

- Existing recurring API tests pass.
- New tests cover paused-by-agent create and resume.

### 6. Tests

Add or extend tests under:

- `packages/workflow/src/__tests__/**`
- `apps/render-web/src/__tests__/**`

Run:

- `pnpm -F @solana-agent-wallet-adapter/workflow build`
- `pnpm -F @solana-agent-wallet-adapter/workflow test`
- `pnpm -F @solana-agent-wallet-adapter/render-web build`
- `pnpm -F @solana-agent-wallet-adapter/render-web test`

## Deliverable Summary

The final report should list:

- Workflow contract changes.
- Cloud recurring audit events added.
- Metadata propagation behavior.
- Tests added.
- Any UI or MCP integration requirements left for other workstreams.
