# Plan 02: MCP And Local Bridge Blink Runtime Parity

## Goal

Let external agents prepare Blink/Solana Action approval requests through the MCP server and local bridge, while preserving the same user-wallet approval boundary.

Current browser capability:

> User pastes/selects a Blink in Agentic, Agentic prepares transaction bytes, user reviews, wallet signs.

Target runtime capability:

> Claude/Codex/MCP server sends a Blink prepare request to Agentic, Agentic stores a durable approval inbox item, user reviews later, wallet signs.

Core product rule:

> External agents can prepare Blink-backed work, but only the user's existing wallet can approve and sign it.

## Current Gap

Browser Blink flow exists, but MCP/local bridge parity is missing.

Observed gaps:

- `packages/mcp-server/src/preparedActions.ts` does not include `blink_action` or `custom_transaction`.
- `packages/mcp-server/src/actionTools.ts` has no `solana_prepare_blink_action`.
- `packages/mcp-server/src/connectorRegistry.ts` marks Blink-backed connectors unavailable in MCP runtime.
- `packages/mcp-server/src/actionService.ts` cannot execute a prepared Blink action kind.

## Scope

This plan owns MCP/local bridge runtime only.

In scope:

- Add a durable prepared action kind for Blink-backed actions.
- Add a generic MCP tool for preparing Blink approvals.
- Add local bridge HTTP route if the bridge exposes action prepare routes directly.
- Add Blink URL normalization and preparation helpers for MCP runtime.
- Update connector registry readiness so Blink-backed connectors are honestly available when URL-based Blink prepare is supported.
- Ensure execution still requires the connected user wallet.

Out of scope:

- Browser New Request UI.
- CLI command syntax.
- Desktop UI.
- Cloud storage.
- AI prompt UX.

## Owned Files

Primary files:

- `packages/mcp-server/src/preparedActions.ts`
- `packages/mcp-server/src/actionTools.ts`
- `packages/mcp-server/src/actionService.ts`
- `packages/mcp-server/src/bridgeServer.ts`
- `packages/mcp-server/src/connectorRegistry.ts`

Likely new file:

- `packages/mcp-server/src/blinkActions.ts`

Tests:

- existing MCP server tests if present
- new unit tests near `packages/mcp-server/src/__tests__/`

Do not edit browser New Request files in this plan.

## Proposed MCP Tool

Add a tool:

```text
solana_prepare_blink_action
```

Description:

```text
Create a durable manual-approval inbox item for a Solana Action/Blink URL.
The agent supplies the action URL and expected facts. Agentic prepares wallet
approval work only; it does not sign, submit, or grant delegated authority.
```

Input schema:

```ts
{
  connector?: string;
  protocol?: string;
  operation?: string;
  blinkUrl: string;
  account?: string;
  parameters?: Record<string, string>;
  expectedAmount?: string;
  expectedToken?: string;
  expectedRecipient?: string;
  position?: string;
  note?: string;
  dueAt?: string;
}
```

Important:

- `account` should default to the connected wallet address.
- `parameters` are passed to the Blink POST call.
- `expected*` fields are review constraints, not signing authority.

## Prepared Action Shape

Add a prepared action kind:

```ts
type PreparedActionKind = ... | 'blink_action';
```

Store params like:

```ts
{
  connectorId?: string;
  protocol?: string;
  operation?: string;
  blinkUrl: string;
  actionUrl: string;
  transactionBase64?: string;
  blinkTitle?: string;
  blinkLabel?: string;
  blinkMessage?: string;
  expectedAmount?: string;
  expectedToken?: string;
  expectedRecipient?: string;
  position?: string;
  connectorActionSource: 'blink'
}
```

Prefer storing enough metadata to render and review the action later.

## Fetch Timing Decision

Use this v1 behavior:

1. At MCP prepare time:
   - normalize URL
   - fetch metadata when safe
   - POST to get transaction bytes only if wallet account is available and the existing browser behavior expects transaction bytes before inbox insertion
2. Store a prepared action; do not sign.
3. At approval/execution time:
   - simulate if available
   - sign through the connected user wallet
   - broadcast only after user approval

If transaction bytes expire often, store both the URL and metadata, and allow refresh before execution.

## Blink Helper

Port the browser helper behavior into MCP runtime without importing browser code directly unless the repo already has a clean shared package.

New helper should support:

- `blink:` prefix
- `solana-action:` prefix
- percent-decoded URLs
- HTTPS-only URLs by default
- GET metadata
- POST transaction preparation with `{ account, ...parameters }`
- single transaction response
- multi-transaction response detection with clear unsupported message
- connector error messages

Do not allow arbitrary non-HTTPS URLs in production.

## Connector Registry Update

When generic Blink prepare exists, update Blink-backed connectors from "unavailable" to honest URL-backed readiness.

For example:

- Raydium: Blink-backed actions available when user supplies action URL.
- Orca: Blink-backed actions available when user supplies action URL.
- Meteora: Blink-backed actions available when user supplies action URL.
- MarginFi: Blink-backed actions available when user supplies action URL.
- Drift, Lulo, Save: same pattern.

Do not claim first-class reads exist if they do not.

Suggested execution mode:

```ts
'wallet_approval'
```

or add a clearer mode if local patterns support it:

```ts
'blink_prepare'
```

Only add a new enum if it does not cause unnecessary churn.

## Execution Path

When the user approves a Blink prepared action:

- Validate connected wallet matches `walletAddress`.
- Validate cluster.
- Use stored `transactionBase64` or refresh transaction bytes from `blinkUrl` if needed.
- Simulate if the existing action service supports simulation for base64 transactions.
- Ask the connected user wallet to sign.
- Broadcast.
- Store txid/receipt.

The agent never signs.

## Bridge Route

If the bridge has prepare routes mirroring MCP tools, add:

```text
POST /bridge/action/prepare-blink
```

Body should mirror the MCP input.

Response should mirror other prepare routes:

```ts
{
  preparedAction: PreparedAction
}
```

## Error Messages

Use clear messages:

- `Blink/Solana Action URL is required.`
- `Blink/Solana Action URL must use https.`
- `Wallet account is required before preparing this Blink action.`
- `This Blink returned multiple transactions. V1 supports one transaction at a time.`
- `Connector is not registered for Blink-backed actions.`
- `Prepared action belongs to a different wallet.`

## Security Requirements

- Never log private keys, wallet auth tokens, API keys, or raw secret headers.
- Do not permit HTTP URLs except possibly explicit local dev mode.
- Do not sign or broadcast during prepare.
- Do not claim transaction is safe just because a Blink endpoint returned bytes.
- Preserve all existing guardrails around delegated authority and unlimited approvals.

## Tests

Add tests for:

- URL normalization for `blink:` and `solana-action:`.
- Reject non-HTTPS URL.
- Prepare tool creates `blink_action` prepared action.
- Prepared action stores connector/protocol/operation metadata.
- Multi-transaction Blink response is rejected or clearly unsupported.
- Execution signs only through connected wallet path.
- Connector registry reports Blink-backed connectors as action-capable after helper support.
- Existing transfer/swap/Kamino prepared actions still work.

## Acceptance Criteria

This plan is complete when:

- An external MCP client can call `solana_prepare_blink_action`.
- The result appears as a normal prepared approval item.
- The user wallet remains the only signer.
- Blink-backed connectors are no longer described as unavailable solely because no generic helper exists.
- Browser New Request behavior remains untouched.

