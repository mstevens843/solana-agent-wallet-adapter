# Phoenix Perpetuals adapter — native Rise SDK path

Phoenix Perpetuals is Ellipsis Labs' perp DEX on Solana. This adapter exposes Phoenix as a first-class Agentic connector backed by [`@ellipsis-labs/rise@0.4.9`](https://www.npmjs.com/package/@ellipsis-labs/rise) — the official TypeScript SDK published 2026-04-30.

The native path is the recommended default. It runs in the same process as the rest of the mcp-server, signs through the existing wallet adapter, and exposes typed reads + 5 write actions. For an alternative execution model (subprocess isolation via the Vulcan CLI), see `../../upstreamMcp/README.md`.

## Files

| File | Purpose |
|---|---|
| `client.ts` | `PhoenixClient` interface, `resolvePhoenixClient(ctx)` factory, `redactAccessCode`, `withPhoenixErrors`. |
| `riseClient.ts` | Rise-backed `PhoenixClient`: typed reads + `buildOpenIxs`/`buildCloseIxs`/etc. `hasRiseExtensions(client)` narrows. |
| `apiClient.ts` | Legacy hand-rolled HTTP client. Used only when `PHOENIX_USE_LEGACY_HTTP=true`. Read-only. |
| `instructionBridge.ts` | Converts `@solana/kit` Instructions (Rise's output) → `@solana/web3.js` TransactionInstructions + base64 tx. |
| `actions.ts` | 5 write actions: `phoenix_open`, `phoenix_close`, `phoenix_modify_collateral`, `phoenix_place_trigger`, `phoenix_cancel_order`. Each runs policy first, then routes through Rise. |
| `sharedMath.ts` | `usdToTickPrice`, `tickPriceToUsd`, `projectLiquidationPriceUsd`, `combinePosition` — pure math used by previews + cancel/trigger flows. |
| `healthPreview.ts` | Projected liquidation buffer for open/close hypotheticals. Uses `combinePosition` for existing-position math. |
| `positions.ts`, `markets.ts`, `funding.ts` | Read tools (`getPositionSnapshot`, `getMarketSnapshot`, `getMarketCatalog`, `getFundingHistory`, `getWalletPositions`). |
| `constants.ts` | `PHOENIX_ADAPTER_ID`, `PHOENIX_ACCESS_CODE_ENV`, `PHOENIX_DEFAULT_API_BASE_URL`, `PHOENIX_TICKS_PER_USD`. |
| `index.ts` | Adapter registration: combines reads + actions into the global registry. |

## Setup

1. Get a Phoenix invite code from https://www.phoenix.trade.
2. In Agentic, open **Preferences → Agents & Connectors → Phoenix** and paste the access code.
3. The code is stored encrypted per-wallet in `wallet_preferences` (see [BYO-API-key model](../../../../../../README.md)). The mcp-server reads it via `ctx.connectorSecrets.phoenix.apiKey`.

No host-env setup is required. The Rise SDK and `@solana/kit` are bundled with mcp-server.

## Operator flags

| Env var | Default | Effect |
|---|---|---|
| `PHOENIX_ACCESS_CODE` | — | Process-wide fallback access code (used when no per-wallet override is configured). |
| `PHOENIX_USE_LEGACY_HTTP` | `false` | When `true`, bypasses Rise and uses the legacy hand-rolled HTTP client. Read-only path; writes throw `unsupported_method`. Use only as a temporary fallback if Rise misbehaves. |

## Policy gates

`assertPhoenixPolicyAllowed(config, input)` runs at the top of every action's `prepare()`, before any SDK call. Order:

1. `enabled` — connector toggled on?
2. `readOnly` — writes allowed?
3. `allowedSymbols` — symbol on the allowlist?
4. `maxLeverage` — leverage within cap?
5. `maxNotionalUsd` — notional within cap?
6. `minLiquidationBufferPct` — projected buffer above floor (caller computes via `healthPreview`)?
7. `paperModeOnly` — when true, action must be `mode: 'paper'`.

Configure via `config.connectors.phoenix.perps.*`. Defaults: `enabled: false`, `paperModeOnly: true`, `maxLeverage: 5`, `allowedSymbols: ['SOL-PERP']`. See `getPhoenixPerpsPolicy` in `../../config.ts`.

## Action flow (example: `phoenix_open`)

```
agent → solana_prepare_phoenix_open({symbol, side, baseSize, leverage, mode})
     ↓
actions.ts:phoenixOpenAction.prepare(input, ctx)
     ↓
assertPhoenixPolicyAllowed(ctx.config, {symbol, leverage, notionalUsd, mode})
     ↓
requireRiseClient(ctx) → hasRiseExtensions(client) ? client : throw unsupported_method
     ↓
client.buildOpenIxs({authority, symbol, side, baseUnits})
   = Rise's client.orderPackets.buildMarketOrderPacket(...) → client.ixs.placeMarketOrder(...)
   → returns @solana/kit Instructions
     ↓
buildPhoenixTransactionBase64(ixs, walletAddress, ctx.connection)
   = kit Instructions → web3.js TransactionInstruction → unsigned legacy Transaction → base64
     ↓
return {addInput: {kind: 'phoenix_open', params: {transactionBase64, ...}}, preview}
     ↓ (user reviews in Spend tab, hits Approve)
actions.ts:phoenixOpenAction.execute(action, ctx)
     ↓
rebuilds ixs (fresh blockhash) → ctx.signAndBroadcast(tx, summary) → txid
```

## Testing

Test coverage (as of 2026-05-19): **69 tests** across:

- `__tests__/adapters/phoenix.test.ts` — registration, policy assertions, tick math, health preview, position lookups (42).
- `__tests__/adapters/phoenix/instructionBridge.test.ts` — kit→web3.js conversion (17).
- `__tests__/adapters/phoenix/riseActions.test.ts` — prepare/execute flow with mocked Rise extensions (10).

Run: `pnpm --filter @solana-agent-wallet-adapter/mcp-server test`.

## Live verification (post-deploy smoke)

1. Paste a real Phoenix access code in Preferences for a paper-mode wallet.
2. Ask the agent: "preview opening 0.5 SOL long on Phoenix at 3x leverage."
3. Confirm policy gate runs (paper-mode allowlist) and projected liquidation renders.
4. Ask: "prepare that open."
5. Expect a phoenix_open envelope in the Spend tab with `params.transactionBase64` set.
6. Hit **Approve** → a real Solana tx settles. `txid` appears in the receipt.

If the prepare step fails with `unsupported_method`, the client did not get Rise extensions — check that the access code is configured and `PHOENIX_USE_LEGACY_HTTP` is not set.

## When to use Vulcan instead

Use the Vulcan upstream bridge (`../../upstreamMcp/`) instead of this native path when:

- You need subprocess isolation (e.g., compromised Node.js process shouldn't get wallet key material).
- You already run Vulcan as your operator tool and want a unified wallet model.
- You need wallet primitives (multisig, key rotation) that Vulcan provides natively.

Both paths can coexist in the same mcp-server. The native path is the recommended default; Vulcan stays as an alternative.
