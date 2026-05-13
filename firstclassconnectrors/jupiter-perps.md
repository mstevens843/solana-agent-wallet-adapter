# Jupiter Perps Read-Only Research Plan

## Goal

Add a cautious read-only Jupiter Perps research connector when official docs support stable reads.

V1 scope:

- Report official Perps API readiness.
- Read public Perps/JLP pool facts only if official docs or official endpoints stabilize.
- Read account layouts from official docs only if program/account docs are sufficient.
- Deny all open, close, increase, decrease, collateral, liquidation, leverage, and JLP write actions.

Do not implement Perps write actions in this phase.

## Current Repo State

Jupiter Perps is not implemented.

The app has no separate leverage policy for Jupiter Perps. That means any Perps write action would need new product, legal, risk, UI, and testing treatment before implementation.

## External Source Of Truth

Use official Jupiter Perps docs:

- Perps overview: https://developers.jup.ag/docs/perps
- Position account: https://developers.jup.ag/docs/perps/position-account
- Position request account: https://developers.jup.ag/docs/perps/positionrequest-account
- Pool account: https://developers.jup.ag/docs/perps/pool-account
- Custody account: https://developers.jup.ag/docs/perps/custody-account

Important facts:

- Official docs mark the Perps API as work in progress.
- Official docs point to account parsing as an interim path.
- Perps are leveraged derivatives and require separate risk treatment.

## Dependencies

No dependency in v1 unless official Jupiter Perps SDK/API becomes stable.

Config:

- `connectors.jupiter.perps.enabled`: default false.
- `connectors.jupiter.perps.readOnly`: default true.
- `JUPITER_PERPS_BASE_URL`: optional only if official API endpoints stabilize.

Do not add unofficial SDKs as production dependencies for trading actions.

## Proposed MCP Tools

Read tools:

- `solana_jupiter_perps_status`
- `solana_jupiter_perps_pool_snapshot`
- `solana_jupiter_perps_custody_snapshot`
- `solana_jupiter_perps_position_snapshot`

Prepared action kinds:

- None.

Reserved future kinds only after separate approval:

- `jupiter_perps_open_position`
- `jupiter_perps_close_position`
- `jupiter_perps_add_collateral`
- `jupiter_perps_remove_collateral`

## Inputs

Perps status:

- No required inputs.
- Optional `includeDocsCheck`: boolean, default true.

Pool snapshot:

- `poolAddress`: required if official endpoint is not available.
- `includeCustodies`: optional boolean, default true.

Custody snapshot:

- `custodyAddress`: required.

Position snapshot:

- `walletAddress`: optional. Defaults to connected wallet.
- `positionAddress`: optional.
- `market`: optional if official API supports it.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/jupiter/perpsStatus.ts
packages/mcp-server/src/adapters/jupiter/perpsAccounts.ts
packages/mcp-server/src/adapters/jupiter/perpsEvidence.ts
```

`perpsStatus.ts` responsibilities:

- Return official readiness status.
- Explain that write tools are unavailable.
- Include official docs link and work-in-progress reason.

`perpsAccounts.ts` responsibilities:

- Decode pool, custody, and position accounts only from official layouts.
- Return `unsupported_method` if layouts are not stable enough.

`perpsEvidence.ts` responsibilities:

- Normalize leverage, collateral, liquidation, funding, custody, and pool risk facts when stable reads exist.

## Response Shape

Every read response should include:

- `connectorId: "jupiter"`
- `product: "perps"`
- `readOnly: true`
- `apiStatus`
- `officialDocsStatus`
- `data`
- `warnings`

Warnings must explain that the API is work in progress until official docs remove that warning.

## Safety Checks

- Reject every write request.
- Warn that Perps are leveraged products.
- Warn that liquidation can cause loss of collateral.
- Warn that official API is work in progress.
- Reject unofficial account decoding for money-moving decisions.
- Do not provide leverage recommendations.
- Do not create, close, or modify positions.

## Tests

Unit tests:

- Status read returns work-in-progress warning.
- Write-like requests return `unsupported_method`.
- Pool snapshot rejects when no stable official layout is configured.
- Account parser failures produce structured errors.

Mock tests:

- Official status unavailable.
- Pool account decode success when fixture exists.
- Custody account decode success when fixture exists.
- Position account decode success when fixture exists.

Smoke prompts:

- "Is Jupiter Perps supported here?"
- "Show Jupiter Perps API status."
- "Open a 10x SOL long on Jupiter Perps." Expected: deny.
- "Show read-only JLP pool facts if supported."

## Completion Checklist

- Perps status appears under Jupiter read capabilities.
- Write requests are denied clearly.
- Official work-in-progress status is visible.
- No Perps prepared action kinds are active.
