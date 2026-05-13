# Meteora Connector

Meteora is a first-class MCP connector for DLMM pool and position reads plus prepare-only position actions. It does not use Blink URLs for the exposed DLMM flow.

## What It Can Read

- `solana_meteora_dlmm_pool_snapshot` for pool token mints, active bin, bin step, fees, liquidity, and program id.
- `solana_meteora_wallet_positions` for wallet-owned DLMM positions, optionally filtered to one pool.
- `solana_meteora_position_detail` for one position's bin range, liquidity, fees, rewards, and in-range status.

## What It Can Prepare

- `solana_prepare_meteora_claim_fees`
- `solana_prepare_meteora_claim_rewards`
- `solana_prepare_meteora_add_liquidity`
- `solana_prepare_meteora_remove_liquidity`
- `solana_prepare_meteora_close_position`

Prepared actions become manual Approval Inbox items and execute through `solana_execute_prepared_action`. The adapter refreshes DLMM state at execution time before asking the wallet to sign.

## Required Inputs

- Pool address.
- Position address for position-specific reads and writes.
- Token X or token Y amount for add-liquidity.
- Bin range and strategy for add-liquidity.
- Liquidity percent or bps for remove-liquidity.

Ask:

- "Which Meteora DLMM pool should I use?"
- "Which Meteora DLMM position should I use?"
- "What amount and bin range should I prepare?"

## Required Facts

- Pool token pair.
- Active bin and selected bin range.
- Position liquidity and in-range status.
- Unclaimed fees and rewards.
- Slippage cap and strategy type.
- Wallet token balances.

## Deny Or Ask

Deny new DLMM position creation, close-position requests for non-empty positions, non-mainnet requests, profitability or APY guarantees, and any request to move funds without wallet approval. Ask for missing pool, position, amount, bin range, or liquidity percentage before preparing an action.
