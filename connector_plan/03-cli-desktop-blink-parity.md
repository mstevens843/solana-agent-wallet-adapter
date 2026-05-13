# Plan 03: CLI And Desktop Blink Parity

## Goal

Make CLI and desktop understand Blink-prepared actions created by the local bridge or MCP runtime.

This plan depends conceptually on Plan 02 defining the durable `blink_action` prepared action shape, but it should not edit MCP internals.

Core user capability:

> If Claude, Codex, or the local bridge prepares a Blink action, CLI and desktop can show it clearly as a wallet-approval item.

## Scope

In scope:

- CLI command or CLI display support for Blink prepared actions.
- Desktop approval inbox rendering for Blink prepared actions.
- Clear copy that the action is prepared only and user wallet signs separately.
- Receipt display fields for Blink actions when available.

Out of scope:

- Browser New Request UI.
- MCP tool implementation.
- Connector registry internals.
- Cloud backend.
- Wallet signing model changes.

## Owned Files

Primary CLI files:

- `packages/cli/src/index.ts`

Primary desktop files:

- `apps/desktop-shell/src/main.ts`
- `apps/desktop-shell/src/styles.css` only if visual distinction is needed

Possible docs:

- CLI/desktop README snippets if the repo already keeps command docs nearby

Do not edit `packages/mcp-server/src/*` in this plan except reading types.

## CLI Behavior

The CLI should support Blink-prepared actions in two ways:

### Display Existing Inbox Items

When `/inbox` or `solana-agent-wallet inbox` shows a Blink action, it should render:

- action id
- connector/protocol
- operation
- Blink/action URL host
- wallet
- status
- due time
- expected amount/token/recipient if present

Example compact row:

```text
pa_123 ready blink Meteora Claim fees https://... wallet 4fTq...
```

Example detail:

```text
Blink action
Protocol: Meteora
Operation: Claim fees
URL: https://...
Wallet: 4fTq...
Status: ready
Boundary: Prepared only. Wallet signs after review.
```

### Optional Prepare Command

If Plan 02 exposes a bridge route, add a command like:

```text
solana-agent-wallet prepare blink --url <url> --connector meteora --operation "Claim fees"
```

or interactive equivalent if that matches current CLI style.

This command should call the bridge route, not implement Blink fetching independently.

## Desktop Behavior

Desktop approval inbox should render Blink actions as first-class prepared items.

Display:

- protocol/connector
- operation
- URL host or short URL
- wallet
- status
- note
- expected constraints

Button behavior:

- If desktop already supports approve/reject through bridge, keep same buttons.
- If execution is not supported in desktop for Blink yet, show a clear message:
  `Open Agentic browser approval to sign this Blink action.`
- Do not hide the item or render it as an unknown action.

## Data Handling

Use params from Plan 02 if present:

- `connectorId`
- `protocol`
- `operation`
- `blinkUrl`
- `actionUrl`
- `blinkTitle`
- `blinkLabel`
- `blinkMessage`
- `expectedAmount`
- `expectedToken`
- `expectedRecipient`
- `position`
- `connectorActionSource`

Fallback gracefully if only `blinkUrl` exists.

## Copy Requirements

Use consistent language:

```text
Prepared Blink action. Wallet approval required.
```

Avoid:

- `executed`
- `approved`
- `safe`
- `agent signed`
- `auto-sent`

unless the action actually reached that state.

## Tests

Add or update tests for:

- CLI inbox renders `blink_action` without crashing.
- CLI detail view includes URL/protocol/operation.
- CLI prepare command calls bridge route if implemented.
- Desktop inbox renders Blink action card.
- Desktop reject/archive still works for Blink action.
- Unknown/missing Blink fields render fallback labels.

## Acceptance Criteria

This plan is complete when:

- CLI can display Blink prepared actions clearly.
- Desktop can display Blink prepared actions clearly.
- CLI/desktop do not treat Blink actions as unknown broken records.
- All copy preserves the wallet approval boundary.
- No MCP implementation files were changed by this plan.

