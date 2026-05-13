# Sanctum Connector

Sanctum is a first-class LST, Router, and Infinity connector. The MCP runtime owns reads for LST metadata, Infinity pool facts, wallet LST/INF positions, and Token Swap quote previews. Writes create prepared actions only; the adapter refreshes the Sanctum order at execution time and the wallet signs.

## Requirements

- Mainnet-beta only.
- `SANCTUM_API_KEY` must be set in the host environment. It is sent as the Sanctum API `apiKey` parameter and is never stored in prepared-action params, receipts, notes, or browser state.
- `SANCTUM_API_BASE_URL` is optional; defaults to `https://sanctum-api.ironforge.network`.
- `SANCTUM_CONNECTOR_ENABLED=false`, `0`, or `off` disables the connector.
- The adapter uses Sanctum Token Swap order and execute endpoints. It does not silently fall back to Jupiter.

## What It Can Read

- `solana_sanctum_lst_list` returns the Sanctum LST catalog.
- `solana_sanctum_lst_snapshot` returns one LST by mint or symbol, with optional APY rows.
- `solana_sanctum_infinity_pool_snapshot` returns Infinity metadata, INF mint, program ids, and optional catalog-derived composition.
- `solana_sanctum_wallet_positions` returns wallet LST and INF token balances from SPL Token and Token-2022 accounts.
- `solana_sanctum_quote` previews a Sanctum Token Swap order without signing.

## What It Can Prepare

- `solana_prepare_sanctum_swap_lst` prepares `sanctum_swap_lst` through Sanctum Router/Infinity sources.
- `solana_prepare_sanctum_add_infinity_liquidity` prepares `sanctum_add_infinity_liquidity` using Infinity sources only.
- `solana_prepare_sanctum_remove_infinity_liquidity` prepares `sanctum_remove_infinity_liquidity` using Infinity sources only.
- `solana_prepare_sanctum_stake_sol_to_lst` prepares `sanctum_stake_sol_to_lst`.
- `solana_prepare_sanctum_unstake_lst_to_sol` prepares `sanctum_unstake_lst_to_sol`; delayed unstake routes are refused unless `allowDelayedUnstake` is true.
- `solana_execute_prepared_action` refreshes the Sanctum order, checks slippage, minimum output, fee cap, and route sources, then asks the wallet to sign.

## Deny Or Ask

Deny any request that asks the agent to:

- Move funds without wallet approval.
- Use Sanctum on devnet, testnet, or localnet.
- Promise guaranteed APY, liquidity, principal safety, or instant unstake.
- Manage validators, create custom LST pools, perform LST issuer admin actions, or automate recurring LST rebalances.
- Route through Jupiter as a fallback when Sanctum cannot quote.

Ask concise questions when mints, amount, minimum output, or delayed-unstake acceptance is missing.

## User Approval

Sanctum writes are prepare-only. Prepared actions store quote facts and route constraints, not a reusable transaction. At execution time the adapter gets a fresh Sanctum Token Swap order, refuses disallowed route sources or cap drift, asks the wallet to sign the transaction, and submits the signed transaction through Sanctum execute.
