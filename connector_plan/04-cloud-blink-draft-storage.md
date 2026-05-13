# Plan 04: Cloud Blink Draft Storage

## Goal

Let Agentic Cloud store and queue connector/Blink draft records without pretending the cloud can sign or fully resolve every Blink action server-side.

This is a storage and workflow consistency plan, not a signing plan.

Core product rule:

> Cloud can remember and queue the user's intent. The user's wallet still performs final approval and signing.

## Current State

The browser already handles Blink execution locally.

Current cloud limitation:

- Browser code reports that Agentic Cloud does not resolve Blink actions yet.
- Cloud finalization support is strongest for SOL transfers.
- Cloud can store approvals and recurring records, but Blink draft handling is not first-class.

## Scope

In scope:

- Cloud accepts a `blink_action` approval/draft record.
- Cloud stores connector metadata and URL constraints.
- Cloud clearly marks whether finalization is local/browser-only.
- Cloud APIs return enough metadata for the browser to resolve the Blink locally.
- Cloud never signs or claims to sign.

Out of scope:

- Browser New Request connector picker.
- MCP local bridge helper.
- CLI/desktop UI.
- Server-side transaction signing.
- Full server-side Blink transaction resolution, unless a safe existing pattern already supports it.

## Owned Files

Primary files:

- `apps/render-web/src/cloud/workflowService.ts`
- `apps/render-web/src/cloud/workflowRoutes.ts`
- `apps/render-web/src/cloud/memoryStore.ts`
- `apps/render-web/src/cloud/postgresStore.ts` only if schema/index changes are needed
- `apps/render-web/src/cloud/*test*` or existing cloud test files

Shared workflow file changes should be avoided unless absolutely necessary. If a shared type change is required, keep it tiny and document it.

## Cloud Data Shape

Cloud approval metadata for Blink action should include:

```ts
{
  actionType: 'blink_action',
  connectorId?: string,
  protocol?: string,
  operation?: string,
  blinkUrl?: string,
  actionUrl?: string,
  position?: string,
  amount?: string,
  expectedToken?: string,
  expectedRecipient?: string,
  connectorActionSource: 'blink',
  finalizationSupport: {
    mode: 'browser_local',
    reason: 'Blink transaction bytes are resolved in the browser before wallet approval.'
  }
}
```

Prefer metadata over schema migrations unless existing schemas require strict fields.

## API Behavior

Cloud should allow creating/storing a `blink_action` approval request if:

- wallet session is valid
- action kind is `blink_action`
- URL is present and syntactically valid enough for storage
- connector metadata is valid if provided

Cloud should not:

- sign
- submit
- claim server-side finalization is ready
- fetch arbitrary Blink URLs from server unless SSRF protections are implemented

Recommended v1:

- Store Blink URL and constraints.
- Return record to browser.
- Browser resolves and signs locally when user approves.

## Browser Handoff Contract

Cloud response should give the browser enough to do what the browser already does:

- identify action as `blink_action`
- read `blinkUrl` or `actionUrl`
- resolve via browser `prepareBlinkAction`
- store/execute as browser-local custom transaction

If current browser code falls back to browser-local workflow for Blink, preserve that behavior. This plan only makes cloud records durable and explicit.

## Security Requirements

- Do not server-fetch arbitrary URLs unless SSRF defenses exist.
- Do not store wallet auth secrets.
- Do not store provider API keys.
- Do not store signed transaction bytes unless there is already a safe transaction-finalization pattern for it.
- Keep all copy explicit that wallet approval is required.

## Tests

Add or update cloud tests for:

- Cloud accepts `blink_action` draft metadata.
- Cloud rejects missing URL for executable Blink action.
- Cloud stores connector metadata.
- Cloud marks finalization as browser-local or unsupported, not server-signed.
- Existing SOL transfer finalization behavior is unchanged.
- Existing recurring behavior is unchanged.

## Acceptance Criteria

This plan is complete when:

- Signed-in users can save/queue Blink draft records in cloud.
- Cloud returns enough metadata for browser-local approval resolution.
- Cloud does not pretend to execute or sign Blink transactions.
- Browser-local Blink approval remains the final wallet signing path.
- MCP, CLI, desktop, and browser UI files were not modified by this plan.

