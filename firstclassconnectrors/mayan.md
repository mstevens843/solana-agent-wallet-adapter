# Mayan First-Class Connector Plan

## Goal

Add a first-class Agentic connector for Mayan cross-chain swap quotes and prepare-only Solana-source cross-chain swap actions.

V1 scope:

- Read supported chains and tokens.
- Quote Solana-source Mayan routes.
- Prepare Solana-source Mayan swap transactions.
- Track swap status and refund/resume facts.
- Surface relayer, auction, gas-drop, destination amount, and refund assumptions.

Do not include automated destination-chain signing, arbitrary EVM approval flows, custodial routing, liquidity provider admin actions, or recurring cross-chain swaps in v1.

## Current Repo State

Mayan is not in the current connector catalog.

Implementation will need to add it to:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/adapters/types.ts`
- `packages/mcp-server/src/adapters/registry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `spec/connectors/mayan.connector.json`
- `docs/connectors/README.md`

Mayan should appear as `First-class cross-chain swap connector`.

## External Source Of Truth

Use official Mayan docs:

- Mayan docs: https://docs.mayan.finance/
- Quote API: https://docs.mayan.finance/integration/quote-api
- Swap from Solana guide: https://docs.mayan.finance/integration/swap-from-solana
- Mayan SDK package docs when used by implementation.

Important integration facts to preserve:

- Mayan exposes quote APIs and SDK helpers for cross-chain swaps.
- A Solana source swap prepares a Solana transaction but the outcome depends on route execution, relayers, destination chain state, and token support.
- Mayan routes can include gas drop, relayer fee, bridge fee, and destination output assumptions.

## Dependencies

Shared runtime worker should add optional dependency if official package is stable:

- `@mayanfinance/swap-sdk`

Config:

- `MAYAN_PRICE_API_BASE_URL`: optional, default official Mayan quote API.
- `MAYAN_API_KEY`: optional, only required if Mayan enables or requires keyed access.
- `MAYAN_CONNECTOR_ENABLED`: optional feature flag during rollout.

The connector should still report public-route availability when no API key is configured and public API usage is permitted.

## Proposed MCP Tools

Read tools:

- `solana_mayan_supported_chains`
- `solana_mayan_supported_tokens`
- `solana_mayan_quote`
- `solana_mayan_swap_status`
- `solana_mayan_wallet_pending_swaps`

Prepare tools:

- `solana_prepare_mayan_swap`
- `solana_prepare_mayan_resume_or_refund`

Prepared action kinds:

- `mayan_swap`
- `mayan_resume_or_refund`

## Inputs

Supported chains:

- `includeDisabled`: optional boolean, default false.

Supported tokens:

- `sourceChain`: optional, default `solana`.
- `destinationChain`: optional.
- `symbol` or `mintAddress`: optional.

Quote:

- `sourceMint`: required.
- `destinationChain`: required.
- `destinationToken`: required.
- `amount`: required decimal string.
- `destinationAddress`: required.
- `slippageBps`: optional, default connector risk config.
- `gasDrop`: optional decimal string.
- `routePreference`: optional enum `best | fastest | cheapest`.

Swap status:

- `sourceTxid`, `swapId`, or `orderHash`: required.

Wallet pending swaps:

- `walletAddress`: optional. Defaults to connected wallet.

Swap:

- `sourceMint`: required.
- `destinationChain`: required.
- `destinationToken`: required.
- `amount`: required decimal string.
- `destinationAddress`: required.
- `minDestinationAmount`: required decimal string.
- `maxTotalFee`: optional decimal string.
- `slippageBps`: optional.
- `gasDrop`: optional decimal string.
- `routeId`: optional, from quote.

Resume or refund:

- `sourceTxid`, `swapId`, or `orderHash`: required.
- `expectedRefundMint`: optional public key.
- `minRefundAmount`: optional decimal string.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/mayan/constants.ts
packages/mcp-server/src/adapters/mayan/client.ts
packages/mcp-server/src/adapters/mayan/routes.ts
packages/mcp-server/src/adapters/mayan/quotes.ts
packages/mcp-server/src/adapters/mayan/status.ts
packages/mcp-server/src/adapters/mayan/actions.ts
packages/mcp-server/src/adapters/mayan/index.ts
```

`constants.ts` responsibilities:

- Store supported source chain as Solana.
- Store quote stale threshold, slippage cap, and max gas-drop defaults.
- Store route risk labels.

`client.ts` responsibilities:

- Build authenticated or public Mayan API client.
- Dynamic import SDK package if used.
- Normalize chain names, token identifiers, and quote errors.
- Redact API keys.

`routes.ts` responsibilities:

- Read supported chains and tokens.
- Mark unsupported or disabled routes explicitly.

`quotes.ts` responsibilities:

- Normalize input amount, destination output, fees, gas drop, route id, ETA, bridge provider, and auction/relayer facts.
- Include `asOf` and stale-at timestamps.

`status.ts` responsibilities:

- Resolve pending, completed, refundable, failed, expired, and unknown states.
- Return source tx, destination tx, refund facts, and relayer facts where API exposes them.

`actions.ts` responsibilities:

- Build unsigned Solana-source swap transaction from Mayan quote.
- Refresh quote before execution.
- Build resume/refund transactions only when Solana wallet can sign the needed step.

## Prepared Action Payload

Store:

- `connectorId: "mayan"`
- `operation`
- `walletAddress`
- `cluster`
- `sourceChain`
- `destinationChain`
- `sourceMint`
- `destinationToken`
- `amount`
- `amountRaw`
- `destinationAddress`
- `minDestinationAmount`
- `maxTotalFee`
- `slippageBps`
- `gasDrop`
- `routeId`
- `quoteSnapshot`
- `statusSnapshot`
- `programIds`
- `transactionBase64` only if reusable
- `refreshAtExecution: true`

## Safety Checks

- Reject unsupported clusters.
- Reject invalid destination address for destination chain.
- Reject unsupported source or destination token.
- Reject stale quote.
- Reject refreshed output below `minDestinationAmount`.
- Reject total fee above `maxTotalFee` if supplied.
- Reject slippage above configured cap.
- Reject gas drop above configured cap.
- Warn about ETA uncertainty, relayer dependency, and destination-chain execution risk.
- Warn when refund path is not automatic.
- Do not request destination-chain private keys.
- Do not create recurring cross-chain swaps in v1.

## Tests

Unit tests:

- Supported chains normalizes Mayan chain ids.
- Quote rejects invalid destination address.
- Quote rejects slippage above cap.
- Swap prepare stores route id and min output.
- Execute refresh blocks worse quote.
- Resume/refund rejects non-Solana-signable step.
- API errors redact `MAYAN_API_KEY`.

Mock tests:

- Public quote API success.
- Keyed quote API success.
- Swap transaction generation success.
- Status pending/completed/refundable success.
- Rate-limit and unavailable handling.

Smoke prompts:

- "Show Mayan routes from Solana USDC to Base USDC."
- "Quote swapping 10 USDC from Solana to Arbitrum through Mayan."
- "Prepare a Mayan swap to this destination address with at least 9.8 USDC received. Do not sign."
- "Check this Mayan swap status."
- "Prepare refund or resume for this Mayan swap if possible."

## Completion Checklist

- Mayan appears in `/app` preferences as first-class.
- Route, token, quote, and status reads work.
- Solana-source swap prepare creates approval inbox items.
- Execution refreshes quote and blocks worse output.
- No Mayan path signs before wallet approval.
