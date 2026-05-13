# Orca Connector

Orca is a first-class Whirlpool connector. The MCP runtime owns pool/position reads and prepare-only liquidity, fee, and reward actions.

## What It Can Read

- `solana_orca_whirlpool_snapshot` returns Whirlpool token mints, vaults, tick spacing, current tick/price, liquidity, fee tier, rewards, and program id.
- `solana_orca_wallet_positions` returns wallet-owned tokenized positions, range status, liquidity, fees, rewards, and warning flags.
- `solana_orca_position_detail` returns one position by `positionMint`.

## What It Can Prepare

- `solana_prepare_orca_increase_liquidity` prepares an `orca_increase_liquidity` inbox item.
- `solana_prepare_orca_decrease_liquidity` prepares an `orca_decrease_liquidity` inbox item.
- `solana_prepare_orca_collect_fees` prepares an `orca_collect_fees` inbox item.
- `solana_prepare_orca_collect_rewards` prepares an `orca_collect_rewards` inbox item.
- `solana_execute_prepared_action` refreshes state, rebuilds the transaction, simulates it, and sends it to the wallet for signing.

## Required Inputs

- Whirlpool snapshot: `whirlpoolAddress`.
- Wallet positions: optional `walletAddress`; optional `whirlpoolAddress` filter.
- Position detail, collect fees, collect rewards: `positionMint`; optional `whirlpoolAddress`.
- Increase liquidity: `whirlpoolAddress`, amount input, optional `positionMint` for existing positions. New positions require `lowerTick` and `upperTick`.
- Decrease liquidity: `whirlpoolAddress`, `positionMint`, and exactly one of `liquidityPercent` or `liquidityAmount`.

## Deny Or Ask

Deny unsupported clusters, unknown Whirlpool program ids, invalid tick order, ticks not aligned to tick spacing, missing position for decrease/collect actions, slippage above the configured cap, delegated managers, recurring LP automation, legacy pools, vaults, and walletless fund movement.

Ask for missing Whirlpool, position, range, amount, or liquidity sizing facts instead of inventing them.

## User Approval

Orca writes create prepared actions. They do not sign, submit, or grant delegated authority. The user still reviews and signs in the wallet.
