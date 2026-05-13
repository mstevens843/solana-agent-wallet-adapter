# Plan 01: New Request Connector Steering

## Goal

Connect the existing Preferences protocol connector setup to the New Request drafting flow.

The user should not have to think of protocol connectors as a separate settings-only feature. If a connector is enabled, it should be available as a drafting constraint in New Request.

Core product rule:

> Connectors define what can be prepared. AI only helps fill the draft. Wallet approval always comes back to the user.

## User Capability Added

Today:

- The user can enable connectors in Preferences.
- The user can create general New Request drafts.
- The browser already has a `protocol-blink-action` template.
- The browser can prepare Blink URLs into wallet approval work.

After this plan:

- New Request has a connector-aware path.
- Users can select an enabled protocol connector while drafting.
- Users can create connector-backed drafts without AI.
- AI users can select a connector and force AI to use only that connector context.
- Disabled or missing connectors block executable drafts instead of producing vague plans.

## User Stories

### Non-AI User

As a user who does not connect AI, I can:

1. Open New Request.
2. Pick `Protocol connector action`.
3. Select an enabled connector, for example `Meteora`.
4. Select an operation, for example `Claim fees`.
5. Paste a Blink/Solana Action URL.
6. Fill position, market, amount, cap, or note fields.
7. Click `Draft from template`.
8. Review the structured draft in Check.
9. Send it to Needs Approval.
10. Sign only in my wallet if I approve.

### AI User

As a user who has AI connected, I can:

1. Select `Meteora` in the connector picker.
2. Type a messy request like `claim fees from this position if the action matches my position`.
3. Click `Draft with AI`.
4. The AI must use Meteora only.
5. If required facts are missing, the AI asks for the missing Blink URL, position, or amount.
6. The AI must not switch to Jupiter, Raydium, or another connector unless I change the selected connector.

### Existing Simple Swap User

As a user making a normal swap, I should not see extra connector complexity unless I select a connector-capable template.

## Current Code To Use

Likely files:

- `apps/browser-demo/src/planner.ts`
- `apps/browser-demo/src/connectedDapps.ts`
- `apps/browser-demo/src/main.ts`
- `apps/browser-demo/src/__tests__/protocolActions.test.ts`
- existing browser planner or workflow tests

Current useful primitives:

- `PROTOCOL_CONNECTORS`
- `ProtocolConnector`
- `connectorHasCapability`
- `findProtocolConnectorByInput`
- `isDappEnabled`
- `protocolConnectorQueueBlockReason`
- `protocol-blink-action` template
- `blink_action` action type
- `normalizeBlinkUrl`
- `prepareBlinkAction`

## Scope

Implement only browser New Request and browser planner behavior.

In scope:

- Connector picker in New Request for connector-capable templates.
- Dynamic fields for connector-backed actions.
- Non-AI template draft path.
- AI prompt steering with selected connector context.
- Validation messages for disabled/missing connector state.
- Tests for connector steering and non-AI connector drafts.

Out of scope:

- New MCP tools.
- Local bridge prepared action schema changes.
- CLI commands.
- Desktop shell changes.
- Cloud backend support.
- Any wallet signing changes.

## UX Design

### When To Show Connector Fields

Show connector fields only when the selected template is connector-capable.

Connector-capable templates include:

- `protocol-blink-action`
- any future template with `actionType === 'blink_action'`
- any future template declaring connector metadata

Do not show the connector picker for plain:

- `swap`
- `transfer_sol`
- `transfer_spl`
- `recurring_payment`
- `proof_only`
- `evidence_only`

### Connector Section Layout

Recommended fields:

```text
Protocol Connector
[Meteora connected v]

Operation
[Claim fees v]

Blink / Action URL
[https://...]

Position / Market
[optional position, pool, vault, market]

Amount / Cap
[all, 0.1 SOL, 100 USDC]
```

The connector dropdown should use enabled connectors first. It may show disabled connectors only if clearly disabled and not selectable for executable drafts.

### Empty State

If no executable connector is enabled:

```text
No Blink-capable connector is enabled.
Enable a protocol connector in Preferences, or use a non-connector template.
```

Provide a clear button/link to Preferences if the local UI already has a tab switch helper.

### Connector Status Copy

For Blink-backed connectors:

```text
Blink-backed. Requires an action URL. Wallet signs only after review.
```

For first-class connectors:

```text
First-class adapter. Agentic can prepare this action directly; wallet still signs after review.
```

For disabled connectors:

```text
Connector disabled. Enable it in Preferences before preparing executable work.
```

## Data And State Requirements

Do not create a new storage system. Reuse existing connector state:

- `state.connectedDapps`
- `PROTOCOL_CONNECTORS`
- connector enabled/disabled state
- selected template state
- plan parameter state

The selected connector should map into plan parameters:

```ts
{
  protocol: connector.name,
  connectorId: connector.id,
  operation: selectedOperation,
  blinkUrl: suppliedUrl,
  position: suppliedPosition,
  amount: suppliedAmount,
}
```

If existing plan parameters already use `protocol`, `dapp`, `provider`, `operation`, `blinkUrl`, or `actionUrl`, preserve compatibility.

## Validation Rules

Before `Draft from template` can produce an executable connector draft:

- A connector must be selected.
- The connector must exist in `PROTOCOL_CONNECTORS`.
- The connector must be enabled for the current cluster.
- The connector must support `blink_actions` for `blink_action` plans.
- A Blink/Solana Action URL must be present for Blink-backed connectors.
- The URL must pass `normalizeBlinkUrl`.
- Required fields from the selected operation should be present when known.

Validation should produce user-facing messages, not generic errors.

Examples:

- `Meteora is not enabled. Enable it in Protocol Connectors before sending.`
- `Meteora requires a Blink/Solana Action URL for executable work.`
- `This connector is available on mainnet-beta only.`

## AI Prompt Steering

When the user selects a connector and clicks `Draft with AI`, include hard connector context in the prompt:

- selected connector id
- selected connector name
- selected operation
- action source: `blink` or `first-class-adapter`
- enabled state
- supported actions
- required Blink/action URL requirement
- current supplied fields
- missing fields

The AI instruction must be strict:

```text
Use the selected protocol connector only. Do not switch protocols.
If required connector facts are missing, ask for missing facts instead of inventing execution.
Do not claim the action is signed, submitted, approved, or safe.
The wallet owner must approve separately.
```

If no connector is selected, preserve current behavior.

## Non-AI Drafting Behavior

`Draft from template` must work without AI.

For Blink-backed connector actions, it should produce a structured `AgentPlan` similar to:

```ts
{
  actionType: 'blink_action',
  intent: 'Prepare Meteora claim fees for wallet review.',
  route: 'Meteora Blink action. Transaction bytes are fetched only when sent for approval.',
  risk: 'High. Review protocol, action URL, position, amount, and wallet action before signing.',
  approval: 'Wallet owner reviews the prepared transaction and signs only if it matches the request.',
  parameters: {
    connectorId: 'meteora',
    protocol: 'Meteora',
    operation: 'Claim fees',
    blinkUrl: 'https://...',
    position: '...',
    amount: '...'
  },
  safeguards: [
    'Wallet remains the only signer.',
    'Connector must be enabled.',
    'Blink URL must be reviewed before wallet approval.'
  ]
}
```

Do not fetch transaction bytes during the initial template draft if the current app convention is to fetch them when sending for approval.

## Edge Cases

- Connector is enabled, then disabled while draft is open: block sending until re-enabled.
- User changes connector after AI draft: mark AI review stale if existing stale-review logic supports this.
- User selects connector but leaves URL empty: allow proof-only/read-only explanation, block executable approval.
- Connector exists but current cluster unsupported: block executable path.
- Multi-transaction Blink response remains handled by existing browser flow; do not expand support here unless already trivial.

## Tests

Add or update browser tests to cover:

- Connector picker uses enabled connectors.
- Disabled connector blocks executable draft.
- Blink-backed connector requires valid URL.
- `Draft from template` creates a `blink_action` plan without AI.
- Selected connector is preserved in plan parameters.
- AI prompt context includes selected connector and does not omit connector constraints.
- Existing swap template does not show connector-specific fields.
- Existing proof-only/evidence-only modes are unchanged.

## Acceptance Criteria

This plan is complete when:

- A non-AI user can draft a connector-backed Blink action from New Request.
- An AI user can steer AI to a selected connector.
- The selected connector is visible in the draft/check flow.
- Disabled/missing connector states are clear.
- Existing swap, transfer, repeat, proof, and evidence flows still behave as before.

