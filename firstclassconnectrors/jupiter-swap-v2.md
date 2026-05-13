# Jupiter Swap V2 Completion Plan

## Goal

Finish and harden Jupiter swap support against the current official Swap API v2 surface.

The repo already ships swap quote/order preview, prepared swap, direct wallet swap, and approval-time refresh. This plan keeps that behavior and updates naming, config, docs, tests, and facts to match current Jupiter docs.

V1 completion scope:

- Keep current swap tools stable.
- Move default base URL from legacy Ultra naming to official Swap API v2 naming.
- Preserve compatibility env vars and user-facing behavior.
- Add richer router, mode, fee, slippage, and execution evidence.
- Keep approval-time refresh for prepared swaps.

Do not add gasless swaps, custom transaction composition, CPI, or Router `/build` in this pass.

## Current Repo State

Current implementation lives mostly in:

- `packages/mcp-server/src/actionService.ts`
- `packages/mcp-server/src/actionTools.ts`
- `packages/mcp-server/src/config.ts`
- `packages/mcp-server/src/connectorFacts.ts`
- `spec/connectors/jupiter.connector.json`
- `docs/connectors/jupiter.md`

Current tools:

- `solana_jupiter_order_preview`
- `solana_get_swap_quote`
- `solana_prepare_swap`
- `solana_swap`
- `solana_execute_prepared_action`

Current config:

- `config.jupiter.baseUrl` defaults to `https://api.jup.ag/ultra/v1`.
- Env override supports `JUP_ULTRA_BASE` and `JUPITER_BASE_URL`.
- API key uses `JUPITER_API_KEY` or `JUP_API_KEY`.

Current execution behavior:

- `GET /order` creates an order preview and transaction.
- Wallet signs the transaction.
- `POST /execute` submits signed transaction plus `requestId`.
- Prepared swaps call `swap()` at execution, which refreshes quote and transaction before wallet approval.

## External Source Of Truth

Use official Jupiter Swap docs:

- Swap overview: https://developers.jup.ag/docs/swap
- Order and execute: https://developers.jup.ag/docs/swap/order-and-execute
- Swap API reference: https://developers.jup.ag/docs/api-reference/swap/get-order
- Execute API reference: https://developers.jup.ag/docs/api-reference/swap/execute

Important facts:

- Official Swap API v2 base URL is `https://api.jup.ag/swap/v2`.
- Meta-Aggregator path is `/order` plus `/execute`.
- `/order` can return a quote only without `taker`, and a base64 transaction when `taker` is supplied.
- Routers can include Metis, JupiterZ, Dflow, and OKX.
- JupiterZ quotes can require partial signing and cannot be modified after `/order`.
- `/execute` returns status, signature, code, input result, output result, and error when present.
- Jupiter handles slippage, priority fee, landing, confirmation polling, and parsed execution results for `/execute`.

## Dependencies

No new dependency is required.

Config changes:

- Add `jupiter.swapBaseUrl` or product-specific config equivalent.
- Default to `https://api.jup.ag/swap/v2`.
- Keep these legacy env overrides:
  - `JUP_ULTRA_BASE`
  - `JUPITER_BASE_URL`
- Add preferred env override:
  - `JUPITER_SWAP_BASE_URL`
- Keep `JUPITER_API_KEY` and `JUP_API_KEY`.

Do not break existing config files that set `jupiter.baseUrl`.

## Proposed MCP Tools

Keep existing tools:

- `solana_jupiter_order_preview`
- `solana_get_swap_quote`
- `solana_prepare_swap`
- `solana_swap`
- `solana_execute_prepared_action`

Optional new read tool:

- `solana_jupiter_swap_health`

Do not rename existing public tools. Add aliases only if a future API version requires it.

## Inputs

Existing swap input remains:

- `inputToken`: optional symbol or mint, default `SOL`.
- `outputToken`: optional symbol or mint, default `USDC`.
- `amount`: required human decimal string.
- `slippageBps`: optional integer, default configured max.
- `dueAt`: optional for prepared actions.
- `note`: optional for prepared actions.

Add internal normalized fields:

- `inputMint`
- `outputMint`
- `amountRaw`
- `taker`
- `slippageBps`
- `maxSwapInput`
- `apiBaseUrlHost`

## Adapter Design

Short-term implementation can stay in `actionService.ts` to minimize risk.

Target adapter layout for cleanup:

```text
packages/mcp-server/src/adapters/jupiter/constants.ts
packages/mcp-server/src/adapters/jupiter/client.ts
packages/mcp-server/src/adapters/jupiter/swap.ts
packages/mcp-server/src/adapters/jupiter/facts.ts
packages/mcp-server/src/adapters/jupiter/index.ts
```

`client.ts` responsibilities:

- Resolve API key and product base URLs.
- Make authenticated Jupiter requests.
- Redact API keys and signed transaction bodies from errors.
- Normalize API response codes.

`swap.ts` responsibilities:

- Normalize tokens and amounts.
- Fetch order preview.
- Build prepared action params.
- Execute direct swap.
- Execute prepared swap by refreshing order at approval time.

`facts.ts` responsibilities:

- Convert order/execute responses into stable connector facts.
- Include router, mode, fee fields, minimum output, and execution status.

## Prepared Action Payload

Prepared swap actions should store:

- `connectorId: "jupiter"`
- `product: "swap"`
- `operation: "swap"`
- `approvalBoundary`
- `inputToken`
- `outputToken`
- `inputMint`
- `outputMint`
- `amount`
- `amountRaw`
- `slippageBps`
- `maxSwapInput`
- `preparedAt`
- `quoteSnapshot` when available
- `refreshAtExecution: true`

Do not store reusable transaction bytes for prepared swaps. Refresh at execution.

## Safety Checks

- Reject unsupported clusters.
- Reject missing amount.
- Reject slippage above configured cap.
- Reject amount above `maxSwapInput`.
- Reject unknown token mint if decimals cannot be resolved.
- Warn for unknown/unverified token metadata when available.
- Warn when Jupiter returns manual mode or router restrictions.
- Warn when JupiterZ/RFQ route cannot be modified.
- Warn when output is not guaranteed after quote.
- Block if approval-time output is worse than configured slippage/min-output policy.
- Do not claim exact route or output is final before approval-time refresh.

## Tests

Unit tests:

- Default base URL resolves to `https://api.jup.ag/swap/v2`.
- Legacy `JUP_ULTRA_BASE` and `JUPITER_BASE_URL` still override.
- Preferred `JUPITER_SWAP_BASE_URL` overrides.
- Missing API key returns `unauthorized`.
- Order preview sends `inputMint`, `outputMint`, `amount`, `taker`, and `slippageBps`.
- Prepared swap stores refresh metadata and no raw transaction.
- Direct swap signs only after simulation.
- Execute errors expose Jupiter code but redact signed transaction.
- Prepared swap refreshes order at execution.

Mock tests:

- `/order` quote-only response.
- `/order` transaction response.
- `/execute` success.
- `/execute` failed with code and signature.
- JupiterZ route response.
- Manual mode with fee fields.

Smoke prompts:

- "Quote 0.1 SOL to USDC through Jupiter."
- "Prepare swapping 0.05 SOL to USDC. Do not sign."
- "Swap 0.01 SOL to USDC with wallet approval."
- "Why can the exact Jupiter venue change before I sign?"
- "Swap with 20 percent slippage." Expected denial.

## Completion Checklist

- Existing Jupiter swap behavior still works.
- Config and docs say Swap API v2, not Ultra-only.
- `spec/connectors/jupiter.connector.json` reflects current API names.
- `docs/connectors/jupiter.md` explains Swap API v2 and current gaps.
- Connector facts include router, mode, min output, fee fields, and status where available.
- No swap path signs before wallet approval.
