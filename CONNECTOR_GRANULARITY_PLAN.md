# Cascading Connector Dropdowns + Blink Classifier + Recurring Connector Plans

## Status (2026-05-13)

- **Phase 0 — Shared infrastructure**: DONE. Schema (`packages/workflow/src/agentPlans.ts`), sub-action helpers (`apps/browser-demo/src/connectorDrafting.ts`), provider registry (`apps/browser-demo/src/connectorOptionProviders.ts`), cascading-select rendering + chip picker in `main.ts`, CSS in `styles.css`, 16 new unit tests + all 328 browser-demo tests pass.
- **Phase 1 — Per-connector**: Kamino, Jupiter Lend (unified earn/borrow), Marginfi, Save, Drift, Lulo (tier bifurcation), Raydium (CPMM/CLMM bifurcation) DONE. Remaining: Marinade, Jito, Sanctum, Meteora, Orca, Magic Eden, Tensor, Squads, Realms, Wormhole, Pyth (11 connectors). Each remaining connector should follow the patterns established in `connectorDrafting.ts` (form helper) and `connectorOptionProviders.ts` (provider with positions-first + manual fallback).
- **Phase 2 — Blink classifier**: Taxonomy (`packages/mcp-server/src/blinkClassification.ts`), reviewer prompt wired into `aiPlanner.ts:aiReviewMessages`, `blinkClassification` slot added to `agentFindingsSpec.ts` + presentation labels, 11 new mcp-server tests + all 601 mcp-server tests pass. **Pending**: §2.4 simulation enrichment in `prepareBlinkAction` handler (`actionService.ts:2054`) — without invoked-program-IDs and SPL deltas in `params.simulationSummary`, the classifier has limited signal.
- **Phase 3 — Recurring connector plans**: not started.
- **Phase 4 — Recurring Blink policy**: not started.
- **Phase 5 — Integration verification**: not started.

For an agent picking up a remaining connector ticket: read its section under "Phase 1 — Per-connector" below, use `connectorDrafting.ts:62-130` (Kamino + Jupiter Lend examples) and `connectorOptionProviders.ts` (Kamino reserve + Jupiter Lend providers) as canonical references, run `pnpm typecheck` + `pnpm vitest run` from `apps/browser-demo` after each change.

## Context

Today the "Create Plan" UI in `apps/browser-demo/src/main.ts` is a flat 3-step flow: pick template → pick connector → fill text inputs. Connectors like Kamino expose hundreds of reserves, Jupiter Lend has two entirely separate product trees (Earn vs Borrow), Raydium splits CPMM vs CLMM, Lulo has three deposit tiers, and Orca/Meteora positions are tokenized — none of which the current form schema can express. Users have to manually paste a `reserveMint` or `bankAddress`, which means in practice the connectors don't actually work from the UI without out-of-band research.

This plan addresses three coupled gaps:

1. **Cascading sub-dropdowns per connector** — bifurcated verbs (deposit-earn vs deposit-liquidity), pool/reserve/vault selectors populated from live MCP discovery, dependency-driven cascades (e.g. Squads multisig → proposal).
2. **Blink classification taxonomy** — a closed-set classifier reviewer for `blink_action` drafts so long-tail protocols reached only via Blinks pass the same risk review as first-class adapters. Categories: safe_claim, safe_governance_vote, safe_donation_or_tip, lp_position_management, nft_marketplace, mint_or_buy, disguised_transfer, token_account_drain, unknown_program_interaction, unparseable.
3. **Recurring plans for connector actions and Blinks** — today recurring payments only support SOL/SPL transfers. Extend the schema so a recurring entry can persist a parametric connector template (re-prepares on each occurrence, fails closed on missing pool).

Applies to both the **Create Plan** flow and the **Create Recurring Plan** flow in `/app`.

---

## Parallelization model

This plan is split so individual agents can implement one connector each in parallel **after** the shared infrastructure (Phase 0) is in place. Phase 0 must land before any Phase 1 connector task starts — those tasks all import the new schema types and option provider registry. Phases 2 and 3 are independent of each connector ticket and can run alongside Phase 1.

Recommended execution sequence:

1. **Phase 0** — single agent, sequential. ~3–4 hours work. Lands the schema, registry, UI scaffolding, tests.
2. **Phase 1** — up to 18 parallel agents, one per connector. Each agent reads its connector section in this plan, implements the cascading form + option providers, adds tests. ~1–2 hours per agent.
3. **Phase 2** — single agent, parallel with Phase 1. Blink classification taxonomy + reviewer prompt + findings spec.
4. **Phase 3** — single agent, after Phase 1 is mostly done (depends on `effectiveFormFields()` + sub-action schema). Recurring connector schema + materialization.
5. **Phase 4** — single agent, after Phase 2 + 3. Recurring Blink policy + cadence floor + per-occurrence reclassification.
6. **Phase 5** — integration smoke + verification.

After this plan is approved, the implementing agent should first copy/translate it into `/Users/devlegacy/Desktop/projects/solana-agent-wallet-adapter/CONNECTOR_GRANULARITY_PLAN.md` at the project root so subagents can `Read` it directly during parallel work.

---

## Phase 0 — Shared infrastructure (sequential, must ship first)

### 0.1 Schema extensions

**File: `packages/workflow/src/agentPlans.ts`**

Extend `TemplateFieldType` (line 5):
```ts
export type TemplateFieldType =
  | 'text' | 'number' | 'textarea' | 'select' | 'datetime-local'
  | 'cascading-select';
```

Add type and extend `AgentPlanTemplateField` (line 37-45):
```ts
export interface CascadingSelectOptions {
  dependsOn: string[];                // field ids that must be filled first
  providerId: string;                 // key into CONNECTOR_OPTION_PROVIDERS
  allowManualFallback?: boolean;      // when MCP fetch fails, show free-text input
  emptyHint?: string;                 // plain-English help line
}

export interface AgentPlanTemplateField {
  id: string;
  label: string;
  type?: TemplateFieldType;
  placeholder?: string;
  defaultValue?: string;
  options?: string[];
  required?: boolean;
  cascading?: CascadingSelectOptions;          // NEW
  showWhen?: Record<string, string | string[]>; // NEW: hide unless sibling field matches
}
```

**File: `apps/browser-demo/src/connectorDrafting.ts`**

Add sub-action support around `ConnectorActionForm` (line 19-31):
```ts
export interface ConnectorSubAction {
  id: string;                          // 'earn' | 'borrow' | 'cpmm' | 'clmm' | ...
  label: string;                       // 'Earn (single-asset pool)'
  description: string;                 // plain-English
  actionType: string;                  // backend action type override
  fields: AgentPlanTemplateField[];    // fields shown when this branch is picked
}

export interface ConnectorActionForm {
  // ...existing fields
  subActions?: {
    fieldId: string;                   // typically 'subAction'
    label: string;                     // 'Deposit type'
    options: ConnectorSubAction[];
    defaultId?: string;
  };
}
```

Add helper `effectiveFormFields(form, params): AgentPlanTemplateField[]` that returns `form.fields` concatenated with `selectedSubAction?.fields ?? []`. All existing iteration sites (`main.ts` template rendering, `connectorAiPlannerContext`, `planner.ts` template generation) must switch to this helper.

Update `connectorActionFormTemplateActionType()` (around line 460) to return `selectedSubAction?.actionType ?? form.actionType`.

### 0.2 Option provider registry

**New file: `apps/browser-demo/src/connectorOptionProviders.ts`**

```ts
export interface ConnectorOption {
  value: string;                       // identifier stored in templateFields
  label: string;                       // 'USDC reserve'
  detail?: string;                     // 'Your supply 250 USDC · APY 5.2%'
  group?: 'positions' | 'all';         // user positions first, then all
  meta?: {
    apy?: string;
    tvl?: string;
    balance?: string;
    symbol?: string;
  };
}

export interface ConnectorOptionProviderContext {
  fieldValues: Record<string, string>; // current form state
  walletAddress?: string;
  cluster: string;
}

export interface ConnectorOptionProvider {
  id: string;
  ttlMs: number;
  fetch(ctx: ConnectorOptionProviderContext): Promise<ConnectorOption[]>;
}

export const CONNECTOR_OPTION_PROVIDERS: Record<string, ConnectorOptionProvider> = {};
```

Providers go through existing `bridgeRequest('/bridge/action/connector-read-facts', ...)` — no new bridge route needed. Both `solana_connector_read_facts` and direct snapshot tools (e.g. `solana_kamino_reserve_snapshot`) are accessible through that path.

### 0.3 UI scaffolding

**File: `apps/browser-demo/src/main.ts`**

Add state slots (near existing `state.templateFields`):
```ts
state.templateFieldOptionCache: Record<string, {
  options: ConnectorOption[];
  fetchedAt: number;
  ttlMs: number;
  error?: string;
}>;
state.templateFieldOptionLoading: Record<string, boolean>;
```

Cache key: `${providerId}|${depKey}|${walletAddress}|${cluster}`. Invalidate on wallet/cluster change.

Add `connectorSubActionPicker(form, params)` (~30 LOC) — renders a chip row inside `connectorOperationFieldInput()` (line 11185) when `form.subActions` is set. Click sets `state.templateFields[fieldId]` and re-renders the form.

Extend `templateFieldInput()` (line 11073) to handle `cascading-select`:
```ts
if (fieldDef.type === 'cascading-select' && fieldDef.cascading) {
  return cascadingSelectFieldInput(fieldDef, value, label, error);
}
```

New `cascadingSelectFieldInput()` (~80 LOC) handles four states:
- **Dependencies unsatisfied** → disabled select, label "Choose <dep> first".
- **Loading** → disabled select, "Loading…" placeholder; debounced fetch on mount/dep change.
- **Loaded** → grouped `<select>` with `<optgroup label="Your positions">` first, then "All".
- **Error or empty** → if `allowManualFallback`, render `<input>` with hint "Couldn't load options; paste address" + retry button.

Add `showWhen` evaluation at the top of `templateFieldInput()` — return empty string if sibling field values don't match. Mirrors existing `connectorCreateOwnsTemplateField` pattern (line 11079).

### 0.4 Recurring composer reuse

The recurring composer (`recurringConnectorActionPicker` around `main.ts:29232`) already iterates connector forms. Replace the hardcoded asset/recipient grid (around line 28950) with `effectiveFormFields(selectedForm, draft).map(templateFieldInput)` so connector forms get cascading rendering for free in the recurring flow.

### 0.5 Tests

- `apps/browser-demo/src/__tests__/cascadingSelect.test.ts` — option cache TTL, dependency gating, fallback to manual input on fetch failure, position-group ordering.
- `apps/browser-demo/src/__tests__/connectorSubActions.test.ts` — sub-action selection toggles `effectiveFormFields`; `actionType` resolves correctly.

---

## Phase 1 — Per-connector implementation (parallelizable)

Each connector below is a self-contained ticket. An agent picking up a connector should:

1. Read its section here + the existing form definitions in `connectorDrafting.ts:46-88` and `connectorActionFields()` (line 486-628).
2. Replace flat `formField` calls with cascading equivalents and (where applicable) `subActions`.
3. Register option providers in `connectorOptionProviders.ts` per its discovery tools.
4. Add an integration test that mounts the form and verifies the cascading flow.

**Reuse pattern for every provider:**

```ts
async fetch({ fieldValues, walletAddress, cluster }) {
  const positions = walletAddress
    ? await bridgeRequest('/bridge/action/connector-read-facts', {
        method: 'POST',
        body: JSON.stringify({ connectorId: '<id>', capability: 'positions', walletAddress }),
      }).catch(() => null)
    : null;
  const all = await bridgeRequest('/bridge/action/connector-read-facts', {
    method: 'POST',
    body: JSON.stringify({ connectorId: '<id>', capability: 'markets' }),
  });
  return mergeAndLabel(positions, all);
}
```

### 1.1 Kamino

- **Actions**: deposit, withdraw, earnings-proof
- **Identifier param**: `reserveMint` (replaces existing `token` flat field)
- **Discovery tools**: `solana_kamino_reserve_snapshot` (full reserve list), `solana_kamino_get_positions` (user's supplied reserves)
- **Provider id**: `kamino.reserve` — TTL 60s; positions first
- **Sub-actions**: none (single deposit verb)
- **Label format**: `"<symbol> reserve"`, detail `"Supply APY x.x% · TVL $x.xM · Your supply <bal>"`

### 1.2 Marginfi

- **Actions**: deposit, withdraw, borrow, repay
- **Identifier params**: `bankAddress` (or `bankMint`)
- **Discovery tools**: `solana_marginfi_bank_snapshot`, `solana_marginfi_wallet_accounts`, `solana_marginfi_account_detail`
- **Provider id**: `marginfi.bank` (TTL 60s, positions first)
- **Sub-actions**: none, but add optional `marginfiAccount` cascading-select (dependsOn `bankAddress`) for users with multiple accounts; provider id `marginfi.account`
- **Health preview**: surface `solana_marginfi_health_preview` result inline as the option `detail` for borrow/repay actions

### 1.3 Save (Solend)

- **Actions**: deposit, withdraw, borrow, repay
- **Identifier params**: `reserveMint` (required), `marketAddress` (optional; defaults to main market)
- **Discovery tools**: `solana_save_reserve_snapshot`, `solana_save_wallet_obligation`, `solana_save_market_snapshot`
- **Provider ids**: `save.reserve` (TTL 60s), `save.market` (TTL 10m, static)
- **Sub-actions**: none
- **Show market field**: only via `showWhen` if the user has obligations in multiple markets

### 1.4 Drift

- **Actions**: vault-deposit, request-withdraw, cancel-withdraw, complete-withdraw
- **Identifier params**: `vaultAddress` (required), `shares` or `amount` (+ `withdrawUnit`) for request-withdraw
- **Discovery tools**: `solana_drift_vault_snapshot`, `solana_drift_wallet_vault_positions`, `solana_drift_withdraw_status`
- **Provider id**: `drift.vault` (TTL 60s, positions first)
- **Sub-actions for withdraw flow**: combine request/cancel/complete into one connector action `vault-withdraw-step` with `subActions: ['request', 'cancel', 'complete']`. Each branch gates the correct fields (e.g. `shares` only for request).

### 1.5 Marinade

- **Actions**: liquid_stake, liquid_unstake, delayed_unstake, claim_delayed_unstake
- **Identifier params**: none for single-pool ops (`solAmount` or `msolAmount` only); `ticketAccount` for claim
- **Discovery tools**: `solana_marinade_state_snapshot` (rate), `solana_marinade_wallet_positions`, `solana_marinade_unstake_tickets`
- **Provider id**: `marinade.ticket` (claim only; lists outstanding tickets)
- **Sub-actions**: combine liquid/delayed unstake under one "Unstake" action with `subActions: ['liquid', 'delayed']` — picking delayed adds a "May take 1–2 epochs" note in the field hint.

### 1.6 Jito

- **Actions**: stake_sol, deposit_stake_account, unstake_jitosol, withdraw_sol, claim_deposit_receipt
- **Identifier params**: `stakeAccount` for deposit/withdraw, `receiptAddress` for claim, `withdrawMode` enum for unstake
- **Discovery tools**: `solana_jito_stake_pool_snapshot`, `solana_jito_wallet_positions`, `solana_jito_wallet_stake_accounts`, `solana_jito_deposit_receipts`
- **Provider ids**: `jito.stakeAccount` (deposit), `jito.receipt` (claim — show only claimable receipts past cooldown)
- **Sub-actions for unstake**: `subActions: ['stake_account_route', 'reserve_sol_route']` setting `withdrawMode`

### 1.7 Sanctum

- **Actions**: swap_lst, stake_sol_to_lst, unstake_lst_to_sol, add_infinity_liquidity, remove_infinity_liquidity
- **Identifier params**: `lstMint` for single-direction ops, `inputMint`+`outputMint` for swap
- **Discovery tools**: `solana_sanctum_lst_list`, `solana_sanctum_lst_snapshot`, `solana_sanctum_infinity_pool_snapshot`, `solana_sanctum_wallet_positions`
- **Provider id**: `sanctum.lst` (TTL 5m — list of LSTs is fairly static)
- **Sub-actions for swap**: `inputMint` + `outputMint` are both cascading-select sharing `sanctum.lst` provider; `outputMint` gets `showWhen` to exclude the chosen input.

### 1.8 Meteora (DLMM)

- **Actions**: add_liquidity, remove_liquidity, claim_fees, claim_rewards, close_position
- **Identifier params**: `poolAddress` (required), `positionAddress` (optional for add; required for remove/close)
- **Discovery tools**: `solana_meteora_dlmm_pool_snapshot`, `solana_meteora_wallet_positions`, `solana_meteora_position_detail`
- **Provider ids**: `meteora.pool` (TTL 60s), `meteora.position` (dependsOn `poolAddress`)
- **Sub-actions**: none, but for add_liquidity surface a `mode` sub-action: `subActions: ['new_position', 'add_to_existing']`. New position requires `lowerBinId`/`upperBinId`; existing requires `positionAddress`.

### 1.9 Orca (Whirlpools)

- **Actions**: increase_liquidity, decrease_liquidity, collect_fees, collect_rewards
- **Identifier params**: `whirlpoolAddress`, `positionMint` (required for decrease/collect)
- **Discovery tools**: `solana_orca_whirlpool_snapshot`, `solana_orca_wallet_positions`, `solana_orca_position_detail`
- **Provider ids**: `orca.whirlpool` (TTL 60s), `orca.position` (dependsOn `whirlpoolAddress`)
- **Sub-actions for increase**: `subActions: ['new_position', 'add_to_existing']`. New requires `lowerTick`/`upperTick`.

### 1.10 Raydium

- **Actions**: add_liquidity, remove_liquidity, collect_fees (CLMM only), farm_stake, farm_unstake, harvest
- **Identifier params**: `poolId` (required), `positionMint` (CLMM only), `farmId` for farm actions
- **Discovery tools**: `solana_raydium_pool_snapshot`, `solana_raydium_wallet_positions`, `solana_raydium_position_detail`
- **Provider ids**: `raydium.cpmm.pool`, `raydium.clmm.pool`, `raydium.position` (CLMM, dependsOn `poolId`), `raydium.farm`
- **Sub-actions for add/remove liquidity**: `subActions: ['cpmm', 'clmm']`. CLMM branch adds `positionMint` cascading-select + range fields; CPMM is simple. This addresses your "deposit – liquidity and deposit – earn" ask directly.

### 1.11 Lulo

- **Actions**: deposit, withdraw, complete_withdraw
- **Identifier params**: `mintAddress` (required), `depositType` or `withdrawType` (enum), `withdrawalId` for complete
- **Discovery tools**: `solana_lulo_rates`, `solana_lulo_pool_meta`, `solana_lulo_wallet_balances`
- **Provider id**: `lulo.mint` (TTL 60s — include all three tier APYs in option detail)
- **Sub-actions for deposit**: `subActions: ['protected', 'boost', 'regular']` (sets `depositType`). Each shows tier-specific APY in the option detail. For withdraw: `subActions: ['protected', 'regular']`.

### 1.12 Jupiter Lend Earn

- **Actions**: deposit, withdraw, mint, redeem
- **Identifier params**: `assetMint` (required)
- **Discovery tools**: `solana_jupiter_lend_earn_tokens`, `solana_jupiter_lend_earn_positions`, `solana_jupiter_lend_earn_token_detail`
- **Provider id**: `jupiter.lend.earn.asset` (TTL 60s)
- **Sub-actions**: none

### 1.13 Jupiter Lend Borrow

- **Actions**: create_position, deposit_collateral, borrow, repay, withdraw_collateral
- **Identifier params**: `vaultId` (required), `positionId` (required for ops other than create)
- **Discovery tools**: `solana_jupiter_lend_borrow_vaults`, `solana_jupiter_lend_borrow_positions`, `solana_jupiter_lend_borrow_vault_detail`, `solana_jupiter_lend_borrow_health_preview`
- **Provider ids**: `jupiter.lend.borrow.vault`, `jupiter.lend.borrow.position` (dependsOn `vaultId`)
- **Sub-actions**: none

### 1.14 Jupiter Lend unified entry (deposit-earn vs deposit-liquidity bifurcation)

This is the key bifurcation you flagged. Add a new connector action form `jupiter:lend` with sub-actions branching Earn vs Borrow:

```ts
{
  id: 'jupiter-lend-flow',
  connectorId: 'jupiter',
  operationLabel: 'Lend',
  templateId: 'connector-jupiter-lend',
  subActions: {
    fieldId: 'subAction',
    label: 'Lend type',
    options: [
      { id: 'earn-deposit',  actionType: 'jupiter_lend_earn_deposit',  fields: [...] },
      { id: 'earn-withdraw', actionType: 'jupiter_lend_earn_withdraw', fields: [...] },
      { id: 'borrow-create', actionType: 'jupiter_lend_borrow_create_position', fields: [...] },
      { id: 'borrow-collateral', actionType: 'jupiter_lend_borrow_deposit_collateral', fields: [...] },
      { id: 'borrow-borrow', actionType: 'jupiter_lend_borrow_borrow', fields: [...] },
      { id: 'borrow-repay',  actionType: 'jupiter_lend_borrow_repay',  fields: [...] },
    ],
  },
}
```

This gives users one Jupiter Lend entry point with clear branching, instead of nine separate template rows.

### 1.15 Magic Eden

- **Actions**: bid, buy, cancel_bid, cancel_listing, list
- **Identifier params**: `mintAddress` (NFT), `collectionId`/`collectionSymbol` for collection bids, `listingId` for cancels
- **Discovery tools**: `solana_magiceden_wallet_nfts`, `solana_magiceden_collection_snapshot`, `solana_magiceden_collection_listings`, `solana_magiceden_collection_bids`, `solana_magiceden_nft_detail`
- **Provider ids**: `magiceden.wallet.nft` (user's NFTs for list/cancel), `magiceden.collection` (for bid), `magiceden.listing` (dependsOn `collectionId`)
- **Sub-actions**: bid splits into `subActions: ['nft', 'collection']`

### 1.16 Tensor

- **Actions**: bid, buy, cancel_bid, cancel_listing, list, sweep
- **Identifier params**: same shape as Magic Eden
- **Discovery tools**: `solana_tensor_wallet_nfts`, `solana_tensor_wallet_marketplace_exposure`, `solana_tensor_collection_snapshot`, `solana_tensor_collection_listings`, `solana_tensor_collection_bids`, `solana_tensor_nft_detail`, `solana_tensor_recent_sales`
- **Provider ids**: mirror Magic Eden
- **Sub-actions**: bid → `['nft', 'collection']`; sweep gets a `count` field after `collectionId`

### 1.17 Squads (Multisig)

- **Actions**: approve_proposal, reject_proposal, cancel_proposal, execute_proposal, create_transfer_proposal
- **Identifier params**: `multisigAddress` (always), `proposalAddress` (for non-create), `vaultIndex` (for create transfer)
- **Discovery tools**: `solana_squads_multisig_snapshot`, `solana_squads_wallet_authority`, `solana_squads_proposal_list`, `solana_squads_proposal_snapshot`, `solana_squads_vault_snapshot`
- **Provider ids**: `squads.multisig` (wallet's multisigs), `squads.proposal` (dependsOn `multisigAddress`), `squads.vault` (dependsOn `multisigAddress`)
- **Sub-actions**: none — separate connector action per verb

### 1.18 Realms (SPL Governance)

- **Actions**: cast_vote, deposit_governance_tokens, withdraw_governance_tokens, relinquish_vote
- **Identifier params**: `realmAddress`, `governingTokenMint` (community vs council), `proposalAddress` (for vote/relinquish)
- **Discovery tools**: `solana_realms_realm_snapshot`, `solana_realms_wallet_governance`, `solana_realms_proposal_list`, `solana_realms_proposal_snapshot`, `solana_realms_vote_record`, `solana_realms_governance_snapshot`
- **Provider ids**: `realms.realm` (wallet's realms), `realms.token` (dependsOn `realmAddress`), `realms.proposal` (dependsOn `realmAddress`)
- **Sub-actions for vote**: `subActions: ['yes', 'no', 'abstain']`

### 1.19 Wormhole

- **Actions**: transfer, recover_or_resume, redeem
- **Identifier params**: `sourceMint`, `destinationChain`, `destinationAddress`, `transferId`/`vaa` for redeem
- **Discovery tools**: `solana_wormhole_supported_routes`, `solana_wormhole_token_snapshot`, `solana_wormhole_wallet_bridge_exposure`, `solana_wormhole_transfer_status`
- **Provider ids**: `wormhole.token` (sourceMint), `wormhole.destination` (dependsOn `sourceMint` — uses `supported_routes`)
- **Sub-actions**: none

### 1.20 Pyth

- **Actions**: post_price_update
- **Identifier params**: `priceFeedIds` (array, max 2)
- **Discovery tools**: `solana_pyth_feed_search`, `solana_pyth_price_feed`, `solana_pyth_oracle_evidence`
- **Provider id**: `pyth.feed` (search-as-you-type; cascading-select with `dependsOn: []` and a query input)
- **Sub-actions**: none

---

## Phase 2 — Blink classification taxonomy

### 2.1 Taxonomy

**New file: `packages/mcp-server/src/blinkClassification.ts`** (~80 LOC)

```ts
export type BlinkClassificationCategory =
  | 'safe_claim'
  | 'safe_governance_vote'
  | 'safe_donation_or_tip'
  | 'lp_position_management'
  | 'nft_marketplace'
  | 'mint_or_buy'
  | 'disguised_transfer'
  | 'token_account_drain'
  | 'unknown_program_interaction'
  | 'unparseable';

export type BlinkDefaultVerdict = 'approve' | 'needs_input' | 'deny';

export interface BlinkClassificationProfile {
  category: BlinkClassificationCategory;
  defaultVerdict: BlinkDefaultVerdict;
  evidenceSlots: string[];  // additional DeterministicFactKey items
  label: string;            // plain-English label
  rationale: string;        // 1-sentence user-facing explanation
}

export const BLINK_CLASSIFICATION_PROFILES: Record<BlinkClassificationCategory, BlinkClassificationProfile>;
```

Mapping table:

| Category | Default verdict | Extra evidence | Label |
|---|---|---|---|
| safe_claim | approve | protocolConnector, simulation | Claim rewards |
| safe_governance_vote | approve | protocolConnector, simulation | Governance vote |
| safe_donation_or_tip | approve | recipient, tokenMint | Tip or donation |
| lp_position_management | approve | protocolConnector, limits | LP position change |
| nft_marketplace | approve | protocolConnector, limits | NFT marketplace action |
| mint_or_buy | approve | protocolConnector, limits | Mint or buy |
| disguised_transfer | deny | recipient, tokenMint | Disguised transfer |
| token_account_drain | deny | tokenMint | Token account drain |
| unknown_program_interaction | needs_input | protocolConnector | Unknown program |
| unparseable | needs_input | blinkAction | Unparseable Blink |

### 2.2 Reviewer prompt

**File: `packages/mcp-server/src/aiPlanner.ts`** — extend `aiReviewMessages()` around line 1100.

When `request.plan.actionType === 'blink_action'` AND `mode === 'multi'`, append a fifth reviewer role:

```ts
const blinkSystem = request.plan?.actionType === 'blink_action' && multi
  ? ' Add a fifth reviewer with role "blink_classifier". It classifies the Blink before risk votes. Pick exactly one category: safe_claim, safe_governance_vote, safe_donation_or_tip, lp_position_management, nft_marketplace, mint_or_buy, disguised_transfer, token_account_drain, unknown_program_interaction, unparseable. Use simulation results (programs invoked, accounts written, lamport/SPL deltas), the Blink host domain, the connector capability registry, and user intent. A Blink is a disguised_transfer when net value leaves the wallet to an address unrelated to the named protocol. It is a token_account_drain when the simulation closes an SPL account or moves the entire balance of a mint. It is unknown_program_interaction when invoked program IDs do not appear in the connector registry or a published action spec. If the action URL or simulation cannot be parsed, return unparseable. The risk reviewer must consume this classification and deny on disguised_transfer or token_account_drain, return needs_input on unknown_program_interaction or unparseable, approve safe_* categories absent other red flags. Record the chosen category in evidence.blinkClassification = {category, confidence, rationale, redFlags}.'
  : '';
```

Concatenate into the system message: `baseSystem + multiSystem + blinkSystem + researchSystem`.

Post-parse validation in `aiReviewFromParsed` (around line 1277): if returned `blinkClassification.category` isn't in the enum, snap to `unparseable`. Look up `BLINK_CLASSIFICATION_PROFILES[category]` to enforce the default verdict floor on the top-level decision.

### 2.3 Findings spec extension

**File: `apps/browser-demo/src/agentFindingsSpec.ts`**

Extend `DeterministicFactKey` (line 1-13):
```ts
export type DeterministicFactKey =
  | 'research' | 'route' | 'quote' | 'protocol' | 'protocolConnector'
  | 'blinkAction' | 'simulation' | 'tokenMint' | 'recipient' | 'policy'
  | 'limits' | 'schedule'
  | 'blinkClassification';  // NEW
```

Update `blink_action` spec (line 121):
```ts
blink_action: {
  slots: ['blinkClassification', 'protocolConnector', 'blinkAction', 'simulation'],
},
```

At render time in `agentReviewPresentation.ts:168` (`reviewEvidenceRows`), if `facts.blinkClassification.message` resolves to a category with `evidenceSlots`, splice those slots into the row order.

Update the label map in `agentReviewPresentation.ts:207-220`:
```ts
blinkClassification: 'Blink type',
```

### 2.4 Simulation enrichment

`solana_prepare_blink_action` handler (`packages/mcp-server/src/actionService.ts:2054-2110`) today only captures `transactionBase64`. Add a simulate-and-extract step that pulls:
- invoked program IDs (deduped)
- account-close events (SPL token program `closeAccount`)
- lamport delta per account (net outflows from the user's wallet)
- SPL token delta per (account, mint) pair

Store under `prepared.simulationSummary` and forward into the reviewer context. Without this the classifier prompt has too little to work with — this is the highest-risk dependency of Phase 2.

### 2.5 Tests

- `packages/mcp-server/src/__tests__/blinkClassification.test.ts` — golden fixture per category running through `aiReviewFromParsed` with mocked LLM payloads.
- `apps/browser-demo/src/__tests__/agentFindingsSpec.test.ts` — snapshot the new `blink_action` slot order and category-specific extra slots.

---

## Phase 3 — Recurring connector plans

### 3.1 Persistence schema

**File: `packages/mcp-server/src/preparedActions.ts`** — extend `RecurringPayment` (line 144-172):

```ts
export interface RecurringPayment {
  // ...existing
  actionKind?: 'transfer' | 'swap' | 'connector' | 'blink';
  connectorActionTemplate?: {
    connectorId: string;            // 'kamino', 'jupiter', ...
    actionType: string;             // 'kamino_deposit', 'jupiter_lend_earn_deposit', ...
    subActionId?: string;           // 'earn' | 'borrow' | 'cpmm' | 'clmm' | ...
    params: Record<string, string>; // {reserveMint, amount, memo, ...}
    blinkUrl?: string;              // only when actionKind === 'blink'
  };
}
```

Mirror on `RecurringPaymentInput` in `actionService.ts:384-406`.

### 3.2 Materialization

`materializeDueRecurring()` in `preparedActions.ts:398-463` — replace the binary `isSwap` branch (line 423) with:

```ts
switch (payment.actionKind ?? (payment.isSwap ? 'swap' : 'transfer')) {
  case 'connector':
    return emitConnectorActionOccurrence(payment);
  case 'blink':
    return emitBlinkOccurrence(payment);
  case 'swap':
    return emitSwapOccurrence(payment);   // existing logic
  default:
    return emitTransferOccurrence(payment); // existing logic
}
```

**Crucially**: the emitted prepared action has `state: 'pending_prepare'` not `'ready'`. The agent re-invokes the corresponding `prepare_<protocol>_<op>` MCP tool with `connectorActionTemplate.params` on each occurrence. This re-quotes, re-checks health, and uses fresh on-chain state. We never freeze stale tx bytes.

**Fail-closed**: each `prepare<X>` handler must throw `ProtocolError('invalid_request', ...)` when the reserve/vault from `params` no longer exists. The store marks the materialized action `failed` with `txError` set; the recurring view shows "Last occurrence failed: <reason>". After N consecutive failures (config default 3), auto-pause the recurring entry.

### 3.3 Bridge + MCP plumbing

- Update bridge recurring routes in `packages/mcp-server/src/bridgeServer.ts:272-352` and `buildRecurringPaymentInput()` around line 1304 to pass through `actionKind` + `connectorActionTemplate`.
- Update `solana_create_recurring_payment` tool input schema in `packages/mcp-server/src/actionTools.ts:4232-4244` to accept the new shape.
- Update validation in `buildRecurringPaymentInput()` (actionService.ts:5176): when `actionKind === 'connector'`, validate connector is enabled and registered; when `'blink'`, validate host allowlist (see Phase 4).
- `enforceRecurringPolicy` continues to check token + amount derived from `connectorActionTemplate.params`.

### 3.4 UI wiring

`apps/browser-demo/src/main.ts` recurring submit (around line 20248 `recurringDraftToAgentPlan`):

```ts
if (state.recurringDraft.connectorOperationId) {
  submitInput.actionKind = 'connector';
  submitInput.connectorActionTemplate = {
    connectorId: form.connectorId,
    actionType: connectorActionFormTemplateActionType(form, draft),
    subActionId: draft.subAction,
    params: extractParamsFromTemplateFields(form, draft),
  };
}
```

Recurring view (`recurringPaymentRow` rendering) shows the connector template summary instead of recipient — plain-English label like "Kamino deposit USDC 50.00 weekly".

### 3.5 Tests

- `packages/mcp-server/src/__tests__/recurringConnectorMaterialize.test.ts` — schedule a Kamino-deposit recurring, materialize, verify a `pending_prepare` action with the right params; simulate a missing reserve and verify the auto-pause path after 3 failures.
- `apps/browser-demo/src/__tests__/recurringConnectorComposer.test.ts` — recurring composer renders cascading dropdowns for Kamino.

---

## Phase 4 — Recurring Blink policy

### 4.1 Cadence floor

Recurring Blinks require `cadence >= 1 day`. Reject sub-daily cadences in `buildRecurringPaymentInput()` when `actionKind === 'blink'`.

### 4.2 Host allowlist

User-supplied (per-wallet config) allowlist of Blink hosts. Stored in cloud session config (existing `/api/session` infrastructure). Default-empty: a user must explicitly add a host before scheduling a recurring Blink. Per project memory, allowlist is a user feature, not backend enforcement — so this is a recurring-only constraint, not a general Blink restriction.

UI: Settings tab → "Recurring Blink hosts" → add/remove rows.

### 4.3 Initial classification gate

On `solana_create_recurring_payment` with `actionKind === 'blink'`: run a one-time classification at create time. Allow categories: `safe_claim`, `safe_governance_vote`, `safe_donation_or_tip`, `lp_position_management`. Reject `disguised_transfer`, `token_account_drain`, `unparseable`. For `unknown_program_interaction`, allow creation but auto-pause and require manual confirmation on first occurrence.

### 4.4 Per-occurrence reclassification

Each occurrence's freshly fetched tx bytes go through the classifier again. If category drops to a deny tier, **auto-pause** the recurring payment, mark the occurrence `denied`, emit notification ("Recurring Blink paused: classification changed to <category>"). Never auto-cancel — user must explicitly delete.

If category drops to `needs_input`, mark occurrence `needs_input`, keep recurring active.

### 4.5 Documentation

Add a section "Recurring Blink policy" to `RECURRING_PLANS_PRODUCTION_PLAN.md` at the repo root (already exists per git status). Keep it concise — bullet the four rules above.

### 4.6 Tests

- `packages/mcp-server/src/__tests__/recurringBlinkPolicy.test.ts` — create with each category and verify accept/reject; simulate mid-flight reclassification drift; verify auto-pause.

---

## Phase 5 — Integration verification

### Manual smoke (must pass before declaring done)

1. **Kamino cascading flow**: open Create Plan → pick "Connector action" → Kamino → Deposit → cascading-select shows your positions first, then all reserves. Pick USDC reserve, enter 10, send to approval. Verify the prepared action has `reserveMint` set.
2. **Jupiter Lend bifurcation**: Create Plan → Jupiter Lend → sub-action chips show "Earn (single-asset pool)" vs "Borrow against collateral". Pick Earn → asset dropdown populates. Pick Borrow → vault dropdown populates, position appears after vault chosen.
3. **Raydium CPMM/CLMM**: Create Plan → Raydium → Add liquidity → sub-action chips CPMM vs CLMM. CLMM branch requires `positionMint` + tick range; CPMM doesn't.
4. **Lulo tiers**: Create Plan → Lulo → Deposit → tier chips (protected/boost/regular) show distinct APYs in the field detail.
5. **Manual fallback**: disable network, retry Kamino flow, verify free-text input appears with "Couldn't load options; paste address" hint.
6. **Blink classifier**: prepare a known-safe Blink (e.g. a claim-rewards URL from a registered connector); verify multi-reviewer output includes `blink_classifier` reviewer with `safe_claim`. Then prepare a Blink whose simulation closes a token account; verify classifier returns `token_account_drain` and decision is `deny`.
7. **Recurring Kamino deposit**: schedule a weekly Kamino USDC deposit; force-advance time, verify a `pending_prepare` action materializes, re-prepare runs successfully, wallet approval works.
8. **Recurring Blink reclassification**: schedule a daily Blink categorized `safe_claim`; manually swap the response to a `disguised_transfer` shape; verify auto-pause + notification.

### Automated coverage

- Unit tests per phase listed in each section above.
- E2E test in `apps/browser-demo/src/__tests__/connectorCreatePlanFlow.test.ts` mounting Kamino + Jupiter Lend + Raydium flows.

---

## Critical files

**Phase 0 (shared):**
- `packages/workflow/src/agentPlans.ts` — schema types
- `apps/browser-demo/src/connectorDrafting.ts` — `ConnectorActionForm`, `ConnectorSubAction`, `effectiveFormFields`
- `apps/browser-demo/src/connectorOptionProviders.ts` — NEW
- `apps/browser-demo/src/main.ts` — `templateFieldInput`, `connectorOperationFieldInput`, cascading select rendering, option cache state

**Phase 1 (per-connector):**
- `apps/browser-demo/src/connectorDrafting.ts` — `CONNECTOR_ACTION_FORMS` (line 46-88) and `connectorActionFields()` (line 486-628)
- `apps/browser-demo/src/connectorOptionProviders.ts` — register one provider per connector identifier

**Phase 2 (Blink classifier):**
- `packages/mcp-server/src/blinkClassification.ts` — NEW
- `packages/mcp-server/src/aiPlanner.ts:1100-1141` — reviewer prompt extension
- `packages/mcp-server/src/actionService.ts:2054-2110` — simulation enrichment
- `apps/browser-demo/src/agentFindingsSpec.ts` — `blinkClassification` slot
- `apps/browser-demo/src/agentReviewPresentation.ts:52-55, 207-220` — evidence union + labels

**Phase 3 (recurring connector):**
- `packages/mcp-server/src/preparedActions.ts:144-172, 398-463` — schema + materialization
- `packages/mcp-server/src/actionService.ts:384-406, 5176` — input + validation
- `packages/mcp-server/src/bridgeServer.ts:272-352, 1304` — bridge routes
- `packages/mcp-server/src/actionTools.ts:4232-4244` — MCP tool schema
- `apps/browser-demo/src/main.ts` — recurring composer + submit + view rendering

**Phase 4 (recurring Blink):**
- `packages/mcp-server/src/actionService.ts` — cadence floor + classification gate
- Session config (existing `/api/session`) — host allowlist storage
- `RECURRING_PLANS_PRODUCTION_PLAN.md` — policy doc

---

## Risks and open questions

1. **Kamino reserve discovery scale** — historically ~200 reserves; in practice ~20-30 active per cluster. Provider must paginate gracefully and surface user's positions first to keep the dropdown usable.
2. **MCP rate limits** — per-cluster, per-wallet caching with 60s/5m TTLs. Force-refresh on focus when stale; debounce dependency changes by 200ms to avoid thrash during typing.
3. **AGENT_PLAN_TEMPLATES blast radius** — many call sites iterate `template.fields` directly (`planner.ts:415`, `agentPlans.ts:526` in workflow). All consumers must switch to `effectiveFormFields()` or sub-action params will silently drop.
4. **Plain-English label discipline** — provider mappers must return user-facing labels like "USDC reserve" / "USDC-SOL DLMM pool · 1bps bin", not raw mints or program names. Centralize in mapper helpers and verify in the receipt-language test.
5. **Recurring connector parametric drift** — pool TVL/APY/status changes between create and occurrence. Per-occurrence dry-run preview during `materializeDueRecurring()` catches missing pools; consecutive-failure auto-pause handles flapping.
6. **Blink simulation coverage** — classifier quality is bounded by `simulationSummary` quality. If simulation only captures program IDs (not SPL deltas), the classifier can't distinguish disguised_transfer from safe_claim reliably. Phase 2.4 is the highest-risk dependency.
7. **Out of scope**: ML-based classifier; on-chain heuristic-only fallback when LLM unavailable (degrade to manual-review instead); NFT-specific Blinks beyond the existing nft_marketplace category.

---

## Implementation handoff

When this plan is approved:

1. Copy this file to `/Users/devlegacy/Desktop/projects/solana-agent-wallet-adapter/CONNECTOR_GRANULARITY_PLAN.md` so subagents working from worktrees can `Read` it.
2. Implement Phase 0 (single agent, sequential) — schema, registry, UI scaffolding, tests. Land this PR before starting Phase 1.
3. Spawn parallel agents per Phase 1 connector (one each for Kamino, Marginfi, Save, Drift, Marinade, Jito, Sanctum, Meteora, Orca, Raydium, Lulo, Jupiter Lend Earn, Jupiter Lend Borrow, Magic Eden, Tensor, Squads, Realms, Wormhole, Pyth). Each agent reads its section here, implements the cascading form + provider, ships a focused PR.
4. Parallel to Phase 1: one agent on Phase 2 (Blink classifier).
5. After Phase 1 lands: one agent on Phase 3 (recurring connector).
6. After Phases 2 + 3 land: one agent on Phase 4 (recurring Blink policy).
7. Final agent does Phase 5 integration smoke.
