# First-Class Connector Implementation Map

Purpose: complete Jupiter beyond swaps and turn planned protocol connectors from Blink-backed or planned entries into first-class Agentic connectors with owned reads, checks, prepared actions, and wallet approval execution.

Folder name intentionally preserves the requested spelling: `firstclassconnectrors`.

## Connector Set

Baseline already in repo:

- Kamino: existing first-class adapter shape under `packages/mcp-server/src/adapters/kamino`.
- Jupiter: already first-class for swap quote, prepared swap, direct wallet swap, and approval-time quote refresh through `AgentWalletActionService`.

Jupiter completion plans in this folder:

- `jupiter.md`
- `jupiter-swap-v2.md`
- `jupiter-lend.md`
- `jupiter-trigger.md`
- `jupiter-recurring.md`
- `jupiter-token-price.md`
- `jupiter-prediction.md`
- `jupiter-perps.md`

Core DeFi first-class connector plans in this folder:

- `raydium.md`
- `orca.md`
- `meteora.md`
- `marginfi.md`
- `project0.md`
- `drift.md`
- `lulo.md`
- `save.md`

Expansion connector plans in this folder:

- `tensor.md`
- `magiceden.md`
- `sanctum.md`
- `jito.md`
- `marinade.md`
- `wormhole.md`
- `mayan.md`
- `squads.md`
- `realms.md`
- `pyth.md`

## Shared Definition Of First-Class

A connector is first-class only when Agentic owns these behaviors directly:

- Structured connector facts for agent planning and review.
- Runtime readiness checks that explain missing config instead of pretending support exists.
- Prepare-only wallet approval actions with stable `PreparedActionKind` values.
- Execution only through `solana_execute_prepared_action` or the matching approval flow.
- Receipts and terminal action states after approval, rejection, failure, archive, or confirmation.
- Unit and smoke coverage for reads, prepares, denials, missing config, unsupported cluster, and terminal state protection.

First-class does not mean autonomous signing. Every money-moving action must still stop at the wallet approval boundary.

## Shared Runtime Work

One shared runtime worker should own these shared files before connector workers land large patches:

- `packages/mcp-server/src/adapters/types.ts`
- `packages/mcp-server/src/adapters/registry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `packages/mcp-server/src/actionTools.ts`
- `packages/mcp-server/src/actionService.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/package.json`
- `apps/browser-demo/src/connectedDapps.ts`
- `spec/connectors/*.connector.json`
- `docs/connectors/README.md`

Shared runtime changes:

- Extend `DAppAdapterId` with `raydium`, `orca`, `meteora`, `marginfi`, `project0`, `drift`, `lulo`, `save`, `tensor`, `magiceden`, `sanctum`, `jito`, `marinade`, `wormhole`, `mayan`, `squads`, `realms`, and `pyth`.
- Extend `PreparedActionKind` with connector-specific kinds listed in each connector doc.
- Add a common `serializeTransactionForApproval` helper that accepts legacy `Transaction` and v0 `VersionedTransaction` shapes and returns base64 bytes plus a preview object.
- Add a common `readonlyWallet(owner: PublicKey)` adapter helper for SDKs that require a wallet-like object but must not sign inside reads/prepares.
- Add connector readiness conventions:
  - `ready.reads`
  - `ready.actions`
  - `missingConfig`
  - `unsupportedCluster`
  - `sdkUnavailable`
- Treat connector SDKs as optional dependencies where possible so users can still run the core MCP server without every DeFi SDK installed.
- Keep env names explicit:
  - `RAYDIUM_API_BASE_URL` optional
  - `LULO_API_KEY` required for Lulo live API
  - `LULO_API_BASE_URL` optional
  - `DRIFT_ENV` optional, default mainnet-beta
  - `TENSOR_API_KEY` required for Tensor REST reads if enabled
  - `TENSOR_API_BASE_URL` optional
  - `MAGICEDEN_API_KEY` required for Magic Eden gated endpoints
  - `MAGICEDEN_API_BASE_URL` optional
  - `JUPITER_SWAP_BASE_URL` optional, default `https://api.jup.ag/swap/v2`
  - `JUPITER_LEND_BASE_URL` optional, default `https://api.jup.ag/lend/v1`
  - `JUPITER_TRIGGER_BASE_URL` optional, default `https://api.jup.ag/trigger/v2`
  - `JUPITER_RECURRING_BASE_URL` optional, default `https://api.jup.ag/recurring/v1`
  - `JUPITER_TOKENS_BASE_URL` optional, default `https://api.jup.ag/tokens/v2`
  - `JUPITER_PRICE_BASE_URL` optional, default `https://api.jup.ag/price/v3`
  - `JUPITER_PREDICTION_BASE_URL` optional, default `https://api.jup.ag/prediction/v1`
  - `MAYAN_API_KEY` optional, only needed when public Mayan rate limits are hit
  - `MAYAN_PRICE_API_BASE_URL` optional
  - `PROJECT0_API_BASE_URL` optional, default `https://ai.0.xyz`
  - `P0_API_BASE_URL` optional alias
  - `PYTH_HERMES_URL` optional, default `https://hermes.pyth.network`
  - Avoid storing provider keys, AI keys, wallet secrets, or API secrets in receipts.

## Shared Adapter Pattern

Each connector should follow the existing Kamino adapter shape:

```text
packages/mcp-server/src/adapters/<connector>/
  constants.ts
  client.ts
  index.ts
  reads.ts or positions.ts
  <action>.ts
```

Every adapter action should return:

- `addInput`: durable prepared-action input.
- `preview`: user-facing action facts, risk facts, touched programs, token mints, amounts, slippage/range/health data, and protocol-specific warnings.

Every adapter execute path should:

- Rebuild or refresh the transaction from current state where the protocol requires freshness.
- Re-check wallet address and cluster.
- Re-check caps, health, slippage, range, or withdrawal-state constraints.
- Call the existing `signAndBroadcast(transactionBase64, summary)` boundary.
- Return `txid`, `signedAt`, and a preview snapshot.

## Parallel Ownership Rules

Use these write scopes to avoid conflicts:

- Shared runtime worker: shared type unions, registry wiring, generic helpers, dependency manifest, common test fixtures.
- Jupiter shared worker: Jupiter product config, common API client, connector capability groups, product readiness, shared Jupiter tests, and `jupiter.md`.
- Jupiter swap worker: Swap API v2 alignment, existing swap tool preservation, swap tests, and `jupiter-swap-v2.md`.
- Jupiter lend worker: `packages/mcp-server/src/adapters/jupiter/**` Lend Earn/Borrow modules, lend tests, and `jupiter-lend.md`.
- Jupiter trigger worker: Jupiter Trigger auth, vault, order, cancel/withdraw modules, trigger tests, and `jupiter-trigger.md`.
- Jupiter recurring worker: Jupiter native DCA modules, recurring tests, and `jupiter-recurring.md`.
- Jupiter token/price worker: Token API V2, Price API V3, token risk evidence, tests, and `jupiter-token-price.md`.
- Jupiter prediction worker: Prediction beta read-only modules, prediction tests, and `jupiter-prediction.md`.
- Jupiter perps worker: Perps status/read-only research modules, perps tests, and `jupiter-perps.md`.
- Raydium worker: `packages/mcp-server/src/adapters/raydium/**`, Raydium tests, Raydium connector pack updates, Raydium docs.
- Orca worker: `packages/mcp-server/src/adapters/orca/**`, Orca tests, Orca connector pack updates, Orca docs.
- Meteora worker: `packages/mcp-server/src/adapters/meteora/**`, Meteora tests, Meteora connector pack updates, Meteora docs.
- MarginFi worker: `packages/mcp-server/src/adapters/marginfi/**`, MarginFi tests, MarginFi connector pack updates, MarginFi docs.
- Project 0 worker: `packages/mcp-server/src/adapters/project0/**`, Project 0 tests, Project 0 connector pack updates, Project 0 docs.
- Drift worker: `packages/mcp-server/src/adapters/drift/**`, Drift tests, Drift connector pack updates, Drift docs.
- Lulo worker: `packages/mcp-server/src/adapters/lulo/**`, Lulo tests, Lulo connector pack updates, Lulo docs.
- Save worker: `packages/mcp-server/src/adapters/save/**`, Save tests, Save connector pack updates, Save docs.
- Tensor worker: `packages/mcp-server/src/adapters/tensor/**`, Tensor tests, Tensor connector pack updates, Tensor docs.
- Magic Eden worker: `packages/mcp-server/src/adapters/magiceden/**`, Magic Eden tests, Magic Eden connector pack updates, Magic Eden docs.
- Sanctum worker: `packages/mcp-server/src/adapters/sanctum/**`, Sanctum tests, Sanctum connector pack updates, Sanctum docs.
- Jito worker: `packages/mcp-server/src/adapters/jito/**`, Jito tests, Jito connector pack updates, Jito docs.
- Marinade worker: `packages/mcp-server/src/adapters/marinade/**`, Marinade tests, Marinade connector pack updates, Marinade docs.
- Wormhole worker: `packages/mcp-server/src/adapters/wormhole/**`, Wormhole tests, Wormhole connector pack updates, Wormhole docs.
- Mayan worker: `packages/mcp-server/src/adapters/mayan/**`, Mayan tests, Mayan connector pack updates, Mayan docs.
- Squads worker: `packages/mcp-server/src/adapters/squads/**`, Squads tests, Squads connector pack updates, Squads docs.
- Realms worker: `packages/mcp-server/src/adapters/realms/**`, Realms tests, Realms connector pack updates, Realms docs.
- Pyth worker: `packages/mcp-server/src/adapters/pyth/**`, Pyth tests, Pyth connector pack updates, Pyth docs.
- Browser UI worker: connector labels, first-class chips, enablement copy, planner template copy, screenshots.
- QA worker: scenario prompts, smoke docs, release checklist, connector matrix.

Connector workers should not edit package manifests or shared union types unless the shared runtime worker or Jupiter shared worker has not done that pass yet.

## Cross-Connector Acceptance Criteria

Each connector is done when:

- `solana_connector_capabilities` reports the connector as first-class for its implemented reads/actions.
- `solana_connector_read_facts` returns stable JSON facts for at least one useful read path.
- Each write path creates a prepared action and never signs during prepare.
- `solana_execute_prepared_action` executes the prepared action through wallet approval only.
- Missing required inputs produce `invalid_request` with a human-readable missing field.
- Missing SDK/API config produces `unauthorized` or `unsupported_method` with a fix.
- Unsupported clusters produce `unsupported_cluster`.
- Unit tests cover success, missing input, missing config, and unsupported cluster.
- Planner copy does not claim an action is signed, submitted, guaranteed safe, profitable, reversible, or approved.

## Suggested Execution Order

1. Shared runtime pass.
2. Jupiter shared pass, because Jupiter is the highest-usage connector and needs one common product config/client.
3. Jupiter Token/Price, because read-only token evidence improves every Jupiter review.
4. Jupiter Swap API v2 alignment, because swaps are already shipped and should stay current.
5. Jupiter Lend Earn, then Jupiter Lend Borrow, because Lend is a major missing Jupiter surface.
6. Jupiter Recurring, then Jupiter Trigger, because both are Jupiter-native automation and need explicit product-safety treatment.
7. Jupiter Prediction beta reads and Perps read-only status.
8. Lulo and Save, because their APIs/SDKs produce unsigned transactions and are good connector pattern tests.
9. Orca and Meteora, because both are liquidity-position connectors with clear position/fee semantics.
10. Raydium, because it spans CPMM, CLMM, farm, and staking.
11. MarginFi, because account health and borrow/repay need stricter risk previews.
12. Project 0, because MarginFi migration support needs a separate first-class connector while keeping MarginFi.
13. Drift vaults, limited to vault deposit/withdraw lifecycle in v1.
14. Jito, Marinade, and Sanctum, because liquid staking is high-demand and has cleaner prepare-only transaction boundaries.
15. Tensor, because it adds the highest-value NFT marketplace surface with public SDK packages.
16. Magic Eden, read-first, because the Solana API remains useful but should be isolated behind API health checks.
17. Mayan, then Wormhole, because Mayan gives a higher-level cross-chain swap UX before lower-level bridge primitives.
18. Squads and Realms, because org workflows need proposal/vote safety gates and do not move funds directly unless a proposal reaches protocol-defined approval.
19. Pyth, because oracle facts improve risk evidence across every connector and its write path is optional.
20. Browser UI polish and full QA matrix.

## Global Test Commands

After any connector lands:

```sh
pnpm -F @solana-agent-wallet-adapter/mcp-server test
pnpm -F @solana-agent-wallet-adapter/mcp-server typecheck
pnpm -F @solana-agent-wallet-adapter/browser-demo test
pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck
```

Full release verification remains:

```sh
pnpm typecheck
pnpm -r test
pnpm build
```

## Shared Safety Rules

- Never request private keys, seed phrases, wallet auth tokens, or unlimited approval authority.
- Never create protocol delegates in v1 unless a connector doc explicitly adds a reviewed, separate delegation plan.
- Never auto-execute recurring protocol actions. Recurring still creates approval items.
- Never treat reads as approval.
- Never execute a prepared action from `approved`, `rejected`, `blocked`, `failed`, archived, scheduled, or pending-terminal states.
- Never store API keys, AI keys, bearer tokens, or raw provider secrets in receipts, prepared-action notes, or evidence.
- For Jupiter Trigger and Jupiter Recurring, always label the flow as Jupiter-native automation when future executions happen outside Agentic's approval inbox.
- Never store Jupiter JWTs, signed challenges, signed setup transactions, or bearer headers in durable stores.

## Official References

- Raydium docs: https://docs.raydium.io/
- Orca developer docs: https://docs.orca.so/developers/overview
- Meteora DLMM SDK docs: https://docs.meteora.ag/developer-guide/guides/dlmm/typescript-sdk/getting-started
- MarginFi TypeScript SDK docs: https://docs.marginfi.com/ts-sdk
- Drift developer docs: https://docs.drift.trade/developers
- Lulo integration/API docs: https://www.lulo.fi/docs/integration-guide
- Save/Solend SDK docs: https://sdk.solend.fi/modules.html
- Tensor API and SDK docs: https://docs.tensor.trade/trade/api-and-sdk
- Tensor protocol docs: https://docs.tensor.foundation/protocols
- Magic Eden developer docs: https://docs.magiceden.io/
- Magic Eden API infrastructure notice: https://help.magiceden.io/en/articles/13885533-magic-eden-api-infrastructure-changes
- Sanctum docs: https://learn.sanctum.so/docs
- JitoSOL staking integration docs: https://www.jito.network/docs/jitosol/jitosol-liquid-staking/for-developers/staking-integration/
- Marinade TypeScript SDK: https://github.com/marinade-finance/marinade-ts-sdk
- Wormhole TypeScript SDK docs: https://wormhole.com/docs/tools/typescript-sdk/get-started/
- Mayan integration docs: https://docs.mayan.finance/
- Squads developer docs: https://docs.squads.so/main/development/typescript/accounts/multisig
- Realms SPL Governance docs: https://docs.realms.today/developer-resources/spl-governance
- Pyth Solana price-feed docs: https://docs.pyth.network/price-feeds/use-real-time-data/solana
- Jupiter developer docs: https://developers.jup.ag/docs/
- Jupiter Swap API docs: https://developers.jup.ag/docs/swap
- Jupiter Swap order/execute docs: https://developers.jup.ag/docs/swap/order-and-execute
- Jupiter Lend API vs SDK docs: https://developers.jup.ag/docs/lend/api-vs-sdk
- Jupiter Lend program addresses: https://developers.jup.ag/docs/lend/program-addresses
- Jupiter Trigger V2 docs: https://developers.jup.ag/docs/trigger
- Jupiter Trigger auth docs: https://developers.jup.ag/docs/trigger/authentication
- Jupiter Recurring docs: https://developers.jup.ag/docs/recurring
- Jupiter Token API V2 docs: https://developers.jup.ag/docs/tokens/token-information
- Jupiter Price API V3 docs: https://developers.jup.ag/docs/price
- Jupiter Prediction API beta docs: https://developers.jup.ag/docs/api-reference/prediction/get-events
- Jupiter Perps docs: https://developers.jup.ag/docs/perps
