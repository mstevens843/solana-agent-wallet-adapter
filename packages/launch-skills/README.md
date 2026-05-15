# @solana-agent-wallet-adapter/launch-skills

Five hand-built `SkillManifest` constants that seed the Layer 2 Skills Hub catalog on day one. Imported by the cloud `skillsRoutes` startup hook to populate the `skill_manifests` table when empty.

## Exports

```ts
import {
  LAUNCH_SKILLS,
  fridayDcaSkill,
  yieldAutoRotateSkill,
  pythStopLossSkill,
  bridgeIdleUsdcSkill,
  recurringDonationSkill,
} from '@solana-agent-wallet-adapter/launch-skills';
```

`LAUNCH_SKILLS` is a `readonly skills.SkillManifest[]` ordered: DCA, yield, stop-loss, bridge, donation.

## Catalog

| Id | Category | Schedule | Action | Monetization |
| --- | --- | --- | --- | --- |
| `friday-dca` | dca | Fri 14:00 UTC | `prepare_swap` USDC → SOL | free |
| `yield-auto-rotate` | yield | daily 13:00 UTC | `yield.auto_rotate` (sentinel) | $0.99 / month |
| `pyth-stop-loss` | stops | price-trigger SOL/USD < $100 | `prepare_swap` SOL → USDC | free |
| `bridge-idle-usdc` | bridge | Mon 15:00 UTC | `prepare_wormhole_transfer` Solana → Base | free |
| `recurring-donation` | donation | 1st of month 14:00 UTC | `prepare_transfer_spl` USDC | free |

## Runtime contracts

These are the interface contracts between this package, the executor, and the cloud routes. Do not drift.

### 1. `connectorAction` naming

Format: `prepare_<mcp_suffix>` where `<mcp_suffix>` is the MCP tool name minus its `solana_` prefix. So MCP tool `solana_prepare_swap` → `connectorAction: 'prepare_swap'`.

Sentinel form `<namespace>.<action>` (containing a dot) signals a runtime-resolved meta-action that the executor must resolve. The only sentinel in v1 is `yield.auto_rotate`.

### 2. `schedule.spec` encoding

- `kind: 'cron'` — standard 5-field POSIX cron string in **UTC**, e.g. `'0 14 * * 5'`.
- `kind: 'interval'` — ISO 8601 duration, e.g. `'PT1H'`, `'P1D'`, `'P1W'`.
- `kind: 'price-trigger'` — JSON-encoded object as a string: `'{"feedId":"0x<hex>","op":"<","threshold":"100"}'`. `op` ∈ `<`, `<=`, `>`, `>=`. `threshold` is a decimal string. `feedId` is the Pyth price feed ID with `0x` prefix.

### 3. Cap units

`caps.perRunMaxAmount` and `caps.lifetimeMaxAmount` are **human-decimal token amounts as strings**, denominated in the **first entry of `caps.allowlistedTokens`**. Strings preserve big-int precision and match the MCP `prepare_*` tool convention (`amount: z.string()`).

### 4. Manifest `expiresAt` vs install `expiresAt`

Manifest-level `caps.expiresAt` is the **manifest horizon** (~1 year; forces eventual version refresh). The per-install `expiresAt` is a separate concern that the install handler sets from user input.

## Sentinel actions

The `yield.auto_rotate` sentinel signals "executor picks the best vault at runtime." The cloud executor:

1. Read `paramsTemplate.token` and `paramsTemplate.amount` plus the optional `minApyDeltaBps`.
2. Query USDC APY through stateless connector facts for Lulo Protected, Kamino, Save, and Jupiter Lend Earn.
3. Resolve to the appropriate concrete `prepare_*` connector action (`prepare_jupiter_lend_earn_deposit`, `prepare_kamino_deposit`, etc.).
4. Propose the resulting approval to the wallet.

Provider read failures are skipped; if no valid APY candidate remains, the executor does not propose a blind fallback. The aggregate test guards the catalog contract by asserting `yield.auto_rotate` is the only dotted action in the catalog.

## Demo placeholders

- `bridgeIdleUsdcSkill.action.paramsTemplate.destinationAddress` uses `{{install.destinationAddress}}`.
- `recurringDonationSkill.action.paramsTemplate.recipient` uses `{{install.recipient}}`.
- The install UI and API must collect those values, persist them as install params, and mirror them into per-install recipient caps.
