# Planned Blink-Backed Connectors

These connectors are present in the browser protocol catalog, but MCP does not yet expose first-class runtime helpers for their reads or writes. Agents should use them for capability explanations, needs-input questions, and honest denials until the runtime helper exists.

## Raydium

Planned reads: `dialect_markets` for AMM, CLMM, farm, and Stake RAY facts.

Planned writes: `blink_action` for AMM, CLMM, farm, and Stake RAY.

Required facts: pool or farm address, token amounts, pool type, liquidity/reward facts, action URL metadata.

Deny: guaranteed APY, non-mainnet actions, missing pool/action URL, or walletless fund movement.

## Orca

Planned reads: `dialect_markets` for Whirlpool market and fee facts.

Planned writes: `blink_action` for liquidity and fee actions.

Required facts: Whirlpool address, position address for fee/withdrawal actions, tick range, token amounts, action URL metadata.

Deny: guaranteed range safety, missing position for fee claims, non-mainnet actions, or walletless fund movement.

## MarginFi

Planned reads: `dialect_positions` and `dialect_markets` for lending positions, borrow balances, market APY, and account health.

Planned writes: `blink_action` for deposit, withdraw, borrow, and repay.

Required facts: asset, amount, bank/account, health factor for borrow or withdraw, action URL metadata.

Deny: borrow or withdraw without health facts, unspecified repay, guaranteed liquidation safety, non-mainnet actions, or walletless fund movement.

## Drift

Planned reads: `dialect_markets` for strategy vault facts.

Planned writes: `blink_action` for strategy vault deposit and withdraw.

Required facts: vault address, strategy, deposit token, amount, withdrawal terms, action URL metadata.

Deny: perp order placement, generic position close, guaranteed yield, non-mainnet actions, or walletless fund movement.

## Lulo

Planned reads: `dialect_positions` and `dialect_markets` for protected/boosted deposits, APY, and rewards.

Planned writes: `blink_action` for deposit, withdraw, and rewards.

Required facts: asset, amount, position or reward account, APY/liquidity facts, action URL metadata.

Deny: vague "all tokens" requests, guaranteed yield, missing action URL, non-mainnet actions, or walletless fund movement.

## Save

Planned reads: `dialect_positions` and `dialect_markets` for deposits, APY, and rewards.

Planned writes: `blink_action` for deposit, withdraw, and rewards.

Required facts: asset, amount, position or reward account, APY/liquidity facts, action URL metadata.

Deny: vague "all tokens" requests, guaranteed yield, missing action URL, non-mainnet actions, or walletless fund movement.
