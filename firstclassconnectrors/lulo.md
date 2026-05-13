# Lulo First-Class Connector Plan

## Goal

Replace Lulo's current Blink-backed connector status with a first-class API-backed adapter for Lulo Protected/Boost reads and generated deposit/withdraw transactions.

V1 scope:

- Read rates.
- Read pool metadata.
- Read wallet balances if API supports it.
- Prepare deposit transaction.
- Prepare withdraw transaction.
- Prepare complete regular withdrawal if needed by withdrawal type.

## Current Repo State

Lulo currently appears in:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `spec/connectors/lulo.connector.json`
- `docs/connectors/planned-connectors.md`

Current runtime mode is planned/Blink-backed.

## External Source Of Truth

Use official Lulo docs:

- Integration guide: https://www.lulo.fi/docs/integration-guide
- API reference: https://www.lulo.fi/docs/api-reference

Key facts:

- Lulo exposes a REST API.
- API key is required in `x-api-key`.
- API can generate deposit and withdrawal transactions.
- API can return rates and pool metadata.
- Lulo program id is documented in the integration guide.
- Lulo Protected/Boost should be treated as distinct deposit modes.

## Dependencies

No SDK dependency required in v1.

Config:

- `LULO_API_KEY`: required for live API calls.
- `LULO_API_BASE_URL`: optional, default `https://api.lulo.fi`.

No Lulo API key should ever be stored in receipts, notes, planner payloads, or browser local state by this connector.

## Proposed MCP Tools

Read tools:

- `solana_lulo_rates`
- `solana_lulo_pool_meta`
- `solana_lulo_wallet_balances`

Prepare tools:

- `solana_prepare_lulo_deposit`
- `solana_prepare_lulo_withdraw`
- `solana_prepare_lulo_complete_withdraw`

Prepared action kinds:

- `lulo_deposit`
- `lulo_withdraw`
- `lulo_complete_withdraw`

## Inputs

Rates:

- `mintAddress`: optional.
- `depositType`: optional enum `protected | boost | regular`.

Pool metadata:

- `mintAddress`: optional.

Wallet balances:

- `walletAddress`: optional. Defaults to connected wallet.

Deposit:

- `mintAddress`: required.
- `amount`: required decimal string in human units.
- `depositType`: enum `protected | boost | regular`, default `protected`.
- `priorityFee`: optional numeric micro-lamports.

Withdraw:

- `mintAddress` or token symbol: required.
- `withdrawType`: enum `protected | regular`, default `protected`.
- `amount`: optional decimal string.
- `percentage`: optional integer 1-100. Default 100 if amount omitted.

Complete withdraw:

- `mintAddress` or token symbol: required.
- `withdrawalId`: required.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/lulo/constants.ts
packages/mcp-server/src/adapters/lulo/client.ts
packages/mcp-server/src/adapters/lulo/rates.ts
packages/mcp-server/src/adapters/lulo/balances.ts
packages/mcp-server/src/adapters/lulo/deposit.ts
packages/mcp-server/src/adapters/lulo/withdraw.ts
packages/mcp-server/src/adapters/lulo/index.ts
```

`client.ts`:

- Build authenticated fetch wrapper.
- Redact API key from all errors.
- Normalize base URL.
- Enforce JSON responses and size limits.

`rates.ts`:

- Read protected/boost rates.
- Return APY, mint, product type, TVL/pool metadata where API exposes it.

`balances.ts`:

- Read wallet balance/position state where API supports it.
- If unavailable, return structured missing capability and keep rates usable.

`deposit.ts`:

- Convert human amount to raw amount using token decimals from config/custom token list or API metadata.
- Call transaction generation endpoint.
- Store generated transaction base64 in prepared action.

`withdraw.ts`:

- Generate withdraw or complete-withdraw transaction.
- Handle regular withdraw cooldown states.

## Prepared Action Payload

Store:

- `connectorId: "lulo"`
- `operation`
- `depositType` or `withdrawType`
- `mintAddress`
- `amount`
- `amountRaw`
- `percentage`
- `withdrawalId`
- `ratesSnapshot`
- `poolMetaSnapshot`
- `programIds`
- `transactionBase64`
- `apiBaseUrlHost`
- `refreshAtExecution: true`

Even if API returns a transaction at prepare time, execution should refresh unless Lulo explicitly marks the transaction reusable.

## Safety Checks

- Reject missing `LULO_API_KEY` for API-backed reads/writes.
- Reject unknown mint decimals.
- Reject both amount and percentage if contradictory.
- Warn about product type, coverage, and underlying allocation risk.
- Warn when regular withdrawal has cooldown/complete step.
- Block unsupported withdraw type.
- Do not claim protected yield is risk-free.
- Do not store API key anywhere outside process env.

## Tests

Unit tests:

- Missing API key returns unauthorized.
- Rates read redacts API key from errors.
- Deposit prepare serializes API transaction.
- Withdraw percentage validates 1-100.
- Complete withdraw requires withdrawal id.
- Unknown mint decimals rejects.

Mock API tests:

- Rates success.
- Pool metadata success.
- Deposit transaction generation success.
- Withdraw transaction generation success.
- Non-JSON error response redacted.

Smoke prompts:

- "Show Lulo Protected and Boost rates."
- "Show my Lulo balances."
- "Prepare depositing 10 USDC into Lulo Protected. Do not sign."
- "Prepare withdrawing 50 percent from Lulo Protected."
- "Complete my Lulo regular withdrawal id 1."

## Completion Checklist

- Lulo row says first-class when `LULO_API_KEY` is configured.
- Rates read works.
- Deposit and withdraw prepare approval items.
- API key is never exposed.
- Wallet approval remains mandatory.
