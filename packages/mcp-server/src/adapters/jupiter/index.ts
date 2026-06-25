import type { AdapterRead, DAppAdapter } from '../types.js';

import {
  JUPITER_ADAPTER_ID,
  JUPITER_DESCRIPTION,
  JUPITER_LEND_PROGRAM_IDS,
  JUPITER_NAME,
  JUPITER_SUPPORTED_CLUSTERS,
  JUPITER_WEBSITE,
} from './constants.js';
import {
  borrowBorrowAction,
  borrowCreatePositionAction,
  borrowDepositCollateralAction,
  borrowRepayAction,
  borrowWithdrawCollateralAction,
  earnDepositAction,
  earnMintAction,
  earnRedeemAction,
  earnWithdrawAction,
} from './lendActions.js';
import {
  getBorrowPositions,
  getBorrowVaultDetail,
  listBorrowVaults,
  previewBorrowHealth,
} from './lendBorrow.js';
import {
  getEarnEarnings,
  getEarnPositions,
  getEarnTokenDetail,
  listEarnTokens,
} from './lendEarn.js';
import {
  cancelOrderAction,
  editOrderAction,
  ocoOrderAction,
  otocoOrderAction,
  registerVaultAction,
  singleOrderAction,
  withdrawOrderFundsAction,
} from './triggerActions.js';
import {
  cancelRecurringOrderAction,
  createTimeOrderAction,
  depositPriceOrderAction,
  quoteRecurringTimeOrder,
  withdrawPriceOrderAction,
} from './recurringActions.js';
import {
  claimPositionAction as predictionClaimPositionAction,
  closePositionAction as predictionClosePositionAction,
  createOrderAction as predictionCreateOrderAction,
} from './predictionActions.js';
import {
  readAuthStatus,
  requestChallenge,
  requireTriggerEnabled,
  verifyChallenge,
  type TriggerAuthStatus,
  type TriggerChallenge,
} from './triggerAuth.js';
import {
  type JupiterTriggerChallengeType,
  type JupiterTriggerOrderState,
} from './triggerConstants.js';
import { getOrder, listOrders, orderHistory } from './triggerOrders.js';
import { readVault } from './triggerVault.js';
import {
  getRecurringOrder,
  listRecurringOrders,
  type JupiterRecurringOrderState,
} from './recurringOrders.js';

const earnTokensRead: AdapterRead<
  { includeInactive?: boolean; assetMint?: string },
  unknown
> = {
  id: 'earn_tokens',
  async read(input, ctx) {
    const walletAddress = await ctx.backend.getAddress();
    return {
      cluster: ctx.config.cluster,
      tokens: await listEarnTokens(ctx.config, walletAddress, input),
    };
  },
};

const earnTokenDetailRead: AdapterRead<{ assetMint: string }, unknown> = {
  id: 'earn_token_detail',
  async read(input, ctx) {
    const walletAddress = await ctx.backend.getAddress();
    return {
      cluster: ctx.config.cluster,
      token: await getEarnTokenDetail(ctx.config, walletAddress, input.assetMint),
    };
  },
};

const earnPositionsRead: AdapterRead<{ walletAddress?: string; assetMint?: string }, unknown> = {
  id: 'earn_positions',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      positions: await getEarnPositions(ctx.config, {
        walletAddress,
        ...(input.assetMint ? { assetMint: input.assetMint } : {}),
      }),
    };
  },
};

const earnEarningsRead: AdapterRead<
  { walletAddress?: string; assetMint?: string; from?: string; to?: string },
  unknown
> = {
  id: 'earn_earnings',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      earnings: await getEarnEarnings(ctx.config, {
        walletAddress,
        ...(input.assetMint ? { assetMint: input.assetMint } : {}),
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
      }),
    };
  },
};

const borrowVaultsRead: AdapterRead<
  {
    vaultId?: number;
    supplyMint?: string;
    borrowMint?: string;
    includeUnavailable?: boolean;
  },
  unknown
> = {
  id: 'borrow_vaults',
  async read(input, ctx) {
    const walletAddress = await ctx.backend.getAddress();
    return {
      cluster: ctx.config.cluster,
      vaults: await listBorrowVaults(ctx.config, walletAddress, input),
    };
  },
};

const borrowVaultDetailRead: AdapterRead<{ vaultId: number }, unknown> = {
  id: 'borrow_vault_detail',
  async read(input, ctx) {
    const walletAddress = await ctx.backend.getAddress();
    return {
      cluster: ctx.config.cluster,
      vault: await getBorrowVaultDetail(ctx.config, walletAddress, input.vaultId),
    };
  },
};

const borrowPositionsRead: AdapterRead<
  { walletAddress?: string; vaultId?: number; positionId?: number },
  unknown
> = {
  id: 'borrow_positions',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      positions: await getBorrowPositions(ctx.config, {
        walletAddress,
        ...(input.vaultId !== undefined ? { vaultId: input.vaultId } : {}),
        ...(input.positionId !== undefined ? { positionId: input.positionId } : {}),
      }),
    };
  },
};

const borrowHealthPreviewRead: AdapterRead<
  {
    walletAddress?: string;
    vaultId: number;
    positionId?: number;
    collateralDelta?: string;
    debtDelta?: string;
    minHealthRatio?: number;
    maxLtvBps?: number;
  },
  unknown
> = {
  id: 'borrow_health_preview',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      preview: await previewBorrowHealth(ctx.config, {
        walletAddress,
        vaultId: input.vaultId,
        ...(input.positionId !== undefined ? { positionId: input.positionId } : {}),
        ...(input.collateralDelta !== undefined ? { collateralDelta: input.collateralDelta } : {}),
        ...(input.debtDelta !== undefined ? { debtDelta: input.debtDelta } : {}),
        ...(input.minHealthRatio !== undefined ? { minHealthRatio: input.minHealthRatio } : {}),
        ...(input.maxLtvBps !== undefined ? { maxLtvBps: input.maxLtvBps } : {}),
      }),
    };
  },
};

const triggerAuthChallengeRead: AdapterRead<
  { walletAddress?: string; challengeType?: JupiterTriggerChallengeType },
  TriggerChallenge
> = {
  id: 'trigger_auth_challenge',
  async read(input, ctx) {
    requireTriggerEnabled(ctx.config);
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return requestChallenge(ctx.config, {
      walletAddress,
      challengeType: input.challengeType ?? 'message',
    });
  },
};

const triggerAuthVerifyRead: AdapterRead<
  {
    walletAddress?: string;
    challengeType: JupiterTriggerChallengeType;
    signature?: string;
    signedTransaction?: string;
  },
  TriggerAuthStatus
> = {
  id: 'trigger_auth_verify',
  async read(input, ctx) {
    requireTriggerEnabled(ctx.config);
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return verifyChallenge(ctx.config, {
      walletAddress,
      challengeType: input.challengeType,
      ...(input.signature !== undefined && { signature: input.signature }),
      ...(input.signedTransaction !== undefined && { signedTransaction: input.signedTransaction }),
    });
  },
};

const triggerAuthStatusRead: AdapterRead<{ walletAddress?: string }, TriggerAuthStatus> = {
  id: 'trigger_auth_status',
  async read(input, ctx) {
    requireTriggerEnabled(ctx.config);
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return readAuthStatus(walletAddress, ctx.config);
  },
};

const triggerVaultRead: AdapterRead<{ walletAddress?: string }, unknown> = {
  id: 'trigger_vault',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return readVault(ctx.config, { walletAddress });
  },
};

const triggerOrdersRead: AdapterRead<
  {
    walletAddress?: string;
    state?: JupiterTriggerOrderState;
    limit?: number;
    offset?: number;
  },
  unknown
> = {
  id: 'trigger_orders',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return listOrders(ctx.config, {
      walletAddress,
      ...(input.state !== undefined && { state: input.state }),
      ...(input.limit !== undefined && { limit: input.limit }),
      ...(input.offset !== undefined && { offset: input.offset }),
    });
  },
};

const triggerOrderDetailRead: AdapterRead<{ walletAddress?: string; orderId: string }, unknown> = {
  id: 'trigger_order_detail',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return getOrder(ctx.config, { walletAddress, orderId: input.orderId });
  },
};

const triggerOrderHistoryRead: AdapterRead<
  {
    walletAddress?: string;
    state?: JupiterTriggerOrderState;
    limit?: number;
    offset?: number;
  },
  unknown
> = {
  id: 'trigger_order_history',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return orderHistory(ctx.config, {
      walletAddress,
      ...(input.state !== undefined && { state: input.state }),
      ...(input.limit !== undefined && { limit: input.limit }),
      ...(input.offset !== undefined && { offset: input.offset }),
    });
  },
};

const recurringOrdersRead: AdapterRead<
  {
    walletAddress?: string;
    state?: JupiterRecurringOrderState;
    limit?: number;
    page?: number;
    inputMint?: string;
    outputMint?: string;
    recurringType?: 'time' | 'price';
    includeFailedTx?: boolean;
  },
  unknown
> = {
  id: 'recurring_orders',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return listRecurringOrders(ctx.config, {
      walletAddress,
      ...(input.state !== undefined && { state: input.state }),
      ...(input.limit !== undefined && { limit: input.limit }),
      ...(input.page !== undefined && { page: input.page }),
      ...(input.inputMint !== undefined && { inputMint: input.inputMint }),
      ...(input.outputMint !== undefined && { outputMint: input.outputMint }),
      ...(input.recurringType !== undefined && { recurringType: input.recurringType }),
      ...(input.includeFailedTx !== undefined && { includeFailedTx: input.includeFailedTx }),
    });
  },
};

const recurringOrderDetailRead: AdapterRead<{ walletAddress?: string; orderId: string; recurringType?: 'time' | 'price' }, unknown> = {
  id: 'recurring_order_detail',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return getRecurringOrder(ctx.config, {
      walletAddress,
      orderId: input.orderId,
      ...(input.recurringType !== undefined ? { recurringType: input.recurringType } : {}),
    });
  },
};

const recurringQuoteRead: AdapterRead<
  {
    inputMint: string;
    outputMint: string;
    totalAmount?: string;
    totalAmountRaw?: string;
    numberOfOrders: number;
    intervalSeconds: number;
    startAt?: string;
    minPrice?: string;
    maxPrice?: string;
  },
  unknown
> = {
  id: 'recurring_quote',
  async read(input, ctx) {
    return quoteRecurringTimeOrder(ctx.config, input);
  },
};

export const jupiterAdapter: DAppAdapter = {
  id: JUPITER_ADAPTER_ID,
  name: JUPITER_NAME,
  website: JUPITER_WEBSITE,
  description: JUPITER_DESCRIPTION,
  supportedClusters: JUPITER_SUPPORTED_CLUSTERS,
  programIds: JUPITER_LEND_PROGRAM_IDS,
  actions: {
    earn_deposit: earnDepositAction(),
    earn_withdraw: earnWithdrawAction(),
    earn_mint: earnMintAction(),
    earn_redeem: earnRedeemAction(),
    borrow_create_position: borrowCreatePositionAction(),
    borrow_deposit_collateral: borrowDepositCollateralAction(),
    borrow_borrow: borrowBorrowAction(),
    borrow_repay: borrowRepayAction(),
    borrow_withdraw_collateral: borrowWithdrawCollateralAction(),
    trigger_register_vault: registerVaultAction,
    trigger_single_order: singleOrderAction,
    trigger_oco_order: ocoOrderAction,
    trigger_otoco_order: otocoOrderAction,
    trigger_edit_order: editOrderAction,
    trigger_cancel_order: cancelOrderAction,
    trigger_withdraw_order_funds: withdrawOrderFundsAction,
    recurring_create_time_order: createTimeOrderAction,
    recurring_cancel_order: cancelRecurringOrderAction,
    recurring_deposit_price_order: depositPriceOrderAction,
    recurring_withdraw_price_order: withdrawPriceOrderAction,
    prediction_create_order: predictionCreateOrderAction,
    prediction_close_position: predictionClosePositionAction,
    prediction_claim_position: predictionClaimPositionAction,
  },
  reads: {
    earn_tokens: earnTokensRead,
    earn_token_detail: earnTokenDetailRead,
    earn_positions: earnPositionsRead,
    earn_earnings: earnEarningsRead,
    borrow_vaults: borrowVaultsRead,
    borrow_vault_detail: borrowVaultDetailRead,
    borrow_positions: borrowPositionsRead,
    borrow_health_preview: borrowHealthPreviewRead,
    trigger_auth_challenge: triggerAuthChallengeRead,
    trigger_auth_verify: triggerAuthVerifyRead,
    trigger_auth_status: triggerAuthStatusRead,
    trigger_vault: triggerVaultRead,
    trigger_orders: triggerOrdersRead,
    trigger_order_detail: triggerOrderDetailRead,
    trigger_order_history: triggerOrderHistoryRead,
    recurring_orders: recurringOrdersRead,
    recurring_order_detail: recurringOrderDetailRead,
    recurring_quote: recurringQuoteRead,
  },
};

export {
  getJupiterApiKey,
  jupiterApiHost,
  jupiterBaseUrl,
  jupiterFetchJson,
  redactJupiterSecrets,
  type JupiterProduct,
} from './client.js';
export {
  JUPITER_REFERRAL_MAX_FEE_BPS,
  JUPITER_REFERRAL_MIN_FEE_BPS,
  resolveJupiterReferral,
  type JupiterReferralParams,
} from './referral.js';
export {
  JUPITER_DOCS_INDEX_URL,
  JUPITER_ENDPOINT_CATALOG,
  listJupiterEndpointCatalog,
  requestJupiterReviewEndpoint,
  type JupiterEndpointCatalogEntry,
  type JupiterEndpointRisk,
  type JupiterReviewEndpointReadInput,
} from './endpointCatalog.js';
export {
  JUPITER_TOKEN_CATEGORIES,
  JUPITER_TOKEN_CATEGORY_INTERVALS,
  JUPITER_TOKEN_TAGS,
  assertJupiterTokenPriceEnabled,
  describeJupiterTokenPriceUnavailableReason,
  fetchJupiterPrices,
  fetchJupiterRecentTokens,
  fetchJupiterTokenCategory,
  fetchJupiterTokenSearch,
  fetchJupiterTokensByTag,
  jupiterMaxBatchPriceIds,
  jupiterMaxSearchMintIds,
  type JupiterPriceBatchInput,
  type JupiterPriceInput,
  type JupiterTokenByTagInput,
  type JupiterTokenCategory,
  type JupiterTokenCategoryInput,
  type JupiterTokenCategoryInterval,
  type JupiterTokenRecentInput,
  type JupiterTokenSearchInput,
  type JupiterTokenTag,
} from './tokenClient.js';
export {
  getJupiterRecentTokens,
  getJupiterTokenCategory,
  getJupiterTokenSearch,
  getJupiterTokensByTag,
  normalizeJupiterToken,
  normalizeJupiterTokens,
  type JupiterTokenFirstPool,
  type JupiterTokenInfo,
  type JupiterTokenReadResult,
  type JupiterTokenStats,
} from './tokens.js';
export {
  getJupiterPrice,
  getJupiterPriceBatch,
  type JupiterPriceBatchResult,
  type JupiterPriceSnapshot,
  type JupiterPriceStatus,
} from './prices.js';
export {
  buildTokenRiskEvidence,
  getJupiterTokenRiskEvidence,
  type JupiterTokenRiskEvidence,
  type JupiterTokenRiskEvidenceInput,
} from './tokenEvidence.js';
export {
  __resetJupiterLendEarnSdkCacheForTests,
  __setJupiterLendEarnSdkForTests,
  describeJupiterLendReadUnavailableReason,
  describeJupiterLendSdkUnavailableReason,
  getJupiterLendClient,
  isJupiterLendBorrowOperation,
  jupiterLendRestUnavailableReason,
  loadJupiterLendEarnSdkForSmokeTest,
  resetJupiterLendClientFactory,
  setJupiterLendClientFactory,
  type JupiterLendBorrowBorrowArgs,
  type JupiterLendBorrowCreatePositionArgs,
  type JupiterLendBorrowDepositCollateralArgs,
  type JupiterLendBorrowHealthPreview,
  type JupiterLendBorrowPositionSnapshot,
  type JupiterLendBorrowRepayArgs,
  type JupiterLendBorrowVaultSnapshot,
  type JupiterLendBorrowWithdrawCollateralArgs,
  type JupiterLendBuildResult,
  type JupiterLendClient,
  type JupiterLendClientFactory,
  type JupiterLendEarnDepositArgs,
  type JupiterLendEarnEarningsSnapshot,
  type JupiterLendEarnMintArgs,
  type JupiterLendEarnPositionSnapshot,
  type JupiterLendEarnRedeemArgs,
  type JupiterLendEarnSdkBundle,
  type JupiterLendEarnTokenSnapshot,
  type JupiterLendEarnWithdrawArgs,
  type JupiterLendOracleSnapshot,
} from './lendClient.js';
export type { JupiterLendBorrowActionInput, JupiterLendEarnActionInput } from './lendActions.js';
export {
  JUPITER_PREDICTION_BETA_WARNING,
  JUPITER_PREDICTION_EXTERNAL_PROVIDER_WARNING,
  assertPredictionEnabled,
  assertPredictionReadOnly,
  buildPredictionWarnings,
  predictionEnvelope,
  predictionRequest,
  type JupiterPredictionEnvelope,
  type JupiterPredictionPolicyConfig,
} from './predictionClient.js';
export {
  getPredictionEvents,
  getPredictionEventDetail,
  getPredictionEventMarkets,
  searchPredictionEvents,
  type EventDetailInput,
  type EventMarketsInput,
  type GetEventsInput,
  type NormalizedPredictionEventSummary,
  type PredictionEventCategory,
  type PredictionEventDetailResult,
  type PredictionEventFilter,
  type PredictionEventSortBy,
  type PredictionEventSortDirection,
  type PredictionEventsResult,
  type PredictionProvider,
  type SearchEventsInput,
} from './predictionEvents.js';
export {
  getPredictionMarketDetail,
  getPredictionOrderbook,
  normalizeMarket,
  type MarketDetailInput,
  type NormalizedOrderbook,
  type NormalizedOrderbookLevel,
  type NormalizedPredictionMarket,
  type OrderbookInput,
  type PredictionMarketStatus,
} from './predictionMarkets.js';
export {
  getPredictionHistory,
  getPredictionOrders,
  getPredictionOrderStatus,
  getPredictionPositions,
  getPredictionVaultInfo,
  type HistoryInput,
  type NormalizedPredictionHistoryEntry,
  type NormalizedPredictionOrder,
  type NormalizedPredictionPosition,
  type NormalizedPredictionVault,
  type OrdersInput,
  type OrderStatusInput,
  type PositionsInput,
  type PredictionHistoryResult,
  type PredictionOrderStatus,
  type PredictionOrdersResult,
  type PredictionPositionsResult,
  type VaultInfoInput,
} from './predictionWallet.js';
export {
  eventEvidence,
  eventsEvidence,
  historyEvidence,
  marketEvidence,
  orderEvidence,
  ordersEvidence,
  orderbookEvidence,
  positionEvidence,
  positionsEvidence,
  statusTone,
  vaultEvidence,
  type PredictionEvidence,
} from './predictionEvidence.js';
export {
  JUPITER_ADAPTER_ID,
  JUPITER_NAME,
  JUPITER_WEBSITE,
  JUPITER_DESCRIPTION,
  JUPITER_SUPPORTED_CLUSTERS,
  JUPITER_LEND_PROGRAM_IDS,
  JUPITER_LEND_BORROW_PROGRAM_ID,
  JUPITER_LEND_EARN_PROGRAM_ID,
  JUPITER_LEND_FLASHLOAN_PROGRAM_ID,
  JUPITER_LEND_LIQUIDITY_PROGRAM_ID,
  JUPITER_LEND_ORACLE_PROGRAM_ID,
  JUPITER_LEND_REWARDS_RATE_MODEL_PROGRAM_ID,
  DEFAULT_JUPITER_MAX_BORROW_LTV_BPS,
  DEFAULT_JUPITER_MIN_BORROW_HEALTH_RATIO,
  type JupiterLendBorrowOperation,
  type JupiterLendEarnOperation,
  type JupiterLendOperation,
} from './constants.js';
export {
  buildPerpsStatus,
  JUPITER_PERPS_DOCS,
  JUPITER_PERPS_WARNINGS,
  JUPITER_PERPS_WRITE_DENY_REASON,
  type JupiterPerpsApiStatus,
  type JupiterPerpsStatusInput,
  type JupiterPerpsStatusSnapshot,
} from './perpsStatus.js';
export {
  getPoolSnapshot as getJupiterPerpsPoolSnapshot,
  getCustodySnapshot as getJupiterPerpsCustodySnapshot,
  getPositionSnapshot as getJupiterPerpsPositionSnapshot,
  type JupiterPerpsPoolSnapshotInput,
  type JupiterPerpsCustodySnapshotInput,
  type JupiterPerpsPositionSnapshotInput,
} from './perpsAccounts.js';
export {
  factsFromJupiterPerpsStatus,
  factsFromJupiterPerpsPoolSnapshot,
  factsFromJupiterPerpsCustodySnapshot,
  factsFromJupiterPerpsPositionSnapshot,
} from './perpsEvidence.js';
export {
  clearJwt as clearJupiterTriggerJwt,
  getCachedJwt as getCachedJupiterTriggerJwt,
  jwtCacheKey as jupiterTriggerJwtCacheKey,
  readAuthStatus as readJupiterTriggerAuthStatus,
  requestChallenge as requestJupiterTriggerChallenge,
  requireTriggerEnabled as requireJupiterTriggerEnabled,
  requireValidJwt as requireJupiterTriggerJwt,
  resetTriggerAuthCache as resetJupiterTriggerAuthCache,
  storeJwt as storeJupiterTriggerJwt,
  verifyChallenge as verifyJupiterTriggerChallenge,
  type TriggerAuthStatus as JupiterTriggerAuthStatus,
  type TriggerChallenge as JupiterTriggerChallenge,
  type TriggerJwtEntry as JupiterTriggerJwtEntry,
} from './triggerAuth.js';
export {
  JUPITER_TRIGGER_CHALLENGE_MAX_TTL_MS,
  JUPITER_TRIGGER_JWT_MAX_TTL_MS,
  JUPITER_TRIGGER_JWT_SAFETY_MS,
  JUPITER_TRIGGER_OPERATIONS,
  JUPITER_TRIGGER_PRODUCT,
  type JupiterTriggerChallengeType,
  type JupiterTriggerOperation,
  type JupiterTriggerOrderState,
} from './triggerConstants.js';
export {
  readVault as readJupiterTriggerVault,
  prepareRegisterVault as prepareJupiterTriggerRegisterVault,
  type PrepareRegisterVaultResult as JupiterTriggerRegisterVaultResult,
  type TriggerVaultSnapshot as JupiterTriggerVaultSnapshot,
} from './triggerVault.js';
export {
  assertOrderCancellable as assertJupiterTriggerOrderCancellable,
  assertOrderWithdrawable as assertJupiterTriggerOrderWithdrawable,
  getOrder as getJupiterTriggerOrder,
  listOrders as listJupiterTriggerOrders,
  orderHistory as jupiterTriggerOrderHistory,
  type TriggerOrderSnapshot as JupiterTriggerOrderSnapshot,
} from './triggerOrders.js';
export {
  cancelOrderAction as jupiterTriggerCancelOrderAction,
  editOrderAction as jupiterTriggerEditOrderAction,
  ocoOrderAction as jupiterTriggerOcoOrderAction,
  otocoOrderAction as jupiterTriggerOtocoOrderAction,
  registerVaultAction as jupiterTriggerRegisterVaultAction,
  singleOrderAction as jupiterTriggerSingleOrderAction,
  withdrawOrderFundsAction as jupiterTriggerWithdrawOrderFundsAction,
  type JupiterTriggerCancelOrderInput,
  type JupiterTriggerEditOrderInput,
  type JupiterTriggerOcoOrderInput,
  type JupiterTriggerOtocoOrderInput,
  type JupiterTriggerRegisterVaultInput,
  type JupiterTriggerSingleOrderInput,
  type JupiterTriggerWithdrawOrderFundsInput,
} from './triggerActions.js';
export {
  TRIGGER_AUTOMATION_WARNING,
  TRIGGER_CANCEL_WITHDRAW_SEPARATE_WARNING,
  TRIGGER_CUSTODY_WARNING,
  TRIGGER_EXPIRED_FUNDS_WARNING,
  TRIGGER_JWT_VOLATILE_WARNING,
  TRIGGER_OUTPUT_NOT_GUARANTEED_WARNING,
  triggerCancelWarnings,
  triggerEditWarnings,
  triggerOrderCreateWarnings,
  triggerRegisterVaultWarnings,
  triggerWithdrawWarnings,
} from './triggerSafety.js';
export {
  getRecurringOrder as getJupiterRecurringOrder,
  listRecurringOrders as listJupiterRecurringOrders,
  normalizeRecurringOrder as normalizeJupiterRecurringOrder,
  normalizeRecurringOrderList as normalizeJupiterRecurringOrderList,
  requireRecurringEnabled as requireJupiterRecurringEnabled,
  type JupiterRecurringOrderState,
  type ListRecurringOrdersInput as JupiterRecurringOrdersInput,
  type ListRecurringOrdersResult as JupiterRecurringOrdersResult,
  type RecurringOrderSnapshot as JupiterRecurringOrderSnapshot,
} from './recurringOrders.js';
export {
  cancelRecurringOrderAction as jupiterRecurringCancelOrderAction,
  createTimeOrderAction as jupiterRecurringCreateTimeOrderAction,
  depositPriceOrderAction as jupiterRecurringDepositPriceOrderAction,
  quoteRecurringTimeOrder as jupiterRecurringQuote,
  withdrawPriceOrderAction as jupiterRecurringWithdrawPriceOrderAction,
  type JupiterRecurringCancelOrderInput,
  type JupiterRecurringCreateTimeOrderInput,
  type JupiterRecurringPriceOrderInput,
  type JupiterRecurringQuoteInput,
} from './recurringActions.js';
export {
  RECURRING_AUTOMATION_WARNING,
  RECURRING_FEE_WARNING,
  RECURRING_PRICE_ORDER_DEPRECATED_WARNING,
  recurringCancelWarnings,
  recurringCreateWarnings,
  recurringPriceOrderWarnings,
} from './recurringSafety.js';
