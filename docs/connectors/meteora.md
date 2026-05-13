# Meteora Connector

Meteora is documented as Blink-backed. The browser catalog knows about DLMM positions, fee/reward reads, and liquidity actions, but the MCP runtime does not yet expose a first-class Meteora adapter or generic Blink prepare helper.

## What It Can Read

Planned reads:

- `meteora_dlmm_position` for wallet-specific DLMM position facts.
- `dialect_positions` for generic position facts.
- `dialect_markets` for market and action URL facts.

Do not claim these reads work in MCP until the runtime helper exists.

## What It Can Prepare

Planned Blink-backed actions:

- Add liquidity.
- Withdraw liquidity.
- Claim fees.
- Close position.

The agent needs action metadata from a Meteora Blink or Solana Action URL before it can review any write.

## Required Inputs

- Pool or position address.
- Token amounts or liquidity amount.
- Blink/Solana Action URL.

Ask:

- "Which Meteora pool or DLMM position should I use?"
- "What token amounts should I prepare?"
- "Paste the Meteora Blink or Solana Action URL."

## Required Facts

- Pool and token pair.
- Position address.
- Current bin or range.
- Unclaimed fees and rewards.
- Action metadata.
- Wallet token balances.

## Deny Or Ask

Deny requests to close a position without reading position facts, requests to guarantee range safety or yield, non-mainnet requests, and any request to move funds without wallet approval. Ask for pool, position, amount, and action URL when absent.
