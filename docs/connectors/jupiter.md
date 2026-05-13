# Jupiter Connector

Jupiter is first-class for swap preview and swap preparation in MCP. Browser-level Jupiter lend and borrow remain Blink-backed and require explicit action URLs until a generic Blink helper is added.

## What It Can Read

- `solana_jupiter_order_preview` returns a read-only Ultra order preview with input mint, output mint, raw input amount, expected output, minimum output, slippage, price impact, request id, and transaction availability.
- `solana_get_swap_quote` is a compatibility alias that returns the same normalized connector facts.

## What It Can Prepare

- `solana_prepare_swap` prepares a capped Jupiter swap inbox item.
- `solana_swap` can request wallet approval and execute the wallet-signed Jupiter order immediately.
- `solana_execute_prepared_action` executes prepared swap items by refreshing quote and transaction data at approval time.

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

- Jupiter order preview.
- Minimum output and slippage cap.
- Price impact when reported.
- Mint/decimal resolution for unknown token mints.
- Connected wallet for wallet-specific previews.

## Deny Or Ask

Deny swaps above configured max input, slippage above the configured cap, unsupported clusters, and requests to guarantee exact output. Ask for a Jupiter Blink URL before lend, borrow, withdraw, or repay requests because those paths are not first-class in MCP.

## User Approval

Jupiter previews are read-only. Prepared swaps remain manual-approval items until the user sends them to the wallet. The wallet signs and broadcasts.
