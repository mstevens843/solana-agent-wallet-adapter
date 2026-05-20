/**
 * Phoenix Perpetuals adapter (Ellipsis Labs).
 *
 * Ships:
 *  - 6 read tools (`market_snapshot`, `market_catalog`, `position_snapshot`, `wallet_positions`,
 *    `funding_history`, `health_preview`).
 *  - 5 policy-gated write actions (`open`, `close`, `modify_collateral`, `place_trigger`, `cancel_order`) backed by
 *    `@ellipsis-labs/rise@0.4.9`. Policy enforcement (`PhoenixPerpsPolicyConfig`: max leverage, paper-mode-only,
 *    allowed symbols, max notional, …) gates both prepare AND execute paths.
 *
 * Client resolution: `resolvePhoenixClient(ctx)` returns a Rise-backed `PhoenixClient` when a Phoenix access code is
 * configured (per-wallet via `ctx.connectorSecrets.phoenix.apiKey` or process-wide via `PHOENIX_ACCESS_CODE`).
 * Setting `PHOENIX_USE_LEGACY_HTTP=true` swaps to the hand-rolled HTTP client — reads-only, no write support.
 *
 * Auth model: the user pastes a Phoenix invite/activation code in Preferences → Agents & Connectors. The adapter
 * calls `POST /v1/invite/activate` lazily on the first authority-scoped read or write. The activation is cached per
 * (process, authority).
 *
 * Tick prices: Phoenix stop-loss triggers are tick-based, not USD. Conversion lives in `sharedMath.ts`
 * (`usdToTickPrice`).
 *
 * Execute-time safety: every write action's `execute()` re-checks (1) the connected wallet matches the prepared
 * action, (2) the stored `mode` still satisfies policy, (3) for `phoenix_close`, the current position still exists
 * and uses fresh size from on-chain state.
 *
 * See `actions.ts:assertPhoenixPolicyAllowed` for the policy surface, `healthPreview.ts:previewHealth` for the
 * combined-position math, and `riseClient.ts` + `instructionBridge.ts` for the SDK plumbing.
 */
import type { AdapterRead, DAppAdapter } from '../types.js';
import {
  PHOENIX_ADAPTER_ID,
  PHOENIX_DESCRIPTION,
  PHOENIX_NAME,
  PHOENIX_PERPS_PROGRAM_IDS,
  PHOENIX_SUPPORTED_CLUSTERS,
  PHOENIX_WEBSITE,
} from './constants.js';
import {
  getMarketCatalog,
  getMarketSnapshot,
  type GetPhoenixMarketSnapshotInput,
  type PhoenixMarketCatalogResult,
} from './markets.js';
import {
  getPositionSnapshot,
  getWalletPositions,
  type GetPhoenixPositionSnapshotInput,
  type GetPhoenixWalletPositionsInput,
  type PhoenixPositionSnapshotResult,
  type PhoenixWalletPositionsResult,
} from './positions.js';
import {
  getFundingHistory,
  type GetPhoenixFundingHistoryInput,
  type PhoenixFundingHistoryResult,
} from './funding.js';
import {
  previewHealth,
  type PhoenixHealthPreviewInput,
  type PhoenixHealthPreviewResult,
} from './healthPreview.js';
import {
  phoenixCancelOrderAction,
  phoenixCloseAction,
  phoenixModifyCollateralAction,
  phoenixOpenAction,
  phoenixPlaceTriggerAction,
  type PhoenixCancelOrderInput,
  type PhoenixCloseInput,
  type PhoenixModifyCollateralInput,
  type PhoenixOpenInput,
  type PhoenixPlaceTriggerInput,
} from './actions.js';

const marketSnapshotRead: AdapterRead<GetPhoenixMarketSnapshotInput, unknown> = {
  id: 'market_snapshot',
  async read(input, ctx) {
    return getMarketSnapshot(ctx, input);
  },
};

const marketCatalogRead: AdapterRead<Record<string, never>, PhoenixMarketCatalogResult> = {
  id: 'market_catalog',
  async read(_input, ctx) {
    return getMarketCatalog(ctx);
  },
};

const positionSnapshotRead: AdapterRead<GetPhoenixPositionSnapshotInput, PhoenixPositionSnapshotResult> = {
  id: 'position_snapshot',
  async read(input, ctx) {
    return getPositionSnapshot(ctx, input);
  },
};

const walletPositionsRead: AdapterRead<GetPhoenixWalletPositionsInput, PhoenixWalletPositionsResult> = {
  id: 'wallet_positions',
  async read(input, ctx) {
    return getWalletPositions(ctx, input);
  },
};

const fundingHistoryRead: AdapterRead<GetPhoenixFundingHistoryInput, PhoenixFundingHistoryResult> = {
  id: 'funding_history',
  async read(input, ctx) {
    return getFundingHistory(ctx, input);
  },
};

const healthPreviewRead: AdapterRead<PhoenixHealthPreviewInput, PhoenixHealthPreviewResult> = {
  id: 'health_preview',
  async read(input, ctx) {
    return previewHealth(ctx, input);
  },
};

export const phoenixAdapter: DAppAdapter = {
  id: PHOENIX_ADAPTER_ID,
  name: PHOENIX_NAME,
  website: PHOENIX_WEBSITE,
  description: PHOENIX_DESCRIPTION,
  supportedClusters: PHOENIX_SUPPORTED_CLUSTERS,
  programIds: PHOENIX_PERPS_PROGRAM_IDS,
  actions: {
    open: phoenixOpenAction,
    close: phoenixCloseAction,
    modify_collateral: phoenixModifyCollateralAction,
    place_trigger: phoenixPlaceTriggerAction,
    cancel_order: phoenixCancelOrderAction,
  },
  reads: {
    market_snapshot: marketSnapshotRead,
    market_catalog: marketCatalogRead,
    position_snapshot: positionSnapshotRead,
    wallet_positions: walletPositionsRead,
    funding_history: fundingHistoryRead,
    health_preview: healthPreviewRead,
  },
};

export type {
  GetPhoenixFundingHistoryInput,
  GetPhoenixMarketSnapshotInput,
  GetPhoenixPositionSnapshotInput,
  GetPhoenixWalletPositionsInput,
  PhoenixCancelOrderInput,
  PhoenixCloseInput,
  PhoenixFundingHistoryResult,
  PhoenixHealthPreviewInput,
  PhoenixHealthPreviewResult,
  PhoenixMarketCatalogResult,
  PhoenixModifyCollateralInput,
  PhoenixOpenInput,
  PhoenixPlaceTriggerInput,
  PhoenixPositionSnapshotResult,
  PhoenixWalletPositionsResult,
};
export {
  PHOENIX_ADAPTER_ID,
  PHOENIX_NAME,
  PHOENIX_WEBSITE,
  PHOENIX_DESCRIPTION,
  PHOENIX_SUPPORTED_CLUSTERS,
};
