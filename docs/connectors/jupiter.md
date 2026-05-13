# Jupiter Connector

Jupiter is first-class for Swap API v2 previews, prepared swaps, and wallet-approved swap execution in MCP. Other Jupiter product surfaces are tracked in the parent roadmap but are not implemented in this pass.

## What It Can Read

- `solana_jupiter_order_preview` returns a read-only Swap API v2 `/order` preview with input/output mints, raw amounts, expected output, minimum output threshold, slippage, price impact, router/mode metadata, route-plan summary, fee fields, request id, and transaction availability.
- `solana_get_swap_quote` is a compatibility alias that returns the same normalized connector facts.
- `solana_connector_capabilities jupiter` reports Swap readiness plus unavailable readiness for Lend, Trigger, Recurring, Token/Price, Prediction, and Perps roadmap groups.

## What It Can Prepare Or Execute

- `solana_prepare_swap` prepares a capped Jupiter swap inbox item. It stores normalized mints, raw input amount, slippage, configured caps, and `refreshAtExecution: true`; it does not store raw transaction bytes.
- `solana_swap` requests wallet approval immediately, simulates first, then executes the signed transaction through Jupiter `/execute`.
- `solana_execute_prepared_action` executes prepared swap items by refreshing quote and transaction data at approval time before wallet signing.

## Required Inputs

- Amount.
- Input token or mint.
- Output token or mint.
- Optional slippage in basis points.

Ask:

- "How much do you want to swap?"
- "Which token are you swapping from?"
- "Which token do you want to receive?"

## Required Facts

- Jupiter Swap API v2 order preview.
- Minimum output and slippage cap.
- Router/mode and fee fields when Jupiter reports them.
- Price impact when reported.
- Mint/decimal resolution for unknown token mints.
- Connected wallet for wallet-specific previews.

## Deny Or Ask

Deny swaps above configured max input, slippage above the configured cap, unsupported clusters, missing API-key execution, and requests to guarantee exact output. Ask for a supported first-class product path before Lend, Trigger, Recurring, Token/Price, Prediction, or Perps requests because this runtime does not implement those Jupiter surfaces yet.

## User Approval

Jupiter previews are read-only. Prepared swaps remain manual-approval items until the user sends them to the wallet. The wallet signs; Jupiter `/execute` handles managed landing after the signed transaction is returned.
