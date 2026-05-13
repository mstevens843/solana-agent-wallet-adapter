# Connector Plan Parallel Execution Map

## Purpose

This folder is for the connector and Blink work that came out of the gap analysis.
The app already has the important core behavior:

- The browser app can prepare Blink/Solana Action URLs into browser-local approval work.
- Users can draft requests without AI.
- AI is optional and only helps fill structured drafts.
- The user wallet remains the signer in every flow.
- Preferences already contains protocol connector setup.

The missing product layer is not "add Blinks from zero." The missing layer is:

1. Connect protocol connectors more directly into the New Request drafting form.
2. Let external agents and local runtimes create the same Blink approval requests that the browser can already create.
3. Make CLI, desktop, and cloud understand the same connector-backed request model.

The product sentence for all work in this folder:

> Connectors define what can be prepared. AI and external agents only help fill the draft. Wallet approval always comes back to the user.

## Parallel Ownership

These plans are intentionally split to avoid file overlap as much as possible.

| Plan | Owner Scope | Primary Files | Must Not Touch |
| --- | --- | --- | --- |
| `01-new-request-connector-steering.md` | Browser New Request UX and planner constraints | `apps/browser-demo/src/planner.ts`, `apps/browser-demo/src/main.ts`, `apps/browser-demo/src/connectedDapps.ts`, browser tests | MCP server, CLI, desktop, cloud backend |
| `02-mcp-local-bridge-blink-runtime-parity.md` | MCP/local bridge ability to create Blink prepared actions | `packages/mcp-server/src/*`, MCP server tests | Browser New Request UI, CLI UI, desktop UI, cloud backend |
| `03-cli-desktop-blink-parity.md` | CLI and desktop visibility/commands for Blink prepared actions | `packages/cli/src/*`, `apps/desktop-shell/src/*`, related tests/docs | Browser planner, MCP tool internals, cloud backend |
| `04-cloud-blink-draft-storage.md` | Cloud storage/queue model for Blink draft records | `apps/render-web/src/cloud/*`, workflow cloud tests | Browser New Request UI, MCP server, CLI, desktop |

If a worker needs a tiny type change in a shared file, they should isolate it and document it in their final notes. Do not rewrite broad modules or do opportunistic refactors.

## Current State Summary

Browser Blink support already exists:

- `apps/browser-demo/src/protocolActions.ts`
  - `normalizeBlinkUrl`
  - `fetchBlinkMetadata`
  - `prepareBlinkAction`
  - single and multi-transaction response normalization
- `apps/browser-demo/src/planner.ts`
  - has a `protocol-blink-action` template
  - has `blink_action` prompt handling
- `apps/browser-demo/src/main.ts`
  - can queue `blink_action`
  - resolves browser-local Blink transaction bytes
  - stores the result as a browser-local `custom_transaction`
  - executes the transaction through the connected wallet
- `apps/browser-demo/src/__tests__/protocolActions.test.ts`
  - covers URL normalization, metadata fetch, transaction prepare, and errors

MCP/runtime parity is still the main gap:

- `packages/mcp-server/src/preparedActions.ts` does not include `blink_action` or `custom_transaction`.
- `packages/mcp-server/src/actionTools.ts` does not expose `solana_prepare_blink_action`.
- `packages/mcp-server/src/connectorRegistry.ts` still marks most Blink-backed protocols unavailable in MCP runtime.
- `apps/browser-demo/src/main.ts` currently says Agentic Cloud does not resolve Blink actions and falls back to browser-local workflow.

## Non-Negotiable Product Rules

- AI must remain optional.
- Manual/template drafting must continue to work without AI.
- Cloud storage must remain optional.
- External agents must never receive wallet signing authority.
- No flow may claim that Agentic signs, submits, or approves without the user wallet.
- If required connector facts are missing, the app must ask for them or block preparation.
- If a connector is disabled, executable connector drafting must be blocked with a useful message.

## Recommended Merge Order

The plans can be implemented in parallel, but the clean final integration order is:

1. Plan 1: browser connector steering, because it improves the current user-visible app immediately.
2. Plan 2: MCP/local bridge Blink runtime parity.
3. Plan 3: CLI/desktop display and command parity after Plan 2 defines the durable prepared action shape.
4. Plan 4: cloud storage parity after the final Blink metadata shape is stable.

## Shared Acceptance Criteria

The whole project is complete when:

- A non-AI user can choose a connector in New Request and draft connector-backed work.
- An AI user can choose a connector and have AI constrained to that connector.
- An external MCP agent can prepare a Blink approval request without signing.
- CLI and desktop can see Blink-prepared actions clearly.
- Cloud can store connector/Blink drafts without pretending it can sign or resolve everything server-side.
- Every path returns to the same user wallet approval boundary.

