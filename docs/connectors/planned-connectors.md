# Planned Blink-Backed Connectors

These connectors are present in the browser protocol catalog, but MCP does not yet expose first-class runtime helpers for their reads or writes. Agents should use them for capability explanations, needs-input questions, and honest denials until the runtime helper exists. Orca has moved to `docs/connectors/orca.md`. MarginFi has moved to first-class lending support (see `spec/connectors/marginfi.connector.json`). Drift has moved to first-class vault support (see `spec/connectors/drift.connector.json`). Save has moved to first-class lending support (see `spec/connectors/save.connector.json`). Lulo has moved to first-class lending support (see `docs/connectors/lulo.md` and `spec/connectors/lulo.connector.json`).

## Raydium

Planned reads: `dialect_markets` for AMM, CLMM, farm, and Stake RAY facts.

Planned writes: `blink_action` for AMM, CLMM, farm, and Stake RAY.

Required facts: pool or farm address, token amounts, pool type, liquidity/reward facts, action URL metadata.

Deny: guaranteed APY, non-mainnet actions, missing pool/action URL, or walletless fund movement.
