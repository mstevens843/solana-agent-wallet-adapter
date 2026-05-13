# MCP Connector Runtime Plan

## Ownership

This workstream owns only:

- `packages/mcp-server/**`

Do not edit:

- `apps/browser-demo/**`
- `apps/render-web/**`
- `packages/workflow/**`
- `docs/**`
- `scripts/**`
- `spec/**`

## Goal

Make protocol connectors real runtime capabilities for local bridge and MCP agents. The agent should be able to read grounded facts, prepare approval-bound connector actions, and expose clear tool descriptions for natural language use.

## Current Baseline

Already present:

- Kamino first-class adapter has deposit, withdraw, reserve snapshot, positions, and earnings proof paths.
- Jupiter swap order preview and execute tooling exists.
- MCP tool descriptions include some natural-language hints.
- Bridge AI planner receives connector context.

Still incomplete:

- Connector runtime is uneven across protocols.
- Read facts are not normalized into one reusable fact shape.
- Write action support is not consistently described as prepare-only.
- Tool descriptions are not exhaustive enough for natural-language agents.
- There is no connector capability registry on the MCP side equivalent to the browser connector catalog.

## Non-Goals

This workstream must not change browser UI or browser planner prompts. Browser integration belongs to the browser workstream.

This workstream must not change cloud API persistence or workflow validators. Hosted cloud belongs to the cloud workstream.

## Required Outcomes

### 1. MCP Connector Capability Registry

Create or expand a server-side connector registry inside `packages/mcp-server/**`.

The registry must include, for each connector:

- `id`
- `name`
- `aliases`
- `supportedClusters`
- `readCapabilities`
- `writeCapabilities`
- `readTools`
- `actionTools`
- `requiresClientKey`
- `executionMode`
- `approvalBoundary`
- `limitations`
- natural-language examples

Initial connectors:

- Kamino
- Jupiter
- Meteora
- Raydium
- Orca
- MarginFi
- Drift
- Lulo
- Save

The registry can mark non-implemented connectors as read/action unavailable, but it must do so explicitly.

Definition of done:

- The registry can answer "what can this connector do?" without reading browser code.
- Tests cover at least Kamino, Jupiter, Meteora, and an unavailable connector.

### 2. Normalized Connector Fact Shape

Implement a reusable fact model for connector reads.

Suggested shape:

```ts
interface ConnectorFact {
  connectorId: string;
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'neutral' | 'fail';
  source: 'connector';
  checkedAt: string;
  detail?: Record<string, unknown>;
}
```

Requirements:

- Kamino reserve snapshots map to facts.
- Kamino positions map to facts.
- Kamino earnings proof preview maps to facts.
- Jupiter order preview maps to facts.
- Unsupported connector reads return structured "missing capability" errors, not generic failures.

Definition of done:

- MCP tests can assert normalized facts for Kamino and Jupiter.
- Unsupported connector fact reads are deterministic and redacted.

### 3. Connector Read Tools

Expose read tools that agents can call directly.

Minimum tools:

- `solana_connector_capabilities`
- `solana_connector_read_facts`
- `solana_kamino_reserve_snapshot`
- `solana_kamino_positions`
- `solana_kamino_earnings_proof`
- `solana_jupiter_order_preview`

Behavior:

- Tools must never require private keys.
- Tools must include wallet address only where a wallet-specific read is needed.
- Tools must redact API keys and secrets.
- Tools must return stable JSON.

Definition of done:

- Tool list includes descriptions with natural-language examples.
- Read tools fail cleanly when cluster/key/config is missing.

### 4. Connector Write Tools

Strengthen approval-bound write tools.

Minimum actions:

- Kamino deposit prepare
- Kamino withdraw prepare
- Jupiter swap prepare/preview
- Jupiter swap execute through existing wallet approval path
- Blink/Solana Action prepare helper if already supported in MCP runtime

Requirements:

- Every write tool description must say:
  - prepares work for wallet approval
  - does not grant delegated authority
  - does not sign without wallet
- Prepared actions must include enough params for browser or CLI review:
  - connector id
  - operation
  - token/mint
  - amount
  - market/pool/reserve
  - risk facts if available
  - quote/preview facts if available
- Prepared action summaries must be concise and user-readable.

Definition of done:

- A natural-language MCP client can ask to "supply 0.1 SOL to Kamino" and get a prepared approval item, not an executed transaction.
- A natural-language MCP client can ask to "show Kamino positions" and get facts, not an action.

### 5. Planner/Reviewer Prompt Improvements in Bridge

Improve MCP bridge planner prompts in `packages/mcp-server/**` only.

Requirements:

- The bridge planner should understand connector capabilities from the server-side registry.
- The reviewer should request flexible findings for connector facts.
- The Q&A prompt should answer connector capability questions.
- The prompt must preserve the approval boundary.
- The prompt should distinguish:
  - read-only fact answer
  - proof-only review
  - prepared wallet action
  - unsupported request

Definition of done:

- Bridge AI tests cover:
  - connector Q&A answer
  - connector missing capability
  - Kamino deposit plan
  - findings-only review result

### 6. MCP Tests

Add or extend tests under `packages/mcp-server/src/__tests__/**`.

Required coverage:

- Connector registry shape.
- Kamino read facts.
- Jupiter preview facts.
- Write action descriptions contain approval boundary text.
- Unsupported connector returns missing capability.
- AI planner prompt includes connector context.
- Redaction of secrets.

Run:

- `pnpm -F @solana-agent-wallet-adapter/mcp-server build`
- `pnpm -F @solana-agent-wallet-adapter/mcp-server test`

## Deliverable Summary

The final report should list:

- Tools added or changed.
- Connectors with first-class runtime support.
- Connectors intentionally marked unavailable or Blink-only.
- Tests added.
- Any browser/cloud integration needs that could not be completed inside `packages/mcp-server/**`.
