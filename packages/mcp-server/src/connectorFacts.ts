import { redactSecrets } from './trace.js';
import type { ConnectorCapability, ConnectorId } from './connectorRegistry.js';
import type {
  KaminoPosition,
  KaminoReserveSnapshot,
} from './adapters/kamino/client.js';
import type { KaminoEarningsProof } from './adapters/kamino/earningsProof.js';
import type {
  MeteoraPoolSnapshot,
  MeteoraPosition,
  MeteoraWalletPositionsResult,
} from './adapters/meteora/client.js';
import type {
  OrcaPosition,
  OrcaWalletPositionsResult,
  OrcaWhirlpoolSnapshot,
} from './adapters/orca/client.js';
import type {
  RaydiumPoolSnapshot,
  RaydiumPosition,
  RaydiumWalletPositionsResult,
} from './adapters/raydium/client.js';
import type {
  MarginfiAccountDetail,
  MarginfiAccountSummary,
  MarginfiBankSnapshot,
  MarginfiHealthPreview,
  MarginfiPosition,
} from './adapters/marginfi/client.js';
import { shortAddress } from './adapters/orca/constants.js';
import type {
  JupiterPriceBatchResult,
  JupiterPriceSnapshot,
  JupiterTokenReadResult,
  JupiterTokenRiskEvidence,
  NormalizedOrderbook,
  NormalizedPredictionEventSummary,
  NormalizedPredictionMarket,
  NormalizedPredictionOrder,
  NormalizedPredictionPosition,
  NormalizedPredictionVault,
  PredictionEventDetailResult,
  PredictionEventsResult,
  PredictionHistoryResult,
  PredictionMarketStatus,
  PredictionOrdersResult,
  PredictionPositionsResult,
} from './adapters/jupiter/index.js';
import type {
  SaveMarketSnapshot,
  SaveObligation,
  SaveReserveSnapshot,
} from './adapters/save/client.js';
import type { HealthPreview as SaveHealthPreview } from './adapters/save/health.js';
import type {
  JitoQuote,
  JitoDepositReceiptsResult,
  JitoStakeAccount,
  JitoStakePoolSnapshot,
  JitoWalletPositionsResult,
  JitoWithdrawMode,
} from './adapters/jito/client.js';
import type {
  MarinadeQuote,
  MarinadeStakeAccount,
  MarinadeStateSnapshot,
  MarinadeUnstakeTicket,
  MarinadeWalletPositionsResult,
} from './adapters/marinade/client.js';
import type {
  LuloBalancesUnavailable,
  LuloPoolMetaSnapshot,
  LuloRatesSnapshot,
  LuloWalletBalancesSnapshot,
} from './adapters/lulo/client.js';
import { depositTypeLabel, shortMint } from './adapters/lulo/constants.js';
import type {
  MagicedenApiHealthSnapshot,
  MagicedenCollectionBids,
  MagicedenCollectionListings,
  MagicedenCollectionSummary,
  MagicedenNftDetail,
  MagicedenRecentActivity,
  MagicedenWalletNftsSnapshot,
} from './adapters/magiceden/client.js';
import { shortMint as shortMagicedenMint } from './adapters/magiceden/constants.js';
import type {
  TensorBid,
  TensorCollectionSnapshot,
  TensorListing,
  TensorNftDetail,
  TensorSale,
  TensorWalletExposure,
  TensorWalletNftsResult,
} from './adapters/tensor/client.js';
import { shortAddress as shortTensorAddress, solFromLamports as tensorSolFromLamports } from './adapters/tensor/constants.js';
import type {
  WormholeQuoteSnapshot,
  WormholeSupportedRoutesSnapshot,
  WormholeTokenSnapshot,
  WormholeTransferStatus,
  WormholeWalletBridgeExposure,
} from './adapters/wormhole/client.js';
import type {
  JupiterLendBorrowHealthPreview,
  JupiterLendBorrowPositionSnapshot,
  JupiterLendBorrowVaultSnapshot,
  JupiterLendEarnEarningsSnapshot,
  JupiterLendEarnPositionSnapshot,
  JupiterLendEarnTokenSnapshot,
} from './adapters/jupiter/lendClient.js';
import { shortWormholeAddress } from './adapters/wormhole/constants.js';
import type {
  PythFeedSearchResult,
  PythOnchainSnapshot,
  PythOracleEvidence,
  PythPriceFeedSnapshotResult,
  PythPriceFeedsBatchResult,
} from './adapters/pyth/index.js';
import { shortFeedId } from './adapters/pyth/constants.js';
import type {
  SanctumLstListSnapshot,
  SanctumLstSnapshot,
  SanctumTokenOrder,
} from './adapters/sanctum/client.js';
import type { SanctumWalletPositionsSnapshot } from './adapters/sanctum/wallet.js';

export interface MagicedenCollectionSnapshotInput {
  summary: MagicedenCollectionSummary;
  listings?: MagicedenCollectionListings;
  bids?: MagicedenCollectionBids;
}

/**
 * Shape returned by the Tensor adapter's collection_snapshot read. Kept as a
 * structural alias so service code can pass the read result straight through
 * to factsFromTensorCollectionSnapshot without an `as` cast.
 */
export interface TensorCollectionSnapshotInput {
  collection: TensorCollectionSnapshot;
  listings?: TensorListing[];
  bids?: TensorBid[];
}

export type ConnectorFactTone = 'good' | 'warn' | 'neutral' | 'fail';

export interface ConnectorFact {
  connectorId: ConnectorId;
  label: string;
  value: string;
  tone: ConnectorFactTone;
  source: 'connector';
  checkedAt: string;
  detail?: Record<string, unknown>;
}

export interface ConnectorFactReadInput {
  connectorId: string;
  capability?: ConnectorCapability;
  walletAddress?: string;
  token?: string;
  mint?: string;
  mints?: string[];
  reserveMint?: string;
  lstMint?: string;
  inputMint?: string;
  outputMint?: string;
  inputToken?: string;
  outputToken?: string;
  amount?: string;
  slippageBps?: number;
  taker?: string;
  poolAddress?: string;
  positionAddress?: string;
  whirlpoolAddress?: string;
  poolId?: string;
  poolType?: string;
  positionMint?: string;
  farmId?: string;
  bankAddress?: string;
  bankMint?: string;
  marginfiAccount?: string;
  operation?: 'deposit' | 'withdraw' | 'borrow' | 'repay';
  vaultAddress?: string;
  subAccountId?: number;
  jitoOperation?: 'stake_sol' | 'deposit_stake_account' | 'unstake_jitosol' | 'withdraw_sol';
  marinadeOperation?: 'liquid_stake' | 'liquid_unstake' | 'delayed_unstake' | 'claim_delayed_unstake';
  stakeAccount?: string;
  receiptAddress?: string;
  solAmount?: string;
  jitoSolAmount?: string;
  msolAmount?: string;
  minJitoSolAmount?: string;
  minMsolAmount?: string;
  minSolAmount?: string;
  ticketAccount?: string;
  claimableOnly?: boolean;
  expectedClaimableAt?: string;
  maxFeeBps?: number;
  withdrawMode?: JitoWithdrawMode;
  includeValidators?: boolean;
  includeStakeAccounts?: boolean;
  delegatedOnly?: boolean;
  eligibleForJitoDepositOnly?: boolean;
  withdrawAll?: boolean;
  repayAll?: boolean;
  createAccountIfMissing?: boolean;
  sourceChain?: string;
  sourceMint?: string;
  destinationChain?: string;
  destinationAddress?: string;
  routeType?: 'auto' | 'token_bridge' | 'cctp' | 'ntt' | 'automatic' | 'manual';
  nativeGasDropoff?: string;
  txid?: string;
  vaa?: string;
  sequence?: string;
  transferId?: string;
  includePendingTransfers?: boolean;
  tag?: 'lst' | 'verified' | 'stocks';
  category?: 'toporganicscore' | 'toptraded' | 'toptrending';
  interval?: '5m' | '1h' | '6h' | '24h';
  limit?: number;
  includePrice?: boolean;
  includeSearchFallback?: boolean;
  priceFeedId?: string;
  priceFeedIds?: string[];
  symbol?: string;
  query?: string;
  assetType?: 'crypto' | 'equity' | 'fx' | 'commodity' | 'all';
  maxAgeSeconds?: number;
  maxConfidenceBps?: number;
  consumerProtocol?: string;
  includeEma?: boolean;
  includeRawAccount?: boolean;
  predictionOperation?:
    | 'events'
    | 'search_events'
    | 'event_detail'
    | 'event_markets'
    | 'market_detail'
    | 'orderbook'
    | 'orders'
    | 'order_status'
    | 'positions'
    | 'history'
    | 'vault_info';
  predictionProvider?: 'polymarket' | 'kalshi';
  predictionIncludeMarkets?: boolean;
  predictionCategory?:
    | 'all'
    | 'crypto'
    | 'sports'
    | 'politics'
    | 'esports'
    | 'culture'
    | 'economics'
    | 'tech';
  predictionSortBy?: 'volume' | 'beginAt';
  predictionSortDirection?: 'asc' | 'desc';
  predictionFilter?: 'new' | 'live' | 'trending';
  predictionStart?: number;
  predictionEnd?: number;
  predictionEventId?: string;
  predictionMarketId?: string;
  predictionOrderId?: string;
  predictionStatus?: 'pending' | 'filled' | 'failed' | 'all';
  predictionLimit?: number;
  predictionOwner?: string;
  collectionId?: string;
  collectionSymbol?: string;
  mintAddress?: string;
  assetId?: string;
  includeListings?: boolean;
  includeBids?: boolean;
  includeCompressed?: boolean;
  maxListings?: number;
  maxBids?: number;
  listedOnly?: boolean;
}

export function fact(input: {
  connectorId: ConnectorId;
  label: string;
  value: string;
  tone?: ConnectorFactTone;
  checkedAt?: string;
  detail?: Record<string, unknown>;
}): ConnectorFact {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  return {
    connectorId: input.connectorId,
    label: input.label,
    value: input.value,
    tone: input.tone ?? 'neutral',
    source: 'connector',
    checkedAt,
    ...(input.detail ? { detail: redactSecrets(input.detail) as Record<string, unknown> } : {}),
  };
}

export function factsFromKaminoReserveSnapshot(
  snapshot: KaminoReserveSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    fact({
      connectorId: 'kamino',
      label: 'Reserve',
      value: `${snapshot.reserveSymbol} reserve`,
      checkedAt,
      detail: {
        reserveMint: snapshot.reserveMint,
        reserveAddress: snapshot.reserveAddress,
        decimals: snapshot.decimals,
        lastUpdateSlot: snapshot.lastUpdateSlot,
        asOfBlockTime: snapshot.asOfBlockTime,
      },
    }),
    fact({
      connectorId: 'kamino',
      label: 'Supply APY',
      value: formatPercent(snapshot.supplyApy),
      tone: rateTone(snapshot.supplyApy),
      checkedAt,
    }),
    fact({
      connectorId: 'kamino',
      label: 'Borrow APY',
      value: formatPercent(snapshot.borrowApy),
      tone: 'neutral',
      checkedAt,
    }),
    fact({
      connectorId: 'kamino',
      label: 'Utilization',
      value: formatPercent(snapshot.utilization),
      tone: utilizationTone(snapshot.utilization),
      checkedAt,
    }),
    fact({
      connectorId: 'kamino',
      label: 'Deposit capacity',
      value: snapshot.depositLimitRemaining
        ? `${snapshot.depositLimitRemaining} ${snapshot.reserveSymbol} remaining`
        : 'No deposit capacity reported',
      tone: positiveString(snapshot.depositLimitRemaining) ? 'good' : 'warn',
      checkedAt,
      detail: {
        depositLimit: snapshot.depositLimit,
        depositLimitRemaining: snapshot.depositLimitRemaining,
      },
    }),
    fact({
      connectorId: 'kamino',
      label: 'Withdraw available',
      value: `${snapshot.withdrawAvailable} ${snapshot.reserveSymbol}`,
      tone: positiveString(snapshot.withdrawAvailable) ? 'good' : 'warn',
      checkedAt,
      detail: {
        withdrawalDelaySec: snapshot.withdrawalDelaySec,
      },
    }),
  ];
}

export function factsFromKaminoPositions(
  input: {
    walletAddress: string;
    positions: KaminoPosition[];
    totals?: { reserves?: number; totalSupplied?: string; totalEarned?: string };
  },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (input.positions.length === 0) {
    return [
      fact({
        connectorId: 'kamino',
        label: 'Kamino positions',
        value: 'No supplied positions found for this wallet',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: input.walletAddress },
      }),
    ];
  }
  const totals = input.totals;
  return [
    fact({
      connectorId: 'kamino',
      label: 'Kamino positions',
      value: totals
        ? `${totals.reserves ?? input.positions.length} reserves · ${totals.totalSupplied ?? '0'} supplied · ${totals.totalEarned ?? '0'} earned`
        : `${input.positions.length} reserves`,
      tone: 'good',
      checkedAt,
      detail: { walletAddress: input.walletAddress },
    }),
    ...input.positions.map((position) => fact({
      connectorId: 'kamino',
      label: `${position.reserveSymbol} supplied`,
      value: `${position.suppliedAmount} supplied · ${position.currentValue} current · ${position.earnedInterest} earned`,
      tone: positiveString(position.earnedInterest) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        reserveMint: position.reserveMint,
        reserveAddress: position.reserveAddress,
        supplyApy: position.supplyApy,
        withdrawAvailable: position.withdrawAvailable,
        asOfSlot: position.asOfSlot,
      },
    })),
  ];
}

export function factsFromKaminoEarningsProof(
  proof: KaminoEarningsProof,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    fact({
      connectorId: 'kamino',
      label: 'Earnings proof',
      value: `${proof.payload.totals.reserveCount} reserves · ${proof.payload.totals.earnedInterest} earned`,
      tone: proof.payload.totals.reserveCount > 0 ? 'good' : 'neutral',
      checkedAt,
      detail: {
        schema: proof.payload.schema,
        wallet: proof.payload.wallet,
        cluster: proof.payload.cluster,
        asOfIso: proof.payload.asOfIso,
      },
    }),
    fact({
      connectorId: 'kamino',
      label: 'Proof payload',
      value: `${proof.canonicalBase64.length} base64 chars ready for wallet message signing`,
      tone: 'neutral',
      checkedAt,
      detail: {
        canonicalBase64Length: proof.canonicalBase64.length,
      },
    }),
  ];
}

export function factsFromJupiterOrderPreview(
  order: Record<string, unknown>,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const outAmount = stringValue(order.outAmount);
  const minOutput = stringValue(order.otherAmountThreshold);
  const errorMessage = stringValue(order.errorMessage ?? order.error);
  const router = stringValue(order.router);
  const mode = stringValue(order.mode);
  const feeBps = order.feeBps ?? (safeFactRecord(order.platformFee)?.feeBps);
  const feeMint = stringValue(order.feeMint ?? safeFactRecord(order.platformFee)?.feeMint);
  const routePlan = Array.isArray(order.routePlan) ? order.routePlan : [];
  const facts = [
    fact({
      connectorId: 'jupiter',
      label: 'Jupiter Swap API v2 preview',
      value: errorMessage || (outAmount ? `Expected output ${outAmount}` : 'Preview returned without output amount'),
      tone: errorMessage ? 'fail' : outAmount ? 'good' : 'warn',
      checkedAt,
      detail: {
        mode,
        router,
        swapMode: order.swapMode,
        requestId: order.requestId,
        hasTransaction: order.hasTransaction,
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        inAmount: order.inAmount,
        outAmount: order.outAmount,
        otherAmountThreshold: order.otherAmountThreshold,
        gasless: order.gasless,
      },
    }),
    fact({
      connectorId: 'jupiter',
      label: 'Router',
      value: router ? `${router}${mode ? ` · ${mode}` : ''}` : 'Not reported',
      tone: mode === 'manual' ? 'warn' : router ? 'good' : 'neutral',
      checkedAt,
      detail: {
        routePlan,
        swapType: order.swapType,
        quoteId: order.quoteId,
        maker: order.maker,
        expireAt: order.expireAt,
      },
    }),
    fact({
      connectorId: 'jupiter',
      label: 'Minimum output',
      value: minOutput || 'Not reported',
      tone: minOutput ? 'good' : 'warn',
      checkedAt,
    }),
    fact({
      connectorId: 'jupiter',
      label: 'Slippage',
      value: order.slippageBps === undefined ? 'Not reported' : `${order.slippageBps} bps`,
      tone: slippageTone(order.slippageBps),
      checkedAt,
    }),
    fact({
      connectorId: 'jupiter',
      label: 'Price impact',
      value: order.priceImpact === undefined ? 'Not reported' : String(order.priceImpact),
      tone: priceImpactTone(order.priceImpact),
      checkedAt,
    }),
    fact({
      connectorId: 'jupiter',
      label: 'Fees',
      value: feeBps === undefined ? 'Not reported' : `${feeBps} bps${feeMint ? ` in ${shortAddress(feeMint)}` : ''}`,
      tone: feeBps === undefined ? 'neutral' : finiteNumber(feeBps) && finiteNumber(feeBps)! > 50 ? 'warn' : 'neutral',
      checkedAt,
      detail: {
        feeMint: order.feeMint,
        feeBps: order.feeBps,
        platformFee: order.platformFee,
        signatureFeeLamports: order.signatureFeeLamports,
        prioritizationFeeLamports: order.prioritizationFeeLamports,
        rentFeeLamports: order.rentFeeLamports,
      },
    }),
  ];
  const routingWarnings = jupiterRoutingConstraintWarnings(order, router, mode);
  if (routingWarnings.length > 0) {
    facts.push(fact({
      connectorId: 'jupiter',
      label: 'Routing constraints',
      value: routingWarnings.join(' '),
      tone: 'warn',
      checkedAt,
      detail: {
        mode,
        router,
        swapType: order.swapType,
        quoteId: order.quoteId,
        maker: order.maker,
        expireAt: order.expireAt,
      },
    }));
  }
  return facts;
}

function jupiterRoutingConstraintWarnings(
  order: Record<string, unknown>,
  router: string,
  mode: string,
): string[] {
  const warnings: string[] = [];
  if (mode.toLowerCase() === 'manual') {
    warnings.push('Manual mode means optional parameters may restrict routing or change swap behavior.');
  }
  const swapType = stringValue(order.swapType).toLowerCase();
  const hasRfqFields = Boolean(stringValue(order.quoteId) || stringValue(order.maker) || stringValue(order.expireAt));
  if (router.toLowerCase() === 'jupiterz' || swapType.includes('rfq') || hasRfqFields) {
    warnings.push('JupiterZ/RFQ routes can require partial signing and should not be modified after order creation.');
  }
  return warnings;
}

export {
  factsFromJupiterPerpsStatus,
  factsFromJupiterPerpsPoolSnapshot,
  factsFromJupiterPerpsCustodySnapshot,
  factsFromJupiterPerpsPositionSnapshot,
} from './adapters/jupiter/perpsEvidence.js';

export function factsFromJupiterTokenRead(
  result: JupiterTokenReadResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const descriptor = result.query
    ? ` for "${result.query}"`
    : result.tag
      ? ` tagged ${result.tag}`
      : result.category && result.interval
        ? ` for ${result.category}/${result.interval}`
        : '';
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'jupiter',
      label: 'Jupiter Token API V2',
      value: `${result.tokens.length} token${result.tokens.length === 1 ? '' : 's'}${descriptor}`,
      tone: result.tokens.length > 0 ? 'good' : 'warn',
      checkedAt,
      detail: {
        source: result.source,
        query: result.query,
        tag: result.tag,
        category: result.category,
        interval: result.interval,
        asOf: result.asOf,
      },
    }),
  ];
  for (const token of result.tokens.slice(0, 5)) {
    facts.push(fact({
      connectorId: 'jupiter',
      label: token.symbol ?? shortAddress(token.id),
      value: tokenValue(token),
      tone: token.isVerified === false ? 'warn' : token.isVerified === true ? 'good' : 'neutral',
      checkedAt,
      detail: {
        mint: token.id,
        name: token.name,
        decimals: token.decimals,
        tokenProgram: token.tokenProgram,
        tags: token.tags,
        holderCount: token.holderCount,
        liquidity: token.liquidity,
        organicScore: token.organicScore,
        organicScoreLabel: token.organicScoreLabel,
        audit: token.audit,
      },
    }));
  }
  return facts;
}

export function factsFromJupiterPrice(
  price: JupiterPriceSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    jupiterPriceFact(price, checkedAt),
    fact({
      connectorId: 'jupiter',
      label: 'Price evidence',
      value: 'Jupiter price is evidence, not an oracle guarantee.',
      tone: 'warn',
      checkedAt,
    }),
  ];
}

export function factsFromJupiterPriceBatch(
  batch: JupiterPriceBatchResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'jupiter',
      label: 'Jupiter Price API V3 batch',
      value: `${batch.totals.requested} requested · ${batch.totals.found} found · ${batch.totals.missing} missing`,
      tone: batch.totals.missing > 0 ? 'warn' : 'good',
      checkedAt,
      detail: { asOf: batch.asOf },
    }),
  ];
  for (const price of batch.prices.slice(0, 10)) {
    facts.push(jupiterPriceFact(price, checkedAt));
  }
  facts.push(fact({
    connectorId: 'jupiter',
    label: 'Price evidence',
    value: 'Jupiter price is evidence, not an oracle guarantee.',
    tone: 'warn',
    checkedAt,
  }));
  return facts;
}

export function factsFromJupiterTokenRiskEvidence(
  evidence: JupiterTokenRiskEvidence,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const tokenLabel = evidence.symbol ?? shortAddress(evidence.mint);
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'jupiter',
      label: `Jupiter token evidence ${tokenLabel}`,
      value: evidence.tokenFound
        ? `${evidence.name ?? tokenLabel}${evidence.isVerified === true ? ' · verified' : ' · not verified'}`
        : 'Token metadata missing',
      tone: evidence.riskLabels.some((label) => label.includes('suspicious') || label.includes('very_low'))
        ? 'fail'
        : evidence.warnings.length > 1
          ? 'warn'
          : 'good',
      checkedAt,
      detail: {
        mint: evidence.mint,
        decimals: evidence.decimals,
        tokenProgram: evidence.tokenProgram,
        tags: evidence.tags,
        organicScore: evidence.organicScore,
        organicScoreLabel: evidence.organicScoreLabel,
        audit: evidence.audit,
        holderCount: evidence.holderCount,
        topHoldersPercentage: evidence.topHoldersPercentage,
        liquidity: evidence.liquidity,
        mcap: evidence.mcap,
        fdv: evidence.fdv,
        stats: evidence.stats,
        asOf: evidence.asOf,
      },
    }),
    fact({
      connectorId: 'jupiter',
      label: 'Jupiter USD price',
      value: evidence.usdPrice === undefined
        ? 'Price missing or unreliable'
        : `$${evidence.usdPrice}${evidence.priceChange24h === undefined ? '' : ` · 24h ${formatPercent(evidence.priceChange24h)}`}`,
      tone: evidence.usdPrice === undefined ? 'warn' : 'good',
      checkedAt,
      detail: {
        priceBlockId: evidence.priceBlockId,
        priceChange24h: evidence.priceChange24h,
      },
    }),
  ];
  if (evidence.riskLabels.length > 0) {
    facts.push(fact({
      connectorId: 'jupiter',
      label: 'Risk labels',
      value: evidence.riskLabels.join(', '),
      tone: evidence.riskLabels.some((label) => label.includes('suspicious') || label.includes('very_low'))
        ? 'fail'
        : 'warn',
      checkedAt,
    }));
  }
  if (evidence.warnings.length > 0) {
    facts.push(fact({
      connectorId: 'jupiter',
      label: 'Token warnings',
      value: evidence.warnings.join(' '),
      tone: evidence.warnings.some((warning) => warning.toLowerCase().includes('suspicious')) ? 'fail' : 'warn',
      checkedAt,
    }));
  }
  return facts;
}

export function factsFromJupiterLendEarnTokens(
  input: { tokens: JupiterLendEarnTokenSnapshot[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (input.tokens.length === 0) {
    return [
      fact({
        connectorId: 'jupiter',
        label: 'Jupiter Earn markets',
        value: 'No Jupiter Lend Earn tokens were returned.',
        tone: 'warn',
        checkedAt,
      }),
    ];
  }
  return input.tokens.map((token) =>
    fact({
      connectorId: 'jupiter',
      label: `Jupiter Earn ${earnTokenLabel(token)}`,
      value: `${formatPercent(token.apy ?? Number.NaN)} APY${
        token.rewardApy ? ` · rewards ${formatPercent(token.rewardApy)}` : ''
      }${token.availableLiquidity ? ` · liquidity ${token.availableLiquidity}` : ''}`,
      tone: token.active === false ? 'warn' : rateTone(token.apy ?? Number.NaN),
      checkedAt,
      detail: {
        assetMint: token.assetMint,
        shareMint: token.shareMint,
        decimals: token.decimals,
        shareDecimals: token.shareDecimals,
        exchangePrice: token.exchangePrice,
        totalSupplyUnderlying: token.totalSupplyUnderlying,
        utilization: token.utilization,
        rewards: token.rewards,
        withdrawalSmoothing: token.withdrawalSmoothing,
        asOf: token.asOf,
      },
    }),
  );
}

export function factsFromJupiterLendEarnPositions(
  input: { walletAddress: string; positions: JupiterLendEarnPositionSnapshot[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (input.positions.length === 0) {
    return [
      fact({
        connectorId: 'jupiter',
        label: 'Jupiter Earn positions',
        value: 'No Jupiter Lend Earn positions for this wallet.',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: input.walletAddress },
      }),
    ];
  }
  return input.positions.map((position) =>
    fact({
      connectorId: 'jupiter',
      label: `Jupiter Earn ${earnPositionLabel(position)}`,
      value: `${position.underlyingAmount} ${earnPositionLabel(position)} · ${position.shares} shares${
        position.apy ? ` · ${formatPercent(position.apy)} APY` : ''
      }`,
      tone: positiveString(position.underlyingAmount) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        assetMint: position.assetMint,
        shareMint: position.shareMint,
        decimals: position.decimals,
        shareDecimals: position.shareDecimals,
        underlyingAmountRaw: position.underlyingAmountRaw,
        sharesRaw: position.sharesRaw,
        exchangePrice: position.exchangePrice,
        walletBalanceUnderlying: position.walletBalanceUnderlying,
        rewardApy: position.rewardApy,
        asOf: position.asOf,
      },
    }),
  );
}

export function factsFromJupiterLendEarnEarnings(
  input: { walletAddress: string; earnings: JupiterLendEarnEarningsSnapshot[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (input.earnings.length === 0) {
    return [
      fact({
        connectorId: 'jupiter',
        label: 'Jupiter Earn earnings',
        value: 'No Jupiter Lend Earn earnings reported for this window.',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: input.walletAddress },
      }),
    ];
  }
  return input.earnings.map((earning) =>
    fact({
      connectorId: 'jupiter',
      label: `Jupiter Earn earnings ${shortAddress(earning.assetMint)}`,
      value: `${earning.totalEarnings} earned${
        earning.rewardEarnings ? ` · ${earning.rewardEarnings} rewards` : ''
      }`,
      tone: positiveString(earning.totalEarnings) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        assetMint: earning.assetMint,
        decimals: earning.decimals,
        from: earning.from,
        to: earning.to,
        asOf: earning.asOf,
      },
    }),
  );
}

export function factsFromJupiterLendBorrowVaults(
  input: { vaults: JupiterLendBorrowVaultSnapshot[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (input.vaults.length === 0) {
    return [
      fact({
        connectorId: 'jupiter',
        label: 'Jupiter Borrow vaults',
        value: 'No Jupiter Lend Borrow vaults returned.',
        tone: 'warn',
        checkedAt,
      }),
    ];
  }
  return input.vaults.flatMap((vault) => {
    const baseTone: ConnectorFactTone = vault.active ? 'good' : 'warn';
    const ltvPercent = vault.ltvBps / 100;
    const ltPercent = vault.liquidationThresholdBps / 100;
    const liquidationPenaltyPercent =
      vault.liquidationPenaltyBps !== undefined ? vault.liquidationPenaltyBps / 100 : undefined;
    return [
      fact({
        connectorId: 'jupiter',
        label: `Jupiter Borrow vault #${vault.vaultId}`,
        value: `${borrowVaultPairLabel(vault)} · LTV ${ltvPercent}% · liquidation ${ltPercent}%`,
        tone: baseTone,
        checkedAt,
        detail: {
          vaultAddress: vault.vaultAddress,
          supplyMint: vault.supplyMint,
          borrowMint: vault.borrowMint,
          supplyDecimals: vault.supplyDecimals,
          borrowDecimals: vault.borrowDecimals,
          supplyApy: vault.supplyApy,
          borrowApr: vault.borrowApr,
          totalCollateral: vault.totalCollateral,
          totalDebt: vault.totalDebt,
          supplyAvailable: vault.supplyAvailable,
          borrowAvailable: vault.borrowAvailable,
          liquidationPenaltyPercent,
          oracle: vault.oracle,
          asOf: vault.asOf,
        },
      }),
    ];
  });
}

export function factsFromJupiterLendBorrowPositions(
  input: { walletAddress: string; positions: JupiterLendBorrowPositionSnapshot[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (input.positions.length === 0) {
    return [
      fact({
        connectorId: 'jupiter',
        label: 'Jupiter Borrow positions',
        value: 'No Jupiter Lend Borrow positions for this wallet.',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: input.walletAddress },
      }),
    ];
  }
  return input.positions.map((position) =>
    fact({
      connectorId: 'jupiter',
      label: `Jupiter Borrow position #${position.positionId}`,
      value: `collateral ${position.collateralAmount} · debt ${position.debtAmount} · health ${position.healthRatioText} · ${position.liquidationStatus}`,
      tone: borrowPositionTone(position),
      checkedAt,
      detail: {
        vaultId: position.vaultId,
        vaultAddress: position.vaultAddress,
        positionAddress: position.positionAddress,
        collateralAmountRaw: position.collateralAmountRaw,
        debtAmountRaw: position.debtAmountRaw,
        collateralValueUsd: position.collateralValueUsd,
        debtValueUsd: position.debtValueUsd,
        ltvBps: position.ltvBps,
        liquidationThresholdBps: position.liquidationThresholdBps,
        asOf: position.asOf,
      },
    }),
  );
}

export function factsFromJupiterLendBorrowHealth(
  preview: JupiterLendBorrowHealthPreview,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'jupiter',
      label: 'Jupiter Borrow health preview',
      value: `projected health ${preview.after.healthRatioText} · status ${preview.after.liquidationStatus}`,
      tone: preview.blocked
        ? 'fail'
        : preview.warnings.length > 0
          ? 'warn'
          : preview.after.liquidationStatus === 'safe'
            ? 'good'
            : 'warn',
      checkedAt,
      detail: {
        vaultId: preview.vaultId,
        vaultAddress: preview.vaultAddress,
        positionId: preview.positionId,
        walletAddress: preview.walletAddress,
        collateralDelta: preview.collateralDelta,
        debtDelta: preview.debtDelta,
        minHealthRatio: preview.minHealthRatio,
        maxLtvBps: preview.maxLtvBps,
        projectedLtvBps: preview.projectedLtvBps,
        simulatedAt: preview.simulatedAt,
      },
    }),
  ];
  if (preview.before) {
    facts.push(
      fact({
        connectorId: 'jupiter',
        label: 'Health before',
        value: `collateral ${preview.before.collateralAmount} · debt ${preview.before.debtAmount} · health ${preview.before.healthRatioText}`,
        tone: preview.before.liquidationStatus === 'safe' ? 'good' : 'warn',
        checkedAt,
        detail: { ...preview.before },
      }),
    );
  }
  facts.push(
    fact({
      connectorId: 'jupiter',
      label: 'Health after',
      value: `collateral ${preview.after.collateralAmount} · debt ${preview.after.debtAmount} · health ${preview.after.healthRatioText}`,
      tone: preview.blocked ? 'fail' : preview.after.liquidationStatus === 'safe' ? 'good' : 'warn',
      checkedAt,
      detail: { ...preview.after },
    }),
  );
  if (preview.warnings.length > 0) {
    facts.push(
      fact({
        connectorId: 'jupiter',
        label: 'Health warnings',
        value: preview.warnings.join('; '),
        tone: preview.blocked ? 'fail' : 'warn',
        checkedAt,
      }),
    );
  }
  if (preview.oracle) {
    facts.push(
      fact({
        connectorId: 'jupiter',
        label: 'Oracle',
        value: preview.oracle.available
          ? `price ${preview.oracle.price ?? 'unknown'} · confidence ${preview.oracle.confidenceBps ?? 'unknown'} bps`
          : 'Oracle unavailable',
        tone: preview.oracle.available ? 'good' : 'warn',
        checkedAt,
        detail: { ...preview.oracle },
      }),
    );
  }
  return facts;
}

function earnTokenLabel(token: JupiterLendEarnTokenSnapshot): string {
  return token.tokenSymbol ?? shortAddress(token.assetMint);
}

function earnPositionLabel(position: JupiterLendEarnPositionSnapshot): string {
  return position.tokenSymbol ?? shortAddress(position.assetMint);
}

function borrowVaultPairLabel(vault: JupiterLendBorrowVaultSnapshot): string {
  return `${vault.supplySymbol ?? shortAddress(vault.supplyMint)}/${vault.borrowSymbol ?? shortAddress(vault.borrowMint)}`;
}

function borrowPositionTone(position: JupiterLendBorrowPositionSnapshot): ConnectorFactTone {
  switch (position.liquidationStatus) {
    case 'liquidated':
    case 'liquidatable':
      return 'fail';
    case 'at_risk':
      return 'warn';
    case 'safe':
      return positiveString(position.debtAmount) ? 'good' : 'neutral';
    default:
      return 'neutral';
  }
}

function tokenValue(token: JupiterTokenReadResult['tokens'][number]): string {
  const parts = [
    token.name ?? shortAddress(token.id),
    token.isVerified === true ? 'verified' : token.isVerified === false ? 'unverified' : undefined,
    typeof token.liquidity === 'number' ? `liquidity $${formatCompactNumber(token.liquidity)}` : undefined,
    typeof token.organicScore === 'number' ? `organic ${token.organicScore}` : undefined,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

function jupiterPriceFact(price: JupiterPriceSnapshot, checkedAt: string): ConnectorFact {
  return fact({
    connectorId: 'jupiter',
    label: `Jupiter price ${shortAddress(price.mint)}`,
    value: price.status === 'found'
      ? `$${price.usdPrice}${price.priceChange24h === undefined ? '' : ` · 24h ${formatPercent(price.priceChange24h)}`}`
      : price.reason ?? 'Price missing',
    tone: price.status === 'found' ? 'good' : 'warn',
    checkedAt,
    detail: {
      mint: price.mint,
      status: price.status,
      usdPrice: price.usdPrice,
      decimals: price.decimals,
      blockId: price.blockId,
      priceChange24h: price.priceChange24h,
      liquidity: price.liquidity,
      createdAt: price.createdAt,
      asOf: price.asOf,
    },
  });
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toString();
}

const PREDICTION_BETA_LABEL = 'Jupiter Prediction (beta)';

function predictionStatusTone(status: PredictionMarketStatus): ConnectorFactTone {
  if (status === 'open') return 'good';
  if (status === 'unknown') return 'neutral';
  return 'warn';
}

function predictionBetaHeader(
  value: string,
  detail: Record<string, unknown>,
  checkedAt: string,
): ConnectorFact {
  return fact({
    connectorId: 'jupiter',
    label: PREDICTION_BETA_LABEL,
    value,
    tone: 'warn',
    checkedAt,
    detail,
  });
}

export function factsFromJupiterPredictionEvents(
  result: PredictionEventsResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const total = result.total ?? result.events.length;
  const facts: ConnectorFact[] = [
    predictionBetaHeader(
      total === 0 ? 'No events returned' : `${total} events`,
      { count: result.events.length, total: result.total },
      checkedAt,
    ),
  ];
  for (const event of result.events.slice(0, 10)) {
    facts.push(buildPredictionEventFact(event, checkedAt));
  }
  return facts;
}

export function factsFromJupiterPredictionEventDetail(
  result: PredictionEventDetailResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    predictionBetaHeader(
      result.event.title ?? result.event.id ?? 'Event',
      {
        eventId: result.event.id,
        provider: result.event.provider,
        closeAt: result.event.closeAt,
        marketCount: result.markets?.length ?? result.event.marketCount,
      },
      checkedAt,
    ),
  ];
  for (const market of result.markets?.slice(0, 10) ?? []) {
    facts.push(buildPredictionEventFact(market, checkedAt));
  }
  return facts;
}

function buildPredictionEventFact(
  event: NormalizedPredictionEventSummary,
  checkedAt: string,
): ConnectorFact {
  return fact({
    connectorId: 'jupiter',
    label: event.title ?? event.id ?? 'Event',
    value: [event.category, event.provider, event.volume ? `vol ${event.volume}` : undefined]
      .filter((part): part is string => Boolean(part))
      .join(' · ') || 'Beta event',
    tone: 'neutral',
    checkedAt,
    detail: {
      id: event.id,
      provider: event.provider,
      category: event.category,
      beginAt: event.beginAt,
      endAt: event.endAt,
      closeAt: event.closeAt,
      rulesUrl: event.rulesUrl,
      marketCount: event.marketCount,
    },
  });
}

export function factsFromJupiterPredictionMarketDetail(
  market: NormalizedPredictionMarket,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const status = market.status;
  return [
    predictionBetaHeader(
      market.question ?? market.id ?? 'Market',
      { id: market.id, status, rawStatus: market.rawStatus, provider: market.provider },
      checkedAt,
    ),
    fact({
      connectorId: 'jupiter',
      label: 'Status',
      value: market.rawStatus ?? status,
      tone: predictionStatusTone(status),
      checkedAt,
      detail: { result: market.result, closeAt: market.closeAt, resolveAt: market.resolveAt },
    }),
    fact({
      connectorId: 'jupiter',
      label: 'YES price',
      value: market.yesPrice ?? 'Not reported',
      tone: market.yesPrice ? 'good' : 'warn',
      checkedAt,
    }),
    fact({
      connectorId: 'jupiter',
      label: 'NO price',
      value: market.noPrice ?? 'Not reported',
      tone: market.noPrice ? 'good' : 'warn',
      checkedAt,
    }),
    fact({
      connectorId: 'jupiter',
      label: 'Volume',
      value: market.volume ?? 'Not reported',
      tone: 'neutral',
      checkedAt,
      detail: { rulesUrl: market.rulesUrl },
    }),
  ];
}

export function factsFromJupiterPredictionOrderbook(
  book: NormalizedOrderbook,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    predictionBetaHeader(
      `Orderbook for ${shortAddress(book.marketId)}`,
      { marketId: book.marketId, status: book.status },
      checkedAt,
    ),
    fact({
      connectorId: 'jupiter',
      label: 'YES best bid / ask',
      value: `${book.yes.bestBid ?? 'n/a'} / ${book.yes.bestAsk ?? 'n/a'}`,
      tone: predictionStatusTone(book.status),
      checkedAt,
      detail: { bidLevels: book.yes.bids.length, askLevels: book.yes.asks.length },
    }),
    fact({
      connectorId: 'jupiter',
      label: 'NO best bid / ask',
      value: `${book.no.bestBid ?? 'n/a'} / ${book.no.bestAsk ?? 'n/a'}`,
      tone: predictionStatusTone(book.status),
      checkedAt,
      detail: { bidLevels: book.no.bids.length, askLevels: book.no.asks.length },
    }),
  ];
}

export function factsFromJupiterPredictionOrders(
  result: PredictionOrdersResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    predictionBetaHeader(
      result.orders.length === 0
        ? `No orders for ${shortAddress(result.owner)}`
        : `${result.orders.length} orders for ${shortAddress(result.owner)}`,
      { owner: result.owner },
      checkedAt,
    ),
  ];
  for (const order of result.orders.slice(0, 10)) {
    facts.push(buildPredictionOrderFact(order, checkedAt));
  }
  return facts;
}

export function factsFromJupiterPredictionOrderStatus(
  order: NormalizedPredictionOrder,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    predictionBetaHeader(
      order.orderId ?? order.orderPubkey ?? 'Order',
      { marketId: order.marketId, status: order.status },
      checkedAt,
    ),
    buildPredictionOrderFact(order, checkedAt),
  ];
}

function buildPredictionOrderFact(
  order: NormalizedPredictionOrder,
  checkedAt: string,
): ConnectorFact {
  return fact({
    connectorId: 'jupiter',
    label: order.orderId ?? order.orderPubkey ?? 'Order',
    value: `${order.side ?? '—'} · ${order.price ?? 'n/a'} · ${order.size ?? 'n/a'} · ${order.status ?? 'unknown'}`,
    tone: order.status === 'filled' ? 'good' : order.status === 'failed' ? 'fail' : 'neutral',
    checkedAt,
    detail: {
      marketId: order.marketId,
      filled: order.filled,
      createdAt: order.createdAt,
    },
  });
}

export function factsFromJupiterPredictionPositions(
  result: PredictionPositionsResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    predictionBetaHeader(
      result.positions.length === 0
        ? `No positions for ${shortAddress(result.owner)}`
        : `${result.positions.length} positions for ${shortAddress(result.owner)}`,
      { owner: result.owner },
      checkedAt,
    ),
  ];
  for (const position of result.positions.slice(0, 10)) {
    facts.push(buildPredictionPositionFact(position, checkedAt));
  }
  return facts;
}

function buildPredictionPositionFact(
  position: NormalizedPredictionPosition,
  checkedAt: string,
): ConnectorFact {
  const tone: ConnectorFactTone = position.claimable
    ? 'good'
    : position.settled
      ? 'warn'
      : 'neutral';
  return fact({
    connectorId: 'jupiter',
    label: position.positionPubkey ?? position.marketId ?? 'Position',
    value: `${position.outcome ?? '—'} · ${position.shares ?? 'n/a'} shares · avg ${position.averagePrice ?? 'n/a'}${position.settled ? ' · settled' : ''}${position.claimable ? ' · claimable' : ''}`,
    tone,
    checkedAt,
    detail: {
      marketId: position.marketId,
      eventId: position.eventId,
      unrealizedPnl: position.unrealizedPnl,
    },
  });
}

export function factsFromJupiterPredictionHistory(
  result: PredictionHistoryResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    predictionBetaHeader(
      result.entries.length === 0
        ? `No history for ${shortAddress(result.owner)}`
        : `${result.entries.length} entries for ${shortAddress(result.owner)}`,
      { owner: result.owner },
      checkedAt,
    ),
  ];
  for (const entry of result.entries.slice(0, 10)) {
    facts.push(fact({
      connectorId: 'jupiter',
      label: entry.kind ?? entry.txid ?? 'Entry',
      value: `${entry.side ?? '—'} · ${entry.price ?? 'n/a'} · ${entry.size ?? 'n/a'} · ${entry.occurredAt ?? 'unknown'}`,
      tone: 'neutral',
      checkedAt,
      detail: { marketId: entry.marketId, eventId: entry.eventId, txid: entry.txid },
    }));
  }
  return facts;
}

export function factsFromJupiterPredictionVaultInfo(
  vault: NormalizedPredictionVault,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    predictionBetaHeader(
      vault.balance
        ? `${vault.balance}${vault.currency ? ` ${vault.currency}` : ''}`
        : 'No vault balance reported',
      { owner: vault.owner, vaultAddress: vault.vaultAddress },
      checkedAt,
    ),
  ];
}

export function factsFromOrcaWhirlpoolSnapshot(
  snapshot: OrcaWhirlpoolSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    fact({
      connectorId: 'orca',
      label: 'Orca Whirlpool',
      value: `${shortAddress(snapshot.tokenMintA)} / ${shortAddress(snapshot.tokenMintB)}`,
      tone: 'good',
      checkedAt,
      detail: {
        whirlpoolAddress: snapshot.whirlpoolAddress,
        programId: snapshot.programId,
        configAddress: snapshot.configAddress,
        tokenMintA: snapshot.tokenMintA,
        tokenMintB: snapshot.tokenMintB,
        tokenVaultA: snapshot.tokenVaultA,
        tokenVaultB: snapshot.tokenVaultB,
      },
    }),
    fact({
      connectorId: 'orca',
      label: 'Current tick',
      value: String(snapshot.currentTickIndex),
      tone: 'neutral',
      checkedAt,
      detail: {
        currentPrice: snapshot.currentPrice,
        sqrtPrice: snapshot.sqrtPrice,
        asOfSlot: snapshot.asOfSlot,
        asOfBlockTime: snapshot.asOfBlockTime,
      },
    }),
    fact({
      connectorId: 'orca',
      label: 'Liquidity',
      value: snapshot.liquidity,
      tone: positiveString(snapshot.liquidity) ? 'good' : 'warn',
      checkedAt,
      detail: {
        tickSpacing: snapshot.tickSpacing,
        feeRateBps: snapshot.feeRateBps,
        rewardMints: snapshot.rewardMints,
      },
    }),
  ];
}

export function factsFromOrcaPositions(
  result: OrcaWalletPositionsResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (result.positions.length === 0) {
    return [
      fact({
        connectorId: 'orca',
        label: 'Orca positions',
        value: 'No Whirlpool positions found for this wallet',
        tone: 'neutral',
        checkedAt,
        detail: {
          walletAddress: result.walletAddress,
          whirlpoolAddress: result.whirlpoolAddress,
        },
      }),
    ];
  }
  const totals = result.totals;
  return [
    fact({
      connectorId: 'orca',
      label: 'Orca positions',
      value: totals
        ? `${totals.positions} positions · ${totals.inRange ?? 0} in range · ${totals.outOfRange ?? 0} out of range`
        : `${result.positions.length} positions`,
      tone: 'good',
      checkedAt,
      detail: {
        walletAddress: result.walletAddress,
        whirlpoolAddress: result.whirlpoolAddress,
      },
    }),
    ...result.positions.map((position) => orcaPositionFact(position, checkedAt)),
  ];
}

export function factsFromOrcaPositionDetail(
  position: OrcaPosition,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts = [orcaPositionFact(position, checkedAt)];
  if (position.feesOwed && position.feesOwed.length > 0) {
    facts.push(fact({
      connectorId: 'orca',
      label: 'Claimable fees',
      value: formatTokenAmounts(position.feesOwed),
      tone: tokenAmountsPositive(position.feesOwed) ? 'good' : 'neutral',
      checkedAt,
      detail: { positionMint: position.positionMint, feesOwed: position.feesOwed },
    }));
  }
  if (position.rewardsOwed && position.rewardsOwed.length > 0) {
    facts.push(fact({
      connectorId: 'orca',
      label: 'Claimable rewards',
      value: formatTokenAmounts(position.rewardsOwed),
      tone: tokenAmountsPositive(position.rewardsOwed) ? 'good' : 'neutral',
      checkedAt,
      detail: { positionMint: position.positionMint, rewardsOwed: position.rewardsOwed },
    }));
  }
  if (position.warnings && position.warnings.length > 0) {
    facts.push(fact({
      connectorId: 'orca',
      label: 'Position warnings',
      value: position.warnings.join('; '),
      tone: 'warn',
      checkedAt,
      detail: { positionMint: position.positionMint },
    }));
  }
  return facts;
}

export function factsFromRaydiumPoolSnapshot(
  snapshot: RaydiumPoolSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const pair = `${snapshot.mintA.symbol ?? shortAddress(snapshot.mintA.mint)} / ${snapshot.mintB.symbol ?? shortAddress(snapshot.mintB.mint)}`;
  const facts = [
    fact({
      connectorId: 'raydium',
      label: `Raydium ${snapshot.poolType.toUpperCase()} pool`,
      value: pair,
      tone: 'good',
      checkedAt,
      detail: {
        poolId: snapshot.poolId,
        poolType: snapshot.poolType,
        programId: snapshot.programId,
        mintA: snapshot.mintA,
        mintB: snapshot.mintB,
        lpMint: snapshot.lpMint,
        asOfSlot: snapshot.asOfSlot,
      },
    }),
    fact({
      connectorId: 'raydium',
      label: 'Liquidity',
      value: snapshot.tvl ?? snapshot.liquidity ?? 'Not reported',
      tone: positiveString(snapshot.tvl ?? snapshot.liquidity) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        price: snapshot.price,
        feeRateBps: snapshot.feeRateBps,
      },
    }),
  ];
  if (snapshot.tickCurrent !== undefined || snapshot.tickSpacing !== undefined) {
    facts.push(fact({
      connectorId: 'raydium',
      label: 'CLMM tick',
      value: snapshot.tickCurrent === undefined ? 'Not reported' : String(snapshot.tickCurrent),
      tone: 'neutral',
      checkedAt,
      detail: {
        tickSpacing: snapshot.tickSpacing,
        rewardMints: snapshot.rewardMints,
      },
    }));
  }
  if (snapshot.rewardMints && snapshot.rewardMints.length > 0) {
    facts.push(fact({
      connectorId: 'raydium',
      label: 'Reward mints',
      value: snapshot.rewardMints.map(shortAddress).join(' · '),
      tone: 'neutral',
      checkedAt,
      detail: { rewardMints: snapshot.rewardMints },
    }));
  }
  return facts;
}

export function factsFromRaydiumPositions(
  result: RaydiumWalletPositionsResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (result.positions.length === 0) {
    return [
      fact({
        connectorId: 'raydium',
        label: 'Raydium positions',
        value: 'No Raydium positions found for this wallet',
        tone: 'neutral',
        checkedAt,
        detail: {
          walletAddress: result.walletAddress,
          poolId: result.poolId,
          farmId: result.farmId,
        },
      }),
    ];
  }
  const totals = result.totals;
  return [
    fact({
      connectorId: 'raydium',
      label: 'Raydium positions',
      value: totals
        ? `${totals.positions} positions · ${totals.clmmPositions} CLMM · ${totals.cpmmPositions} CPMM · ${totals.farmPositions} farm`
        : `${result.positions.length} positions`,
      tone: 'good',
      checkedAt,
      detail: {
        walletAddress: result.walletAddress,
        poolId: result.poolId,
        farmId: result.farmId,
      },
    }),
    ...result.positions.map((position) => raydiumPositionFact(position, checkedAt)),
  ];
}

export function factsFromRaydiumPositionDetail(
  position: RaydiumPosition,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts = [raydiumPositionFact(position, checkedAt)];
  if (position.feesOwed && position.feesOwed.length > 0) {
    facts.push(fact({
      connectorId: 'raydium',
      label: 'Claimable fees',
      value: formatTokenAmounts(position.feesOwed),
      tone: tokenAmountsPositive(position.feesOwed) ? 'good' : 'neutral',
      checkedAt,
      detail: { positionMint: position.positionMint, feesOwed: position.feesOwed },
    }));
  }
  if (position.rewardsOwed && position.rewardsOwed.length > 0) {
    facts.push(fact({
      connectorId: 'raydium',
      label: 'Claimable rewards',
      value: formatTokenAmounts(position.rewardsOwed),
      tone: tokenAmountsPositive(position.rewardsOwed) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        positionMint: position.positionMint,
        farmId: position.farmId,
        rewardsOwed: position.rewardsOwed,
      },
    }));
  }
  if (position.warnings && position.warnings.length > 0) {
    facts.push(fact({
      connectorId: 'raydium',
      label: 'Position warnings',
      value: position.warnings.join('; '),
      tone: 'warn',
      checkedAt,
      detail: { positionMint: position.positionMint, farmId: position.farmId },
    }));
  }
  return facts;
}

export function factsFromMeteoraPoolSnapshot(
  snapshot: MeteoraPoolSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    fact({
      connectorId: 'meteora',
      label: 'Meteora DLMM pool',
      value: `${shortAddress(snapshot.tokenMintX)} / ${shortAddress(snapshot.tokenMintY)}`,
      tone: 'good',
      checkedAt,
      detail: {
        poolAddress: snapshot.poolAddress,
        programId: snapshot.programId,
        tokenMintX: snapshot.tokenMintX,
        tokenMintY: snapshot.tokenMintY,
        tokenXSymbol: snapshot.tokenXSymbol,
        tokenYSymbol: snapshot.tokenYSymbol,
      },
    }),
    fact({
      connectorId: 'meteora',
      label: 'Active bin',
      value: String(snapshot.activeBinId),
      tone: 'neutral',
      checkedAt,
      detail: {
        binStep: snapshot.binStep,
        baseFeeBps: snapshot.baseFeeBps,
        dynamicFeeBps: snapshot.dynamicFeeBps,
        asOfSlot: snapshot.asOfSlot,
        asOfBlockTime: snapshot.asOfBlockTime,
      },
    }),
    fact({
      connectorId: 'meteora',
      label: 'Liquidity',
      value: snapshot.liquidity ?? 'Not reported',
      tone: positiveString(snapshot.liquidity) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        statusFlags: snapshot.statusFlags,
      },
    }),
  ];
}

export function factsFromMeteoraPositions(
  result: MeteoraWalletPositionsResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (result.positions.length === 0) {
    return [
      fact({
        connectorId: 'meteora',
        label: 'Meteora positions',
        value: 'No DLMM positions found for this wallet',
        tone: 'neutral',
        checkedAt,
        detail: {
          walletAddress: result.walletAddress,
          poolAddress: result.poolAddress,
        },
      }),
    ];
  }
  const totals = result.totals;
  return [
    fact({
      connectorId: 'meteora',
      label: 'Meteora positions',
      value: totals
        ? `${totals.positions} positions · ${totals.inRange ?? 0} in range · ${totals.outOfRange ?? 0} out of range`
        : `${result.positions.length} positions`,
      tone: 'good',
      checkedAt,
      detail: {
        walletAddress: result.walletAddress,
        poolAddress: result.poolAddress,
      },
    }),
    ...result.positions.map((position) => meteoraPositionFact(position, checkedAt)),
  ];
}

export function factsFromMeteoraPositionDetail(
  position: MeteoraPosition,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts = [meteoraPositionFact(position, checkedAt)];
  if (position.feesOwed && position.feesOwed.length > 0) {
    const fees = position.feesOwed.map((amount) => ({ ...amount, amount: amount.amount ?? '0' }));
    facts.push(fact({
      connectorId: 'meteora',
      label: 'Claimable fees',
      value: formatTokenAmounts(fees),
      tone: tokenAmountsPositive(fees) ? 'good' : 'neutral',
      checkedAt,
      detail: { positionAddress: position.positionAddress, feesOwed: position.feesOwed },
    }));
  }
  if (position.rewardsOwed && position.rewardsOwed.length > 0) {
    const rewards = position.rewardsOwed.map((amount) => ({ ...amount, amount: amount.amount ?? '0' }));
    facts.push(fact({
      connectorId: 'meteora',
      label: 'Claimable rewards',
      value: formatTokenAmounts(rewards),
      tone: tokenAmountsPositive(rewards) ? 'good' : 'neutral',
      checkedAt,
      detail: { positionAddress: position.positionAddress, rewardsOwed: position.rewardsOwed },
    }));
  }
  if (position.warnings && position.warnings.length > 0) {
    facts.push(fact({
      connectorId: 'meteora',
      label: 'Position warnings',
      value: position.warnings.join('; '),
      tone: 'warn',
      checkedAt,
      detail: { positionAddress: position.positionAddress },
    }));
  }
  return facts;
}

export function factsFromMarginfiBankSnapshot(
  snapshot: MarginfiBankSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const token = marginfiTokenLabel(snapshot);
  return [
    fact({
      connectorId: 'marginfi',
      label: 'MarginFi bank',
      value: `${token} bank`,
      tone: 'good',
      checkedAt,
      detail: {
        bankAddress: snapshot.bankAddress,
        bankMint: snapshot.bankMint,
        decimals: snapshot.decimals,
        riskTier: snapshot.riskTier,
        operationalState: snapshot.operationalState,
        lastUpdateSlot: snapshot.lastUpdateSlot,
      },
    }),
    fact({
      connectorId: 'marginfi',
      label: 'Deposit APY',
      value: formatPercent(snapshot.depositApy ?? Number.NaN),
      tone: rateTone(snapshot.depositApy ?? Number.NaN),
      checkedAt,
    }),
    fact({
      connectorId: 'marginfi',
      label: 'Borrow APR',
      value: formatPercent(snapshot.borrowApr ?? Number.NaN),
      tone: 'neutral',
      checkedAt,
    }),
    fact({
      connectorId: 'marginfi',
      label: 'Utilization',
      value: formatPercent(snapshot.utilization ?? Number.NaN),
      tone: utilizationTone(snapshot.utilization ?? Number.NaN),
      checkedAt,
    }),
    fact({
      connectorId: 'marginfi',
      label: 'Deposit capacity',
      value: snapshot.depositCapacity
        ? `${snapshot.depositCapacity} ${token} remaining`
        : 'No deposit capacity reported',
      tone: positiveString(snapshot.depositCapacity) ? 'good' : 'warn',
      checkedAt,
      detail: {
        totalAssets: snapshot.totalAssets,
        depositCapacity: snapshot.depositCapacity,
      },
    }),
    fact({
      connectorId: 'marginfi',
      label: 'Borrow capacity',
      value: snapshot.borrowCapacity
        ? `${snapshot.borrowCapacity} ${token} remaining`
        : 'No borrow capacity reported',
      tone: positiveString(snapshot.borrowCapacity) ? 'good' : 'warn',
      checkedAt,
      detail: {
        totalLiabilities: snapshot.totalLiabilities,
        borrowCapacity: snapshot.borrowCapacity,
        oraclePrice: snapshot.oraclePrice,
        oracleTimestamp: snapshot.oracleTimestamp,
        oracleMaxAge: snapshot.oracleMaxAge,
      },
    }),
  ];
}

export function factsFromMarginfiAccountDetail(
  detail: MarginfiAccountDetail,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (detail.positions.length === 0) {
    return [
      fact({
        connectorId: 'marginfi',
        label: 'MarginFi positions',
        value: 'No active MarginFi balances found for this account',
        tone: 'neutral',
        checkedAt,
        detail: {
          marginfiAccount: detail.marginfiAccount,
          authority: detail.authority,
          health: detail.health,
        },
      }),
    ];
  }
  return [
    fact({
      connectorId: 'marginfi',
      label: 'MarginFi account',
      value: `${detail.positions.length} positions · ${detail.health.netValue} net value · health ${detail.health.healthRatioText}`,
      tone: marginfiHealthTone(detail.health),
      checkedAt,
      detail: {
        marginfiAccount: detail.marginfiAccount,
        authority: detail.authority,
        activeBalances: detail.activeBalances,
        netApy: detail.netApy,
        health: detail.health,
      },
    }),
    ...detail.positions.map((position) => fact({
      connectorId: 'marginfi',
      label: `${position.tokenSymbol ?? shortAddress(position.bankMint)} position`,
      value: marginfiPositionValue(position),
      tone: positiveString(position.borrowedAmount) ? 'warn' : positiveString(position.suppliedAmount) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        bankAddress: position.bankAddress,
        bankMint: position.bankMint,
        decimals: position.decimals,
        suppliedUsd: position.suppliedUsd,
        borrowedUsd: position.borrowedUsd,
        assetShares: position.assetShares,
        liabilityShares: position.liabilityShares,
        lastUpdateSlot: position.lastUpdateSlot,
      },
    })),
  ];
}

export function factsFromMarginfiAccountSummaries(
  input: { walletAddress: string; accounts: MarginfiAccountSummary[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (input.accounts.length === 0) {
    return [
      fact({
        connectorId: 'marginfi',
        label: 'MarginFi accounts',
        value: 'No MarginFi accounts found for this wallet',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: input.walletAddress },
      }),
    ];
  }
  return [
    fact({
      connectorId: 'marginfi',
      label: 'MarginFi accounts',
      value: `${input.accounts.length} accounts`,
      tone: 'good',
      checkedAt,
      detail: { walletAddress: input.walletAddress },
    }),
    ...input.accounts.map((account) => fact({
      connectorId: 'marginfi',
      label: `Account ${shortAddress(account.marginfiAccount)}`,
      value: `${account.activeBalances} active balances · health ${account.health.healthRatioText}`,
      tone: marginfiHealthTone(account.health),
      checkedAt,
      detail: { ...account },
    })),
  ];
}

export function factsFromMarginfiHealthPreview(
  preview: MarginfiHealthPreview,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const token = preview.tokenSymbol ?? shortAddress(preview.bankMint);
  const facts = [
    fact({
      connectorId: 'marginfi',
      label: 'MarginFi health preview',
      value: `${preview.operation} ${preview.amount} ${token} · projected health ${preview.after?.healthRatioText ?? 'unavailable'}`,
      tone: preview.blocked ? 'fail' : preview.warnings.length > 0 ? 'warn' : marginfiHealthTone(preview.after ?? preview.before),
      checkedAt,
      detail: {
        operation: preview.operation,
        marginfiAccount: preview.marginfiAccount,
        bankAddress: preview.bankAddress,
        bankMint: preview.bankMint,
        amountRaw: preview.amountRaw,
        withdrawAll: preview.withdrawAll,
        repayAll: preview.repayAll,
        minHealthRatio: preview.minHealthRatio,
        simulatedAt: preview.simulatedAt,
      },
    }),
    fact({
      connectorId: 'marginfi',
      label: 'Health before',
      value: marginfiHealthValue(preview.before),
      tone: marginfiHealthTone(preview.before),
      checkedAt,
      detail: { ...preview.before },
    }),
  ];
  if (preview.after) {
    facts.push(fact({
      connectorId: 'marginfi',
      label: 'Health after',
      value: marginfiHealthValue(preview.after),
      tone: preview.blocked ? 'fail' : marginfiHealthTone(preview.after),
      checkedAt,
      detail: { ...preview.after },
    }));
  }
  if (preview.warnings.length > 0) {
    facts.push(fact({
      connectorId: 'marginfi',
      label: 'Health warnings',
      value: preview.warnings.join('; '),
      tone: preview.blocked ? 'fail' : 'warn',
      checkedAt,
    }));
  }
  return facts;
}

export function factsFromSaveReserveSnapshot(
  snapshot: SaveReserveSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    fact({
      connectorId: 'save',
      label: 'Reserve',
      value: `${snapshot.reserveSymbol} reserve`,
      checkedAt,
      detail: {
        reserveMint: snapshot.reserveMint,
        reserveAddress: snapshot.reserveAddress,
        marketAddress: snapshot.marketAddress,
        decimals: snapshot.decimals,
        lastUpdateSlot: snapshot.lastUpdateSlot,
        asOfBlockTime: snapshot.asOfBlockTime,
      },
    }),
    fact({
      connectorId: 'save',
      label: 'Supply APY',
      value: formatPercent(snapshot.supplyApy),
      tone: rateTone(snapshot.supplyApy),
      checkedAt,
    }),
    fact({
      connectorId: 'save',
      label: 'Borrow APY',
      value: formatPercent(snapshot.borrowApy),
      tone: 'neutral',
      checkedAt,
    }),
    fact({
      connectorId: 'save',
      label: 'Utilization',
      value: formatPercent(snapshot.utilization),
      tone: utilizationTone(snapshot.utilization),
      checkedAt,
    }),
    fact({
      connectorId: 'save',
      label: 'Collateral factor',
      value: formatPercent(snapshot.collateralFactor),
      tone: 'neutral',
      checkedAt,
      detail: {
        liquidationThreshold: snapshot.liquidationThreshold,
        liquidationBonus: snapshot.liquidationBonus,
      },
    }),
    fact({
      connectorId: 'save',
      label: 'Liquidity available',
      value: `${snapshot.liquidity} ${snapshot.reserveSymbol}`,
      tone: positiveString(snapshot.liquidity) ? 'good' : 'warn',
      checkedAt,
      detail: {
        depositLimit: snapshot.depositLimit,
        depositLimitRemaining: snapshot.depositLimitRemaining,
        borrowLimit: snapshot.borrowLimit,
        borrowLimitRemaining: snapshot.borrowLimitRemaining,
      },
    }),
  ];
}

export function factsFromSaveObligation(
  input: { walletAddress: string; obligation: SaveObligation | null },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (!input.obligation) {
    return [
      fact({
        connectorId: 'save',
        label: 'Save obligation',
        value: 'No Save obligation found for this wallet',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: input.walletAddress },
      }),
    ];
  }
  const obligation = input.obligation;
  return [
    fact({
      connectorId: 'save',
      label: 'Save obligation',
      value: `${obligation.deposits.length} supplied · ${obligation.borrows.length} borrowed`,
      tone: 'good',
      checkedAt,
      detail: {
        walletAddress: input.walletAddress,
        obligationAddress: obligation.obligationAddress,
        marketAddress: obligation.marketAddress,
        asOfSlot: obligation.asOfSlot,
      },
    }),
    fact({
      connectorId: 'save',
      label: 'Total supplied',
      value: `${obligation.totalDepositValueUsd.toFixed(2)} USD`,
      tone: obligation.totalDepositValueUsd > 0 ? 'good' : 'neutral',
      checkedAt,
    }),
    fact({
      connectorId: 'save',
      label: 'Total borrowed',
      value: `${obligation.totalBorrowValueUsd.toFixed(2)} USD`,
      tone: obligation.totalBorrowValueUsd > 0 ? 'neutral' : 'good',
      checkedAt,
      detail: {
        borrowLimitUsd: obligation.borrowLimitUsd,
        liquidationThresholdUsd: obligation.liquidationThresholdUsd,
      },
    }),
    fact({
      connectorId: 'save',
      label: 'Health factor',
      value: Number.isFinite(obligation.healthFactor)
        ? obligation.healthFactor.toFixed(3)
        : 'no debt',
      tone: saveHealthTone(obligation.healthFactor),
      checkedAt,
    }),
    ...obligation.deposits.map((deposit) =>
      fact({
        connectorId: 'save',
        label: `${deposit.reserveSymbol} supplied`,
        value: `${deposit.amount} ${deposit.reserveSymbol}`,
        tone: 'good',
        checkedAt,
        detail: {
          reserveMint: deposit.reserveMint,
          reserveAddress: deposit.reserveAddress,
          valueUsd: deposit.valueUsd,
          collateralValueUsd: deposit.collateralValueUsd,
        },
      }),
    ),
    ...obligation.borrows.map((borrow) =>
      fact({
        connectorId: 'save',
        label: `${borrow.reserveSymbol} borrowed`,
        value: `${borrow.amount} ${borrow.reserveSymbol}`,
        tone: 'warn',
        checkedAt,
        detail: {
          reserveMint: borrow.reserveMint,
          reserveAddress: borrow.reserveAddress,
          valueUsd: borrow.valueUsd,
          weightedValueUsd: borrow.weightedValueUsd,
        },
      }),
    ),
  ];
}

export function factsFromSaveMarketSnapshot(
  snapshot: SaveMarketSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    fact({
      connectorId: 'save',
      label: 'Save market',
      value: `${snapshot.reserveCount} reserves · ${snapshot.totalDeposits} deposits · ${snapshot.totalBorrows} borrows`,
      tone: 'good',
      checkedAt,
      detail: {
        marketAddress: snapshot.marketAddress,
        programId: snapshot.programId,
      },
    }),
    ...snapshot.reserves.map((reserve) =>
      fact({
        connectorId: 'save',
        label: `${reserve.reserveSymbol} reserve`,
        value: `${formatPercent(reserve.supplyApy)} supply · ${formatPercent(reserve.borrowApy)} borrow · ${formatPercent(reserve.utilization)} util`,
        tone: utilizationTone(reserve.utilization),
        checkedAt,
        detail: {
          reserveAddress: reserve.reserveAddress,
          reserveMint: reserve.reserveMint,
        },
      }),
    ),
  ];
}

export function factsFromSaveHealthPreview(
  preview: SaveHealthPreview,
  context: { operation: string; reserveSymbol: string },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'save',
      label: `${context.operation} ${context.reserveSymbol}`,
      value: `current HF ${formatSaveHealthFactor(preview.currentHealthFactor)} → projected HF ${formatSaveHealthFactor(preview.projectedHealthFactor)}`,
      tone: saveHealthTone(preview.projectedHealthFactor),
      checkedAt,
      detail: {
        projectedTotalDepositValueUsd: preview.projectedTotalDepositValueUsd,
        projectedTotalBorrowValueUsd: preview.projectedTotalBorrowValueUsd,
        projectedBorrowLimitUsd: preview.projectedBorrowLimitUsd,
        projectedLiquidationThresholdUsd: preview.projectedLiquidationThresholdUsd,
      },
    }),
  ];
  if (preview.breaches.length > 0) {
    facts.push(fact({
      connectorId: 'save',
      label: 'Health breaches',
      value: preview.breaches.join('; '),
      tone: 'fail',
      checkedAt,
    }));
  }
  return facts;
}

export function factsFromJitoStakePoolSnapshot(
  snapshot: JitoStakePoolSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'jito',
      label: 'Jito stake pool',
      value: `${snapshot.exchangeRateSolPerJitoSol} SOL per JitoSOL`,
      tone: positiveString(snapshot.totalLamports) ? 'good' : 'warn',
      checkedAt,
      detail: {
        stakePoolAddress: snapshot.stakePoolAddress,
        jitoSolMint: snapshot.jitoSolMint,
        poolMint: snapshot.poolMint,
        reserveStake: snapshot.reserveStake,
        validatorList: snapshot.validatorList,
        totalLamports: snapshot.totalLamports,
        poolTokenSupply: snapshot.poolTokenSupply,
        lastUpdateEpoch: snapshot.lastUpdateEpoch,
        asOfSlot: snapshot.asOfSlot,
        asOfBlockTime: snapshot.asOfBlockTime,
      },
    }),
    fact({
      connectorId: 'jito',
      label: 'Mint rate',
      value: `${snapshot.exchangeRateJitoSolPerSol} JitoSOL per SOL`,
      tone: 'neutral',
      checkedAt,
    }),
    fact({
      connectorId: 'jito',
      label: 'Deposit fees',
      value: `${trimNumber(snapshot.fees.solDeposit.bps)} bps SOL · ${trimNumber(snapshot.fees.stakeDeposit.bps)} bps stake`,
      tone: snapshot.fees.solDeposit.bps > 0 || snapshot.fees.stakeDeposit.bps > 0 ? 'warn' : 'good',
      checkedAt,
      detail: {
        solDeposit: snapshot.fees.solDeposit,
        stakeDeposit: snapshot.fees.stakeDeposit,
      },
    }),
    fact({
      connectorId: 'jito',
      label: 'Withdrawal fees',
      value: `${trimNumber(snapshot.fees.solWithdrawal.bps)} bps SOL · ${trimNumber(snapshot.fees.stakeWithdrawal.bps)} bps stake`,
      tone: snapshot.fees.solWithdrawal.bps > 0 || snapshot.fees.stakeWithdrawal.bps > 0 ? 'warn' : 'good',
      checkedAt,
      detail: {
        solWithdrawal: snapshot.fees.solWithdrawal,
        stakeWithdrawal: snapshot.fees.stakeWithdrawal,
      },
    }),
  ];
  if (snapshot.validators) {
    facts.push(fact({
      connectorId: 'jito',
      label: 'Validators',
      value: `${snapshot.validators.length} validators returned`,
      tone: snapshot.validators.length > 0 ? 'good' : 'warn',
      checkedAt,
    }));
  }
  if (snapshot.warnings.length > 0) {
    facts.push(fact({
      connectorId: 'jito',
      label: 'Jito warnings',
      value: snapshot.warnings.join('; '),
      tone: 'warn',
      checkedAt,
    }));
  }
  return facts;
}

export function factsFromJitoWalletPositions(
  snapshot: JitoWalletPositionsResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'jito',
      label: 'JitoSOL balance',
      value: `${snapshot.jitoSol.amount} JitoSOL`,
      tone: positiveString(snapshot.jitoSol.amount) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        walletAddress: snapshot.walletAddress,
        mint: snapshot.jitoSol.mint,
        amountRaw: snapshot.jitoSol.amountRaw,
        tokenAccounts: snapshot.jitoSol.tokenAccounts.map((account) => account.tokenAccount),
      },
    }),
  ];
  if (snapshot.stakeAccounts) {
    facts.push(...factsFromJitoStakeAccounts({
      walletAddress: snapshot.walletAddress,
      stakeAccounts: snapshot.stakeAccounts,
    }, checkedAt));
  }
  return facts;
}

export function factsFromJitoStakeAccounts(
  input: { walletAddress: string; stakeAccounts: JitoStakeAccount[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (input.stakeAccounts.length === 0) {
    return [
      fact({
        connectorId: 'jito',
        label: 'Stake accounts',
        value: 'No wallet stake accounts found',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: input.walletAddress },
      }),
    ];
  }
  const eligible = input.stakeAccounts.filter((account) => account.eligibleForJitoDeposit);
  return [
    fact({
      connectorId: 'jito',
      label: 'Stake accounts',
      value: `${input.stakeAccounts.length} found · ${eligible.length} eligible for Jito deposit`,
      tone: eligible.length > 0 ? 'good' : 'neutral',
      checkedAt,
      detail: {
        walletAddress: input.walletAddress,
        eligibleStakeAccounts: eligible.map((account) => account.stakeAccount),
      },
    }),
    ...input.stakeAccounts.slice(0, 5).map((account) =>
      fact({
        connectorId: 'jito',
        label: shortAddress(account.stakeAccount),
        value: account.eligibleForJitoDeposit
          ? `${formatRawAmountString(account.delegatedStakeLamports)} delegated SOL · eligible`
          : account.ineligibleReason ?? `${account.state} stake account`,
        tone: account.eligibleForJitoDeposit ? 'good' : account.deactivating || account.locked ? 'warn' : 'neutral',
        checkedAt,
        detail: {
          stakeAccount: account.stakeAccount,
          voter: account.voter,
          state: account.state,
          delegatedStakeLamports: account.delegatedStakeLamports,
          deactivationEpoch: account.deactivationEpoch,
          ineligibleReason: account.ineligibleReason,
        },
      }),
    ),
  ];
}

export function factsFromJitoDepositReceipts(
  snapshot: JitoDepositReceiptsResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'jito',
      label: 'Jito deposit receipts',
      value: `${snapshot.totals.receipts} receipts · ${snapshot.totals.claimableReceipts} claimable · ${snapshot.totals.lstAmount} JitoSOL`,
      tone: snapshot.totals.claimableReceipts > 0 ? 'good' : snapshot.totals.receipts > 0 ? 'warn' : 'neutral',
      checkedAt,
      detail: {
        walletAddress: snapshot.walletAddress,
        totals: snapshot.totals,
      },
    }),
  ];
  for (const receipt of snapshot.receipts.slice(0, 5)) {
    facts.push(fact({
      connectorId: 'jito',
      label: shortAddress(receipt.depositReceipt),
      value: receipt.cooldownComplete
        ? `${receipt.lstAmount} JitoSOL claimable`
        : `${receipt.lstAmount} JitoSOL claimable at ${receipt.claimableAt}`,
      tone: receipt.cooldownComplete ? 'good' : 'warn',
      checkedAt,
      detail: {
        depositReceipt: receipt.depositReceipt,
        owner: receipt.owner,
        lstAmountRaw: receipt.lstAmountRaw,
        claimableAt: receipt.claimableAt,
        cooldownComplete: receipt.cooldownComplete,
        secondsUntilClaimable: receipt.secondsUntilClaimable,
        initialFeeBps: receipt.initialFeeBps,
        warnings: receipt.warnings,
      },
    }));
  }
  return facts;
}

export function factsFromJitoQuote(
  quote: JitoQuote,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const output = quote.expectedJitoSolAmount
    ? `${quote.expectedJitoSolAmount} JitoSOL`
    : quote.expectedSolAmount
      ? `${quote.expectedSolAmount} SOL`
      : 'No output estimate';
  const facts = [
    fact({
      connectorId: 'jito',
      label: 'Jito quote',
      value: `${quote.operation} → ${output}`,
      tone: output === 'No output estimate' ? 'warn' : 'good',
      checkedAt,
      detail: {
        operation: quote.operation,
        amount: quote.amount,
        amountRaw: quote.amountRaw,
        stakeAccount: quote.stakeAccount,
        withdrawMode: quote.withdrawMode,
        expectedJitoSolRaw: quote.expectedJitoSolRaw,
        expectedSolRaw: quote.expectedSolRaw,
        exchangeRateSnapshot: quote.exchangeRateSnapshot,
      },
    }),
  ];
  if (quote.warnings.length > 0) {
    facts.push(fact({
      connectorId: 'jito',
      label: 'Quote warnings',
      value: quote.warnings.join('; '),
      tone: 'warn',
      checkedAt,
    }));
  }
  return facts;
}

export function factsFromMarinadeStateSnapshot(
  snapshot: MarinadeStateSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'marinade',
      label: 'Marinade state',
      value: snapshot.msolPrice
        ? `${snapshot.msolPrice} SOL per mSOL`
        : 'mSOL price not reported',
      tone: snapshot.msolPrice ? 'good' : 'neutral',
      checkedAt,
      detail: {
        stateAddress: snapshot.stateAddress,
        programId: snapshot.programId,
        msolMint: snapshot.msolMint,
        asOfSlot: snapshot.asOfSlot,
        totalVirtualStakedSol: snapshot.totalVirtualStakedSol,
        circulatingMsol: snapshot.circulatingMsol,
        availableReserveSol: snapshot.availableReserveSol,
      },
    }),
  ];
  if (snapshot.totalVirtualStakedSol || snapshot.availableReserveSol) {
    facts.push(fact({
      connectorId: 'marinade',
      label: 'Pool liquidity',
      value: `${snapshot.totalVirtualStakedSol ?? 'unknown'} SOL staked · ${snapshot.availableReserveSol ?? 'unknown'} SOL reserve`,
      tone: positiveString(snapshot.totalVirtualStakedSol) ? 'good' : 'neutral',
      checkedAt,
    }));
  }
  if (snapshot.rewardFeeBps !== undefined) {
    facts.push(fact({
      connectorId: 'marinade',
      label: 'Reward fee',
      value: `${trimNumber(snapshot.rewardFeeBps)} bps`,
      tone: snapshot.rewardFeeBps > 0 ? 'neutral' : 'good',
      checkedAt,
    }));
  }
  if (snapshot.delayedUnstakeCoolingDownSeconds !== undefined) {
    facts.push(fact({
      connectorId: 'marinade',
      label: 'Delayed unstake cooldown',
      value: `${snapshot.delayedUnstakeCoolingDownSeconds} seconds`,
      tone: snapshot.delayedUnstakeCoolingDownSeconds > 0 ? 'neutral' : 'good',
      checkedAt,
    }));
  }
  if (snapshot.validators) {
    facts.push(fact({
      connectorId: 'marinade',
      label: 'Validators',
      value: `${snapshot.validators.length} validators returned`,
      tone: snapshot.validators.length > 0 ? 'good' : 'warn',
      checkedAt,
    }));
  }
  if (snapshot.warnings && snapshot.warnings.length > 0) {
    facts.push(fact({
      connectorId: 'marinade',
      label: 'Marinade warnings',
      value: snapshot.warnings.join('; '),
      tone: 'warn',
      checkedAt,
    }));
  }
  return facts;
}

export function factsFromMarinadeWalletPositions(
  snapshot: MarinadeWalletPositionsResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'marinade',
      label: 'mSOL balance',
      value: `${snapshot.msolBalance} mSOL`,
      tone: positiveString(snapshot.msolBalance) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        walletAddress: snapshot.walletAddress,
        msolMint: snapshot.msolMint,
        msolBalanceRaw: snapshot.msolBalanceRaw,
        estimatedSolValue: snapshot.estimatedSolValue,
        asOfSlot: snapshot.asOfSlot,
      },
    }),
  ];
  facts.push(...factsFromMarinadeStakeAccounts({
    walletAddress: snapshot.walletAddress,
    stakeAccounts: snapshot.nativeStakeAccounts,
  }, checkedAt));
  facts.push(...factsFromMarinadeUnstakeTickets({
    walletAddress: snapshot.walletAddress,
    tickets: snapshot.unstakeTickets,
  }, checkedAt));
  if (snapshot.warnings && snapshot.warnings.length > 0) {
    facts.push(fact({
      connectorId: 'marinade',
      label: 'Position warnings',
      value: snapshot.warnings.join('; '),
      tone: 'warn',
      checkedAt,
    }));
  }
  return facts;
}

export function factsFromMarinadeStakeAccounts(
  input: { walletAddress: string; stakeAccounts: MarinadeStakeAccount[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (input.stakeAccounts.length === 0) {
    return [
      fact({
        connectorId: 'marinade',
        label: 'Native stake accounts',
        value: 'No wallet stake accounts found',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: input.walletAddress },
      }),
    ];
  }
  const delegated = input.stakeAccounts.filter((account) => account.delegated);
  return [
    fact({
      connectorId: 'marinade',
      label: 'Native stake accounts',
      value: `${input.stakeAccounts.length} found · ${delegated.length} delegated`,
      tone: delegated.length > 0 ? 'good' : 'neutral',
      checkedAt,
      detail: {
        walletAddress: input.walletAddress,
        delegatedStakeAccounts: delegated.map((account) => account.stakeAccount),
      },
    }),
    ...input.stakeAccounts.slice(0, 5).map((account) =>
      fact({
        connectorId: 'marinade',
        label: shortAddress(account.stakeAccount),
        value: `${account.solAmount} SOL · ${account.state}`,
        tone: account.state === 'active' ? 'good' : account.state === 'deactivating' ? 'warn' : 'neutral',
        checkedAt,
        detail: {
          stakeAccount: account.stakeAccount,
          lamports: account.lamports,
          validatorVoteAccount: account.validatorVoteAccount,
          activationEpoch: account.activationEpoch,
          deactivationEpoch: account.deactivationEpoch,
        },
      }),
    ),
  ];
}

export function factsFromMarinadeUnstakeTickets(
  input: { walletAddress: string; tickets: MarinadeUnstakeTicket[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (input.tickets.length === 0) {
    return [
      fact({
        connectorId: 'marinade',
        label: 'Unstake tickets',
        value: 'No delayed unstake tickets found',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: input.walletAddress },
      }),
    ];
  }
  const claimable = input.tickets.filter((ticket) => ticket.status === 'claimable');
  return [
    fact({
      connectorId: 'marinade',
      label: 'Unstake tickets',
      value: `${input.tickets.length} found · ${claimable.length} claimable`,
      tone: claimable.length > 0 ? 'good' : 'neutral',
      checkedAt,
      detail: {
        walletAddress: input.walletAddress,
        claimableTickets: claimable.map((ticket) => ticket.ticketAccount),
      },
    }),
    ...input.tickets.slice(0, 5).map((ticket) =>
      fact({
        connectorId: 'marinade',
        label: shortAddress(ticket.ticketAccount),
        value: `${ticket.solAmount ?? ticket.lamports ?? 'unknown'} SOL · ${ticket.status}`,
        tone: ticket.status === 'claimable' ? 'good' : ticket.status === 'pending' ? 'neutral' : 'warn',
        checkedAt,
        detail: {
          ticketAccount: ticket.ticketAccount,
          beneficiary: ticket.beneficiary,
          lamports: ticket.lamports,
          msolAmount: ticket.msolAmount,
          createdEpoch: ticket.createdEpoch,
          claimableAt: ticket.claimableAt,
          reason: ticket.reason,
        },
      }),
    ),
  ];
}

export function factsFromMarinadeQuote(
  quote: MarinadeQuote,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const outputSymbol =
    quote.operation === 'liquid_stake'
      ? 'mSOL'
      : quote.operation === 'claim_delayed_unstake'
        ? 'SOL'
        : 'SOL';
  const output = quote.outputAmount ? `${quote.outputAmount} ${outputSymbol}` : 'No output estimate';
  const facts = [
    fact({
      connectorId: 'marinade',
      label: 'Marinade quote',
      value: `${quote.operation} -> ${output}`,
      tone: output === 'No output estimate' ? 'warn' : 'good',
      checkedAt,
      detail: {
        operation: quote.operation,
        inputAmount: quote.inputAmount,
        inputAmountRaw: quote.inputAmountRaw,
        outputAmount: quote.outputAmount,
        outputAmountRaw: quote.outputAmountRaw,
        minOutputAmount: quote.minOutputAmount,
        minOutputAmountRaw: quote.minOutputAmountRaw,
        feeBps: quote.feeBps,
        price: quote.price,
        route: quote.route,
        raw: redactSecrets(quote.raw ?? {}),
      },
    }),
  ];
  if (quote.route === 'jupiter') {
    facts.push(fact({
      connectorId: 'marinade',
      label: 'Instant unstake route',
      value: 'mSOL exits through Jupiter at approval time',
      tone: 'neutral',
      checkedAt,
    }));
  }
  if (quote.warnings && quote.warnings.length > 0) {
    facts.push(fact({
      connectorId: 'marinade',
      label: 'Quote warnings',
      value: quote.warnings.join('; '),
      tone: 'warn',
      checkedAt,
    }));
  }
  return facts;
}

export function factsFromLuloRates(
  snapshot: LuloRatesSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (snapshot.rows.length === 0) {
    return [
      fact({
        connectorId: 'lulo',
        label: 'Lulo rates',
        value: 'No Lulo rates returned by the API',
        tone: 'warn',
        checkedAt,
      }),
    ];
  }
  return snapshot.rows.map((row) => {
    const label = row.symbol ?? shortMint(row.mintAddress);
    return fact({
      connectorId: 'lulo',
      label: `Lulo ${depositTypeLabel(row.depositType)} · ${label}`,
      value: `${formatPercent(row.apy)} APY${row.tvlUsd ? ` · ${row.tvlUsd} TVL` : ''}${row.liquidityAvailable ? ` · ${row.liquidityAvailable} liquidity` : ''}`,
      tone: rateTone(row.apy),
      checkedAt,
      detail: {
        mintAddress: row.mintAddress,
        depositType: row.depositType,
        ...(row.apyAsOfIso ? { apyAsOfIso: row.apyAsOfIso } : {}),
      },
    });
  });
}

export function factsFromLuloPoolMeta(
  snapshot: LuloPoolMetaSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (snapshot.pools.length === 0) {
    return [
      fact({
        connectorId: 'lulo',
        label: 'Lulo pools',
        value: 'No Lulo pools returned by the API',
        tone: 'warn',
        checkedAt,
      }),
    ];
  }
  return snapshot.pools.map((pool) => {
    const label = pool.symbol ?? shortMint(pool.mintAddress);
    const cooldownTone: ConnectorFactTone =
      typeof pool.cooldownSeconds === 'number' && pool.cooldownSeconds > 0 ? 'warn' : 'neutral';
    const cooldownText =
      typeof pool.cooldownSeconds === 'number' && pool.cooldownSeconds > 0
        ? ` · regular cooldown ${pool.cooldownSeconds}s`
        : '';
    return fact({
      connectorId: 'lulo',
      label: `Lulo pool · ${label}`,
      value: `${pool.supportedDepositTypes.map(depositTypeLabel).join(', ')}${cooldownText}`,
      tone: cooldownTone,
      checkedAt,
      detail: {
        mintAddress: pool.mintAddress,
        programIds: pool.programIds,
        ...(typeof pool.decimals === 'number' ? { decimals: pool.decimals } : {}),
        ...(typeof pool.cooldownSeconds === 'number' ? { cooldownSeconds: pool.cooldownSeconds } : {}),
      },
    });
  });
}

export function factsFromLuloBalances(
  snapshot: LuloWalletBalancesSnapshot | LuloBalancesUnavailable,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if ('balances_unavailable' in snapshot) {
    return [
      fact({
        connectorId: 'lulo',
        label: 'Lulo balances',
        value: snapshot.reason,
        tone: 'warn',
        checkedAt,
      }),
    ];
  }
  if (snapshot.rows.length === 0) {
    return [
      fact({
        connectorId: 'lulo',
        label: 'Lulo balances',
        value: 'No Lulo deposit positions found for this wallet',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: snapshot.walletAddress },
      }),
    ];
  }
  return [
    fact({
      connectorId: 'lulo',
      label: 'Lulo positions',
      value: `${snapshot.rows.length} position${snapshot.rows.length === 1 ? '' : 's'}`,
      tone: 'good',
      checkedAt,
      detail: { walletAddress: snapshot.walletAddress },
    }),
    ...snapshot.rows.map((row) => {
      const label = row.symbol ?? shortMint(row.mintAddress);
      const amountText = row.amountUi ?? row.amountRaw ?? 'unknown amount';
      const earnedText = row.earnedInterestUi ? ` · earned ${row.earnedInterestUi}` : '';
      const pendingCount = row.pendingWithdrawals?.length ?? 0;
      const pendingText = pendingCount > 0 ? ` · ${pendingCount} pending withdrawal${pendingCount === 1 ? '' : 's'}` : '';
      return fact({
        connectorId: 'lulo',
        label: `Lulo ${depositTypeLabel(row.depositType)} · ${label}`,
        value: `${amountText} supplied${earnedText}${pendingText}`,
        tone: pendingCount > 0 ? 'warn' : positiveString(row.earnedInterestUi) ? 'good' : 'neutral',
        checkedAt,
        detail: {
          mintAddress: row.mintAddress,
          depositType: row.depositType,
          ...(typeof row.apy === 'number' ? { apy: row.apy } : {}),
          ...(row.withdrawableUi ? { withdrawableUi: row.withdrawableUi } : {}),
          ...(row.pendingWithdrawals && row.pendingWithdrawals.length > 0
            ? { pendingWithdrawals: row.pendingWithdrawals }
            : {}),
        },
      });
    }),
  ];
}

export function factsFromSanctumLstList(
  snapshot: SanctumLstListSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    fact({
      connectorId: 'sanctum',
      label: 'Sanctum LST catalog',
      value: `${snapshot.rows.length} supported LST${snapshot.rows.length === 1 ? '' : 's'}`,
      tone: snapshot.rows.length > 0 ? 'good' : 'warn',
      checkedAt,
      detail: {
        includeDisabled: snapshot.includeDisabled,
        apiBaseHost: snapshot.apiBaseHost,
      },
    }),
    ...snapshot.rows.slice(0, 8).map((row) => fact({
      connectorId: 'sanctum',
      label: `LST ${row.symbol}`,
      value: `${row.enabled ? 'enabled' : 'disabled'}${row.apy !== undefined ? ` · ${formatPercent(row.apy)} APY` : ''}${row.liquidity ? ` · ${row.liquidity} liquidity` : ''}`,
      tone: row.enabled ? 'good' : 'warn',
      checkedAt,
      detail: {
        mint: row.mint,
        ...(row.decimals !== undefined ? { decimals: row.decimals } : {}),
        ...(row.poolAddress ? { poolAddress: row.poolAddress } : {}),
      },
    })),
  ];
}

export function factsFromSanctumLstSnapshot(
  snapshot: SanctumLstSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts = [
    fact({
      connectorId: 'sanctum',
      label: `Sanctum LST ${snapshot.symbol}`,
      value: `${snapshot.enabled ? 'enabled' : 'disabled'}${snapshot.solValue ? ` · ${snapshot.solValue} SOL value` : ''}`,
      tone: snapshot.enabled ? 'good' : 'warn',
      checkedAt,
      detail: {
        mint: snapshot.mint,
        name: snapshot.name,
        decimals: snapshot.decimals,
        poolAddress: snapshot.poolAddress,
        stakePoolProgramId: snapshot.stakePoolProgramId,
      },
    }),
  ];
  if (snapshot.apy !== undefined) {
    facts.push(fact({
      connectorId: 'sanctum',
      label: 'LST APY',
      value: formatPercent(snapshot.apy),
      tone: rateTone(snapshot.apy),
      checkedAt,
    }));
  }
  if (snapshot.apys && snapshot.apys.length > 0) {
    const latest = snapshot.apys[0];
    facts.push(fact({
      connectorId: 'sanctum',
      label: 'Recent APY sample',
      value: latest ? formatPercent(latest.apy) : 'Not reported',
      tone: latest ? rateTone(latest.apy) : 'neutral',
      checkedAt,
      ...(latest ? { detail: { ...latest } } : {}),
    }));
  }
  return facts;
}

export function factsFromSanctumInfinityPoolSnapshot(
  snapshot: Record<string, unknown>,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const count = finiteNumber(snapshot.supportedLstCount) ?? 0;
  const facts = [
    fact({
      connectorId: 'sanctum',
      label: 'Sanctum Infinity',
      value: `${count} supported LST${count === 1 ? '' : 's'} · INF mint ${shortAddress(stringValue(snapshot.infMint))}`,
      tone: count > 0 ? 'good' : 'warn',
      checkedAt,
      detail: {
        programId: snapshot.programId,
        infMint: snapshot.infMint,
        programIds: snapshot.programIds,
      },
    }),
  ];
  if (typeof snapshot.caveat === 'string') {
    facts.push(fact({
      connectorId: 'sanctum',
      label: 'Infinity caveat',
      value: snapshot.caveat,
      tone: 'warn',
      checkedAt,
    }));
  }
  return facts;
}

export function factsFromSanctumWalletPositions(
  snapshot: SanctumWalletPositionsSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (snapshot.rows.length === 0) {
    return [
      fact({
        connectorId: 'sanctum',
        label: 'Sanctum positions',
        value: 'No Sanctum LST or INF token positions found for this wallet',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: snapshot.walletAddress },
      }),
    ];
  }
  return [
    fact({
      connectorId: 'sanctum',
      label: 'Sanctum positions',
      value: `${snapshot.totals.lstPositions} LST · ${snapshot.totals.infPositions} INF`,
      tone: 'good',
      checkedAt,
      detail: { walletAddress: snapshot.walletAddress },
    }),
    ...snapshot.rows.map((row) => fact({
      connectorId: 'sanctum',
      label: `${row.symbol} balance`,
      value: `${row.amountUi} ${row.symbol}`,
      tone: positiveString(row.amountUi) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        mint: row.mint,
        account: row.account,
        amountRaw: row.amountRaw,
        isInf: row.isInf,
        isLst: row.isLst,
      },
    })),
  ];
}

export function factsFromSanctumQuote(
  quote: SanctumTokenOrder,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts = [
    fact({
      connectorId: 'sanctum',
      label: 'Sanctum quote',
      value: `Expected output ${quote.outputAmountRaw}`,
      tone: positiveString(quote.outputAmountRaw) ? 'good' : 'warn',
      checkedAt,
      detail: {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inputAmountRaw: quote.inputAmountRaw,
        outputAmountRaw: quote.outputAmountRaw,
        routeSources: quote.routeSources,
        hasTransaction: quote.hasTransaction,
      },
    }),
    fact({
      connectorId: 'sanctum',
      label: 'Sanctum route',
      value: quote.routeSources.join(', ') || 'Not reported',
      tone: quote.routeSources.some((source) => source.toLowerCase().includes('jup')) ? 'warn' : 'good',
      checkedAt,
    }),
  ];
  if (quote.maxObservedFeeBps !== undefined) {
    facts.push(fact({
      connectorId: 'sanctum',
      label: 'Observed fee cap',
      value: `${quote.maxObservedFeeBps} bps`,
      tone: quote.maxObservedFeeBps > 100 ? 'warn' : 'neutral',
      checkedAt,
    }));
  }
  if (quote.warnings.length > 0) {
    facts.push(fact({
      connectorId: 'sanctum',
      label: 'Sanctum warnings',
      value: quote.warnings.join('; '),
      tone: 'warn',
      checkedAt,
    }));
  }
  return facts;
}

export function factsFromWormholeSupportedRoutes(
  snapshot: WormholeSupportedRoutesSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const supported = snapshot.routes.filter((route) => route.supported);
  const manual = supported.filter((route) => route.manualRedemptionRequired);
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'wormhole',
      label: 'Wormhole routes',
      value: `${supported.length} supported route${supported.length === 1 ? '' : 's'} from ${snapshot.sourceChain}${snapshot.destinationChain ? ` to ${snapshot.destinationChain}` : ''}`,
      tone: supported.length > 0 ? 'good' : 'warn',
      checkedAt,
      detail: {
        wormholeNetwork: snapshot.wormholeNetwork,
        ...(snapshot.mintAddress !== undefined && { mintAddress: snapshot.mintAddress }),
        ...(snapshot.routeType !== undefined && { routeType: snapshot.routeType }),
      },
    }),
  ];
  if (manual.length > 0) {
    facts.push(fact({
      connectorId: 'wormhole',
      label: 'Manual redemption',
      value: `${manual.length} route${manual.length === 1 ? '' : 's'} may require destination-chain redemption`,
      tone: 'warn',
      checkedAt,
    }));
  }
  for (const route of supported.slice(0, 5)) {
    facts.push(fact({
      connectorId: 'wormhole',
      label: `${route.destinationChain} ${route.routeType}`,
      value: `${route.mode}${route.etaSeconds ? ` · ETA ${route.etaSeconds}s` : ''}${route.bridgeFee ? ` · fee ${route.bridgeFee}` : ''}`,
      tone: route.manualRedemptionRequired ? 'warn' : 'good',
      checkedAt,
      detail: {
        sourceChain: route.sourceChain,
        destinationChain: route.destinationChain,
        routeType: route.routeType,
        prepareSupported: route.prepareSupported,
        relayerSupported: route.relayerSupported,
        ...(route.destinationToken !== undefined && { destinationToken: route.destinationToken }),
      },
    }));
  }
  return facts;
}

export function factsFromWormholeTokenSnapshot(
  snapshot: WormholeTokenSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'wormhole',
      label: 'Wormhole token',
      value: `${snapshot.symbol ?? shortWormholeAddress(snapshot.mintAddress)} on ${snapshot.sourceChain}${typeof snapshot.decimals === 'number' ? ` · ${snapshot.decimals} decimals` : ''}`,
      tone: snapshot.supportedRoutes.length > 0 ? 'good' : 'warn',
      checkedAt,
      detail: {
        mintAddress: snapshot.mintAddress,
        wormholeNetwork: snapshot.wormholeNetwork,
        wrappedAssetCount: snapshot.wrappedAssets?.length ?? 0,
      },
    }),
    fact({
      connectorId: 'wormhole',
      label: 'Supported routes',
      value: `${snapshot.supportedRoutes.length} route${snapshot.supportedRoutes.length === 1 ? '' : 's'}`,
      tone: snapshot.supportedRoutes.length > 0 ? 'good' : 'warn',
      checkedAt,
    }),
  ];
  for (const wrapped of snapshot.wrappedAssets?.slice(0, 5) ?? []) {
    facts.push(fact({
      connectorId: 'wormhole',
      label: `${wrapped.chain} asset`,
      value: shortWormholeAddress(wrapped.address),
      tone: wrapped.tokenBridgeWrapped === false ? 'neutral' : 'good',
      checkedAt,
    }));
  }
  for (const warning of snapshot.warnings ?? []) {
    facts.push(fact({ connectorId: 'wormhole', label: 'Warning', value: warning, tone: 'warn', checkedAt }));
  }
  return facts;
}

export function factsFromWormholeQuote(
  quote: WormholeQuoteSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'wormhole',
      label: 'Wormhole quote',
      value: `${quote.amount} ${shortWormholeAddress(quote.sourceMint)} from ${quote.sourceChain} to ${quote.destinationChain}`,
      tone: 'good',
      checkedAt,
      detail: {
        routeType: quote.routeType,
        mode: quote.mode,
        destinationAddress: quote.destinationAddress,
        ...(quote.destinationToken !== undefined && { destinationToken: quote.destinationToken }),
        ...(quote.quoteId !== undefined && { quoteId: quote.quoteId }),
        ...(quote.expiresAtIso !== undefined && { expiresAtIso: quote.expiresAtIso }),
      },
    }),
    fact({
      connectorId: 'wormhole',
      label: 'Estimated destination amount',
      value: quote.estimatedDestinationAmount ?? 'unknown',
      tone: quote.estimatedDestinationAmount ? 'good' : 'neutral',
      checkedAt,
    }),
    fact({
      connectorId: 'wormhole',
      label: 'Bridge fee',
      value: quote.bridgeFee ? `${quote.bridgeFee}${quote.bridgeFeeToken ? ` ${quote.bridgeFeeToken}` : ''}` : 'unknown',
      tone: quote.bridgeFee ? 'neutral' : 'warn',
      checkedAt,
    }),
    fact({
      connectorId: 'wormhole',
      label: 'Redemption',
      value: quote.manualRedemptionRequired ? 'Manual redemption may be required' : 'Relayer/automatic route indicated',
      tone: quote.manualRedemptionRequired ? 'warn' : 'good',
      checkedAt,
    }),
  ];
  for (const warning of quote.warnings ?? []) {
    facts.push(fact({ connectorId: 'wormhole', label: 'Warning', value: warning, tone: 'warn', checkedAt }));
  }
  return facts;
}

export function factsFromWormholeTransferStatus(
  status: WormholeTransferStatus,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'wormhole',
      label: 'Wormhole transfer status',
      value: status.state,
      tone: status.state === 'failed' ? 'fail' : status.redeemed ? 'good' : status.vaaAvailable ? 'warn' : 'neutral',
      checkedAt,
      detail: {
        sourceChain: status.sourceChain,
        ...(status.destinationChain !== undefined && { destinationChain: status.destinationChain }),
        ...(status.sourceTxid !== undefined && { sourceTxid: status.sourceTxid }),
        ...(status.destinationTxid !== undefined && { destinationTxid: status.destinationTxid }),
        ...(status.sequence !== undefined && { sequence: status.sequence }),
        ...(status.transferId !== undefined && { transferId: status.transferId }),
        nextAction: status.nextAction ?? null,
        solanaExecutable: status.solanaExecutable,
      },
    }),
    fact({
      connectorId: 'wormhole',
      label: 'VAA',
      value: status.vaaAvailable ? 'available' : 'not available yet',
      tone: status.vaaAvailable ? 'good' : 'warn',
      checkedAt,
    }),
  ];
  if (status.error) {
    facts.push(fact({ connectorId: 'wormhole', label: 'Transfer error', value: status.error, tone: 'fail', checkedAt }));
  }
  for (const warning of status.warnings ?? []) {
    facts.push(fact({ connectorId: 'wormhole', label: 'Warning', value: warning, tone: 'warn', checkedAt }));
  }
  return facts;
}

export function factsFromWormholeWalletBridgeExposure(
  exposure: WormholeWalletBridgeExposure,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'wormhole',
      label: 'Wormhole bridge exposure',
      value: `${exposure.pendingTransfers.length} pending transfer${exposure.pendingTransfers.length === 1 ? '' : 's'}`,
      tone: exposure.pendingTransfers.length > 0 ? 'warn' : 'good',
      checkedAt,
      detail: {
        walletAddress: exposure.walletAddress,
        sourceChain: exposure.sourceChain,
        recentTransferCount: exposure.recentTransfers?.length ?? 0,
      },
    }),
  ];
  for (const transfer of exposure.pendingTransfers.slice(0, 5)) {
    facts.push(fact({
      connectorId: 'wormhole',
      label: transfer.transferId ?? transfer.sourceTxid ?? 'Pending transfer',
      value: `${transfer.state}${transfer.destinationChain ? ` · ${transfer.destinationChain}` : ''}`,
      tone: transfer.vaaAvailable ? 'warn' : 'neutral',
      checkedAt,
    }));
  }
  for (const warning of exposure.warnings ?? []) {
    facts.push(fact({ connectorId: 'wormhole', label: 'Warning', value: warning, tone: 'warn', checkedAt }));
  }
  return facts;
}

export function factsFromMagicedenApiHealth(
  snapshot: MagicedenApiHealthSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const apiTone: ConnectorFactTone = snapshot.apiOperational ? 'good' : 'fail';
  const tradingTone: ConnectorFactTone = snapshot.tradingOperational
    ? 'good'
    : snapshot.apiOperational
      ? 'warn'
      : 'fail';
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'magiceden',
      label: 'API health',
      value: snapshot.apiOperational ? 'Reads operational' : 'Reads degraded',
      tone: apiTone,
      checkedAt,
      detail: { baseHost: snapshot.baseHost, checkedAtIso: snapshot.checkedAtIso },
    }),
    fact({
      connectorId: 'magiceden',
      label: 'Trading endpoints',
      value: snapshot.tradingOperational
        ? 'Operational; write actions allowed'
        : 'Degraded; write actions will be refused',
      tone: tradingTone,
      checkedAt,
      detail: snapshot.degradedReasons.length > 0 ? { reasons: snapshot.degradedReasons } : undefined,
    }),
  ];
  if (snapshot.rateLimit?.limited) {
    facts.push(
      fact({
        connectorId: 'magiceden',
        label: 'Rate limit',
        value: snapshot.rateLimit.retryAfterSeconds
          ? `Limited; retry after ${snapshot.rateLimit.retryAfterSeconds}s`
          : 'Limited',
        tone: 'warn',
        checkedAt,
      }),
    );
  }
  for (const warning of snapshot.warnings) {
    facts.push(
      fact({ connectorId: 'magiceden', label: 'Warning', value: warning, tone: 'warn', checkedAt }),
    );
  }
  return facts;
}

export function factsFromMagicedenCollectionSnapshot(
  input: MagicedenCollectionSnapshotInput,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const { summary, listings, bids } = input;
  const label = summary.name ?? summary.collectionSymbol ?? summary.collectionId ?? 'collection';
  const floor =
    summary.floorPriceLamports && /^\d+$/.test(summary.floorPriceLamports)
      ? `${lamportsToSol(summary.floorPriceLamports)} SOL`
      : 'unknown';
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'magiceden',
      label: `Collection ${label}`,
      value: `${floor} floor${typeof summary.listedCount === 'number' ? ` · ${summary.listedCount} listed` : ''}${typeof summary.totalSupply === 'number' ? ` of ${summary.totalSupply}` : ''}`,
      tone: summary.verified === false ? 'warn' : 'good',
      checkedAt,
      detail: {
        ...(summary.collectionSymbol ? { collectionSymbol: summary.collectionSymbol } : {}),
        ...(summary.collectionId ? { collectionId: summary.collectionId } : {}),
        ...(typeof summary.royaltyBps === 'number' ? { royaltyBps: summary.royaltyBps } : {}),
        verified: summary.verified ?? null,
        apiBaseHost: summary.apiBaseHost,
        asOfIso: summary.asOfIso,
      },
    }),
  ];
  if (typeof summary.royaltyBps !== 'number') {
    facts.push(
      fact({
        connectorId: 'magiceden',
        label: 'Royalty',
        value: 'Royalty data unavailable from API',
        tone: 'warn',
        checkedAt,
      }),
    );
  }
  if (listings) {
    facts.push(
      fact({
        connectorId: 'magiceden',
        label: 'Listings',
        value: `${listings.rows.length} active listing${listings.rows.length === 1 ? '' : 's'}`,
        tone: listings.rows.length > 0 ? 'good' : 'neutral',
        checkedAt,
      }),
    );
  }
  if (bids) {
    const topBid = bids.rows[0];
    facts.push(
      fact({
        connectorId: 'magiceden',
        label: 'Top bid',
        value: topBid ? `${topBid.bidPriceSol} SOL` : 'No active bids',
        tone: topBid ? 'good' : 'neutral',
        checkedAt,
      }),
    );
  }
  return facts;
}

export function factsFromMagicedenCollectionListings(
  snapshot: MagicedenCollectionListings,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (snapshot.rows.length === 0) {
    return [
      fact({
        connectorId: 'magiceden',
        label: 'Listings',
        value: 'No active listings returned by the API',
        tone: 'warn',
        checkedAt,
      }),
    ];
  }
  return snapshot.rows.slice(0, 10).map((row) =>
    fact({
      connectorId: 'magiceden',
      label: row.tokenName ?? shortMagicedenMint(row.mintAddress),
      value: `${row.priceSol} SOL${row.seller ? ` · seller ${shortMagicedenMint(row.seller)}` : ''}`,
      tone: 'good',
      checkedAt,
      detail: {
        mintAddress: row.mintAddress,
        ...(row.listingId ? { listingId: row.listingId } : {}),
        ...(row.auctionHouse ? { auctionHouse: row.auctionHouse } : {}),
      },
    }),
  );
}

export function factsFromMagicedenCollectionBids(
  snapshot: MagicedenCollectionBids,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (snapshot.rows.length === 0) {
    return [
      fact({
        connectorId: 'magiceden',
        label: 'Bids',
        value: 'No active bids returned by the API',
        tone: 'neutral',
        checkedAt,
      }),
    ];
  }
  return snapshot.rows.slice(0, 10).map((row, idx) =>
    fact({
      connectorId: 'magiceden',
      label: idx === 0 ? 'Top bid' : `Bid #${idx + 1}`,
      value: `${row.bidPriceSol} SOL${row.buyer ? ` · buyer ${shortMagicedenMint(row.buyer)}` : ''}`,
      tone: idx === 0 ? 'good' : 'neutral',
      checkedAt,
      detail: {
        ...(row.bidId ? { bidId: row.bidId } : {}),
        ...(row.mintAddress ? { mintAddress: row.mintAddress } : {}),
      },
    }),
  );
}

export function factsFromMagicedenRecentActivity(
  snapshot: MagicedenRecentActivity,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (snapshot.rows.length === 0) {
    return [
      fact({
        connectorId: 'magiceden',
        label: 'Recent activity',
        value: 'No recent activity returned by the API',
        tone: 'neutral',
        checkedAt,
      }),
    ];
  }
  return snapshot.rows.slice(0, 10).map((row) =>
    fact({
      connectorId: 'magiceden',
      label: row.activityType,
      value: row.priceSol
        ? `${row.priceSol} SOL${row.mintAddress ? ` · ${shortMagicedenMint(row.mintAddress)}` : ''}`
        : row.mintAddress
          ? shortMagicedenMint(row.mintAddress)
          : 'event',
      tone: 'neutral',
      checkedAt,
      detail: {
        ...(row.signature ? { signature: row.signature } : {}),
        ...(typeof row.blockTime === 'number' ? { blockTime: row.blockTime } : {}),
      },
    }),
  );
}

export function factsFromMagicedenWalletNfts(
  snapshot: MagicedenWalletNftsSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (snapshot.rows.length === 0) {
    return [
      fact({
        connectorId: 'magiceden',
        label: 'Wallet NFTs',
        value: snapshot.listedOnly ? 'No listed NFTs found for this wallet' : 'No NFTs found for this wallet',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: snapshot.walletAddress },
      }),
    ];
  }
  const listed = snapshot.rows.filter((row) => row.listed);
  return [
    fact({
      connectorId: 'magiceden',
      label: 'Wallet NFTs',
      value: `${snapshot.rows.length} NFT${snapshot.rows.length === 1 ? '' : 's'} · ${listed.length} listed`,
      tone: 'good',
      checkedAt,
      detail: { walletAddress: snapshot.walletAddress },
    }),
    ...listed.slice(0, 10).map((row) =>
      fact({
        connectorId: 'magiceden',
        label: row.tokenName ?? shortMagicedenMint(row.mintAddress),
        value: `Listed for ${row.listingPriceSol ?? 'unknown'} SOL`,
        tone: 'good',
        checkedAt,
        detail: {
          mintAddress: row.mintAddress,
          ...(row.listingId ? { listingId: row.listingId } : {}),
        },
      }),
    ),
  ];
}

export function factsFromMagicedenNftDetail(
  detail: MagicedenNftDetail,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'magiceden',
      label: detail.tokenName ?? shortMagicedenMint(detail.mintAddress),
      value: detail.collectionName ?? detail.collectionSymbol ?? 'NFT',
      tone: detail.verifiedCollection === false ? 'warn' : 'good',
      checkedAt,
      detail: {
        mintAddress: detail.mintAddress,
        ...(detail.owner ? { owner: detail.owner } : {}),
        ...(typeof detail.royaltyBps === 'number' ? { royaltyBps: detail.royaltyBps } : {}),
      },
    }),
  ];
  if (detail.listing) {
    facts.push(
      fact({
        connectorId: 'magiceden',
        label: 'Current listing',
        value: `${detail.listing.priceSol} SOL${detail.listing.seller ? ` · seller ${shortMagicedenMint(detail.listing.seller)}` : ''}`,
        tone: 'good',
        checkedAt,
      }),
    );
  } else {
    facts.push(
      fact({
        connectorId: 'magiceden',
        label: 'Current listing',
        value: 'Not listed',
        tone: 'neutral',
        checkedAt,
      }),
    );
  }
  if (detail.topBid) {
    facts.push(
      fact({
        connectorId: 'magiceden',
        label: 'Top bid',
        value: `${detail.topBid.bidPriceSol} SOL`,
        tone: 'good',
        checkedAt,
      }),
    );
  }
  if (detail.lastSaleSol) {
    facts.push(
      fact({
        connectorId: 'magiceden',
        label: 'Last sale',
        value: `${detail.lastSaleSol} SOL`,
        tone: 'neutral',
        checkedAt,
      }),
    );
  }
  return facts;
}

export function factsFromTensorCollectionSnapshot(
  input: TensorCollectionSnapshotInput,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const { collection, listings, bids } = input;
  const label = collection.name ?? shortTensorAddress(collection.collectionId);
  const floor = collection.floorPriceSol
    ? `${collection.floorPriceSol} SOL`
    : collection.floorPriceLamports
      ? `${tensorSolFromLamports(collection.floorPriceLamports)} SOL`
      : 'unknown';
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'tensor',
      label: `Tensor collection ${label}`,
      value: `${floor} floor${typeof collection.listedCount === 'number' ? ` · ${collection.listedCount} listed` : ''}${typeof collection.totalSupply === 'number' ? ` of ${collection.totalSupply}` : ''}`,
      tone: collection.verified === false ? 'warn' : 'good',
      checkedAt,
      detail: {
        collectionId: collection.collectionId,
        verified: collection.verified ?? null,
        ...(collection.volume24hSol !== undefined && { volume24hSol: collection.volume24hSol }),
        ...(collection.numBids !== undefined && { numBids: collection.numBids }),
        ...(collection.asOf !== undefined && { asOf: collection.asOf }),
      },
    }),
  ];
  if (collection.topBidPriceSol) {
    facts.push(
      fact({
        connectorId: 'tensor',
        label: 'Top collection bid',
        value: `${collection.topBidPriceSol} SOL`,
        tone: 'good',
        checkedAt,
      }),
    );
  }
  if (collection.verified === false) {
    facts.push(
      fact({
        connectorId: 'tensor',
        label: 'Verification',
        value: 'Collection is not verified by Tensor',
        tone: 'warn',
        checkedAt,
      }),
    );
  }
  if (listings) {
    facts.push(
      fact({
        connectorId: 'tensor',
        label: 'Listings',
        value: `${listings.length} active listing${listings.length === 1 ? '' : 's'}`,
        tone: listings.length > 0 ? 'good' : 'neutral',
        checkedAt,
      }),
    );
  }
  if (bids) {
    const topBid = bids[0];
    facts.push(
      fact({
        connectorId: 'tensor',
        label: 'Bids',
        value: topBid ? `${topBid.bidPriceSol} SOL top bid · ${bids.length} active` : 'No active bids',
        tone: topBid ? 'good' : 'neutral',
        checkedAt,
      }),
    );
  }
  if (collection.warnings && collection.warnings.length > 0) {
    for (const warning of collection.warnings) {
      facts.push(
        fact({ connectorId: 'tensor', label: 'Warning', value: warning, tone: 'warn', checkedAt }),
      );
    }
  }
  return facts;
}

export function factsFromTensorCollectionListings(
  snapshot: { collectionId: string; listings: TensorListing[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (snapshot.listings.length === 0) {
    return [
      fact({
        connectorId: 'tensor',
        label: 'Tensor listings',
        value: 'No active listings on Tensor for this collection',
        tone: 'neutral',
        checkedAt,
        detail: { collectionId: snapshot.collectionId },
      }),
    ];
  }
  return snapshot.listings.slice(0, 10).map((row, idx) =>
    fact({
      connectorId: 'tensor',
      label: idx === 0 ? 'Cheapest listing' : `Listing #${idx + 1}`,
      value: `${row.priceSol} SOL${row.seller ? ` · seller ${shortTensorAddress(row.seller)}` : ''}${row.compressed ? ' · compressed' : ''}`,
      tone: idx === 0 ? 'good' : 'neutral',
      checkedAt,
      detail: {
        ...(row.mintAddress !== undefined && { mintAddress: row.mintAddress }),
        ...(row.assetId !== undefined && { assetId: row.assetId }),
        ...(row.listingId !== undefined && { listingId: row.listingId }),
        marketplace: row.marketplace,
        compressed: row.compressed,
      },
    }),
  );
}

export function factsFromTensorCollectionBids(
  snapshot: { collectionId: string; bids: TensorBid[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (snapshot.bids.length === 0) {
    return [
      fact({
        connectorId: 'tensor',
        label: 'Tensor bids',
        value: 'No active bids on Tensor for this collection',
        tone: 'neutral',
        checkedAt,
        detail: { collectionId: snapshot.collectionId },
      }),
    ];
  }
  return snapshot.bids.slice(0, 10).map((row, idx) =>
    fact({
      connectorId: 'tensor',
      label: idx === 0 ? 'Top bid' : `Bid #${idx + 1}`,
      value: `${row.bidPriceSol} SOL${row.bidder ? ` · bidder ${shortTensorAddress(row.bidder)}` : ''}${row.quantity && row.quantity > 1 ? ` · qty ${row.quantity}` : ''}`,
      tone: idx === 0 ? 'good' : 'neutral',
      checkedAt,
      detail: {
        bidId: row.bidId,
        ...(row.collectionId !== undefined && { collectionId: row.collectionId }),
        ...(row.escrowLamports !== undefined && { escrowLamports: row.escrowLamports }),
      },
    }),
  );
}

export function factsFromTensorRecentSales(
  snapshot: { collectionId: string; sales: TensorSale[] },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (snapshot.sales.length === 0) {
    return [
      fact({
        connectorId: 'tensor',
        label: 'Recent sales',
        value: 'No recent sales returned for this collection',
        tone: 'neutral',
        checkedAt,
        detail: { collectionId: snapshot.collectionId },
      }),
    ];
  }
  return snapshot.sales.slice(0, 10).map((row, idx) =>
    fact({
      connectorId: 'tensor',
      label: idx === 0 ? 'Most recent sale' : `Sale #${idx + 1}`,
      value: row.priceSol
        ? `${row.priceSol} SOL${row.marketplace ? ` · ${row.marketplace}` : ''}`
        : row.mintAddress
          ? shortTensorAddress(row.mintAddress)
          : 'sale',
      tone: 'neutral',
      checkedAt,
      detail: {
        ...(row.signature !== undefined && { signature: row.signature }),
        ...(row.mintAddress !== undefined && { mintAddress: row.mintAddress }),
        ...(typeof row.blockTime === 'number' && { blockTime: row.blockTime }),
      },
    }),
  );
}

export function factsFromTensorWalletNfts(
  snapshot: TensorWalletNftsResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (snapshot.nfts.length === 0) {
    return [
      fact({
        connectorId: 'tensor',
        label: 'Tensor wallet NFTs',
        value: 'No Tensor-tracked NFTs found for this wallet',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: snapshot.walletAddress },
      }),
    ];
  }
  const listed = snapshot.nfts.filter((nft) => nft.listed);
  const compressed = snapshot.nfts.filter((nft) => nft.compressed);
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'tensor',
      label: 'Tensor wallet NFTs',
      value: `${snapshot.nfts.length} NFTs · ${listed.length} listed · ${compressed.length} compressed`,
      tone: 'good',
      checkedAt,
      detail: {
        walletAddress: snapshot.walletAddress,
        ...(snapshot.collectionId !== undefined && { collectionId: snapshot.collectionId }),
      },
    }),
  ];
  for (const nft of listed.slice(0, 10)) {
    const id = nft.mintAddress ?? nft.assetId ?? 'unknown';
    facts.push(
      fact({
        connectorId: 'tensor',
        label: nft.collectionName ?? shortTensorAddress(id),
        value: `Listed for ${nft.listingPriceSol ?? 'unknown'} SOL${nft.marketplace ? ` · ${nft.marketplace}` : ''}${nft.compressed ? ' · compressed' : ''}`,
        tone: 'good',
        checkedAt,
        detail: {
          ...(nft.mintAddress !== undefined && { mintAddress: nft.mintAddress }),
          ...(nft.assetId !== undefined && { assetId: nft.assetId }),
          compressed: nft.compressed,
        },
      }),
    );
  }
  return facts;
}

export function factsFromTensorNftDetail(
  detail: TensorNftDetail,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const id = detail.mintAddress ?? detail.assetId ?? 'unknown';
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'tensor',
      label: detail.name ?? shortTensorAddress(id),
      value: detail.collectionName ?? detail.collectionId ?? 'Tensor NFT',
      tone: 'good',
      checkedAt,
      detail: {
        ...(detail.mintAddress !== undefined && { mintAddress: detail.mintAddress }),
        ...(detail.assetId !== undefined && { assetId: detail.assetId }),
        ...(detail.owner !== undefined && { owner: detail.owner }),
        compressed: detail.compressed,
        ...(detail.frozen !== undefined && { frozen: detail.frozen }),
      },
    }),
  ];
  if (detail.topListing) {
    facts.push(
      fact({
        connectorId: 'tensor',
        label: 'Current listing',
        value: `${detail.topListing.priceSol} SOL${detail.topListing.seller ? ` · seller ${shortTensorAddress(detail.topListing.seller)}` : ''}`,
        tone: 'good',
        checkedAt,
      }),
    );
  } else {
    facts.push(
      fact({
        connectorId: 'tensor',
        label: 'Current listing',
        value: 'Not listed on Tensor',
        tone: 'neutral',
        checkedAt,
      }),
    );
  }
  if (detail.topBids && detail.topBids.length > 0) {
    const top = detail.topBids[0]!;
    facts.push(
      fact({
        connectorId: 'tensor',
        label: 'Top bid',
        value: `${top.bidPriceSol} SOL`,
        tone: 'good',
        checkedAt,
      }),
    );
  }
  if (detail.warnings) {
    for (const warning of detail.warnings) {
      facts.push(
        fact({ connectorId: 'tensor', label: 'Warning', value: warning, tone: 'warn', checkedAt }),
      );
    }
  }
  return facts;
}

export function factsFromTensorWalletMarketplaceExposure(
  snapshot: TensorWalletExposure,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const facts: ConnectorFact[] = [
    fact({
      connectorId: 'tensor',
      label: 'Tensor marketplace exposure',
      value: `${snapshot.openListings.length} open listings · ${snapshot.openBids.length} open bids · ${snapshot.ownedCollections.length} collections`,
      tone: 'good',
      checkedAt,
      detail: {
        walletAddress: snapshot.walletAddress,
        ...(snapshot.marginBalanceSol !== undefined && { marginBalanceSol: snapshot.marginBalanceSol }),
        ...(snapshot.asOf !== undefined && { asOf: snapshot.asOf }),
      },
    }),
  ];
  if (snapshot.marginBalanceSol) {
    facts.push(
      fact({
        connectorId: 'tensor',
        label: 'Margin escrow',
        value: `${snapshot.marginBalanceSol} SOL`,
        tone: 'neutral',
        checkedAt,
      }),
    );
  }
  for (const collection of snapshot.ownedCollections.slice(0, 5)) {
    facts.push(
      fact({
        connectorId: 'tensor',
        label: collection.name ?? shortTensorAddress(collection.collectionId),
        value: `${collection.count} owned${collection.floorPriceSol ? ` · floor ${collection.floorPriceSol} SOL` : ''}`,
        tone: 'good',
        checkedAt,
        detail: { collectionId: collection.collectionId },
      }),
    );
  }
  return facts;
}

export function factsFromPythPriceFeed(
  result: PythPriceFeedSnapshotResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const { snapshot } = result;
  const label = snapshot.symbol ?? snapshot.displayName ?? shortFeedId(snapshot.priceFeedId);
  return [
    fact({
      connectorId: 'pyth',
      label: `Pyth ${label}`,
      value: pythPriceValue(snapshot.priceUi, snapshot.confidenceUi, snapshot.publishTime),
      tone: pythPriceTone(snapshot.status, snapshot.confidenceBps, snapshot.maxAgeSeconds),
      checkedAt,
      detail: {
        priceFeedId: snapshot.priceFeedId,
        priceFeedIdHex: snapshot.priceFeedIdHex,
        priceRaw: snapshot.priceRaw,
        confidenceRaw: snapshot.confidenceRaw,
        confidenceBps: snapshot.confidenceBps,
        exponent: snapshot.exponent,
        publishTime: snapshot.publishTime,
        hermesUrlHost: snapshot.hermesUrlHost,
        ema: snapshot.ema,
      },
    }),
    fact({
      connectorId: 'pyth',
      label: 'Pyth confidence',
      value: formatConfidenceBps(snapshot.confidenceBps, snapshot.confidenceUi),
      tone: pythConfidenceTone(snapshot.confidenceBps),
      checkedAt,
    }),
    fact({
      connectorId: 'pyth',
      label: 'Pyth freshness',
      value: `${snapshot.ageSeconds}s old (max ${snapshot.maxAgeSeconds}s)`,
      tone: snapshot.status === 'stale' ? 'warn' : 'good',
      checkedAt,
    }),
  ];
}

export function factsFromPythBatch(
  batch: PythPriceFeedsBatchResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const totals = batch.totals;
  const summary = fact({
    connectorId: 'pyth',
    label: 'Pyth batch',
    value: `${totals.requested} requested · ${totals.fresh} fresh · ${totals.stale} stale · ${totals.missing} missing`,
    tone: totals.missing > 0 ? 'fail' : totals.stale > 0 ? 'warn' : 'good',
    checkedAt,
    detail: { hermesUrlHost: batch.hermesUrlHost },
  });
  const rows: ConnectorFact[] = batch.results.map((entry) => {
    if (entry.status === 'missing') {
      return fact({
        connectorId: 'pyth',
        label: `Pyth ${shortFeedId(entry.priceFeedId)}`,
        value: entry.reason,
        tone: 'fail',
        checkedAt,
        detail: { priceFeedId: entry.priceFeedId, priceFeedIdHex: entry.priceFeedIdHex },
      });
    }
    const snapshot = entry.snapshot;
    const label = snapshot.symbol ?? snapshot.displayName ?? shortFeedId(snapshot.priceFeedId);
    return fact({
      connectorId: 'pyth',
      label: `Pyth ${label}`,
      value: pythPriceValue(snapshot.priceUi, snapshot.confidenceUi, snapshot.publishTime),
      tone: pythPriceTone(snapshot.status, snapshot.confidenceBps, snapshot.maxAgeSeconds),
      checkedAt,
      detail: {
        priceFeedId: snapshot.priceFeedId,
        priceFeedIdHex: snapshot.priceFeedIdHex,
        confidenceBps: snapshot.confidenceBps,
        publishTime: snapshot.publishTime,
        status: snapshot.status,
      },
    });
  });
  return [summary, ...rows];
}

export function factsFromPythFeedSearch(
  result: PythFeedSearchResult,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (result.results.length === 0) {
    return [
      fact({
        connectorId: 'pyth',
        label: 'Pyth feed search',
        value: `No Pyth feeds matched "${result.query}".`,
        tone: 'warn',
        checkedAt,
        detail: { assetType: result.assetType, hermesUrlHost: result.hermesUrlHost },
      }),
    ];
  }
  const summary = fact({
    connectorId: 'pyth',
    label: 'Pyth feed search',
    value: `${result.results.length} match${result.results.length === 1 ? '' : 'es'} for "${result.query}"`,
    tone: 'good',
    checkedAt,
    detail: { assetType: result.assetType, hermesUrlHost: result.hermesUrlHost },
  });
  const rows = result.results.map((entry) =>
    fact({
      connectorId: 'pyth',
      label: entry.symbol ?? entry.displayName ?? shortFeedId(entry.priceFeedId),
      value: entry.description ?? entry.displayName ?? entry.priceFeedIdHex,
      tone: 'neutral',
      checkedAt,
      detail: {
        priceFeedId: entry.priceFeedId,
        priceFeedIdHex: entry.priceFeedIdHex,
        assetType: entry.assetType,
        base: entry.base,
        quoteCurrency: entry.quoteCurrency,
        source: entry.source,
      },
    }),
  );
  return [summary, ...rows];
}

export function factsFromPythOnchainAccount(
  snapshot: PythOnchainSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const label = `Pyth on-chain ${shortFeedId(snapshot.priceFeedId)}`;
  if (snapshot.evidenceSource === 'sdk_missing') {
    return [
      fact({
        connectorId: 'pyth',
        label,
        value: snapshot.reason ?? 'Pyth Solana receiver SDK is not installed.',
        tone: 'warn',
        checkedAt,
        detail: {
          priceFeedId: snapshot.priceFeedId,
          priceFeedIdHex: snapshot.priceFeedIdHex,
          evidenceSource: snapshot.evidenceSource,
          hermesUrlHost: snapshot.hermesUrlHost,
        },
      }),
    ];
  }
  if (snapshot.exists === 'no') {
    return [
      fact({
        connectorId: 'pyth',
        label,
        value: snapshot.reason ?? 'No on-chain price update account exists for this feed yet.',
        tone: 'warn',
        checkedAt,
        detail: {
          priceFeedId: snapshot.priceFeedId,
          priceFeedIdHex: snapshot.priceFeedIdHex,
          priceAccount: snapshot.priceAccount,
          hermesUrlHost: snapshot.hermesUrlHost,
        },
      }),
    ];
  }
  return [
    fact({
      connectorId: 'pyth',
      label,
      value: snapshot.priceAccount ? `Account ${snapshot.priceAccount}` : 'On-chain account present',
      tone: 'good',
      checkedAt,
      detail: {
        priceFeedId: snapshot.priceFeedId,
        priceFeedIdHex: snapshot.priceFeedIdHex,
        priceAccount: snapshot.priceAccount,
        ownerProgram: snapshot.ownerProgram,
        lamports: snapshot.lamports,
        rentEpoch: snapshot.rentEpoch,
        evidenceSource: snapshot.evidenceSource,
        hermesUrlHost: snapshot.hermesUrlHost,
      },
    }),
  ];
}

export function factsFromPythEvidence(
  evidence: PythOracleEvidence,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const label = `Pyth oracle ${evidence.symbol ?? evidence.displayName ?? shortFeedId(evidence.priceFeedId)}`;
  const value = evidenceValue(evidence);
  const tone = evidenceTone(evidence.status);
  return [
    fact({
      connectorId: 'pyth',
      label,
      value,
      tone,
      checkedAt,
      detail: {
        priceFeedId: evidence.priceFeedId,
        priceFeedIdHex: evidence.priceFeedIdHex,
        priceUi: evidence.priceUi,
        confidenceUi: evidence.confidenceUi,
        confidenceBps: evidence.confidenceBps,
        publishTime: evidence.publishTime,
        ageSeconds: evidence.ageSeconds,
        maxAgeSeconds: evidence.maxAgeSeconds,
        maxConfidenceBps: evidence.maxConfidenceBps,
        consumerProtocol: evidence.consumerProtocol,
        hermesUrlHost: evidence.hermesUrlHost,
        status: evidence.status,
        reason: evidence.reason,
      },
    }),
  ];
}

function pythPriceValue(priceUi: string, confidenceUi: string, publishTime: number): string {
  const iso = new Date(publishTime * 1000).toISOString();
  return `$${priceUi} ± ${confidenceUi} at ${iso}`;
}

function pythPriceTone(
  status: 'fresh' | 'stale' | 'missing',
  confidenceBps: number | null,
  maxAgeSeconds: number,
): ConnectorFactTone {
  void maxAgeSeconds;
  if (status === 'missing') return 'fail';
  if (status === 'stale') return 'warn';
  if (typeof confidenceBps === 'number' && confidenceBps > 500) return 'warn';
  return 'good';
}

function pythConfidenceTone(confidenceBps: number | null): ConnectorFactTone {
  if (typeof confidenceBps !== 'number') return 'neutral';
  if (confidenceBps > 500) return 'fail';
  if (confidenceBps > 200) return 'warn';
  return 'good';
}

function formatConfidenceBps(confidenceBps: number | null, fallback: string): string {
  if (typeof confidenceBps === 'number' && Number.isFinite(confidenceBps)) {
    return `${confidenceBps.toFixed(2)} bps`;
  }
  return fallback ? `± ${fallback}` : 'Not reported';
}

function evidenceValue(evidence: PythOracleEvidence): string {
  if (evidence.status === 'fresh' || evidence.status === 'stale' || evidence.status === 'wide_confidence') {
    const price = evidence.priceUi ?? 'unknown';
    const conf = evidence.confidenceUi ?? '?';
    const age = typeof evidence.ageSeconds === 'number' ? `${evidence.ageSeconds}s` : '?';
    return `${evidence.status} · $${price} ± ${conf} · age ${age}`;
  }
  return evidence.reason ?? evidence.status;
}

function evidenceTone(status: PythOracleEvidence['status']): ConnectorFactTone {
  switch (status) {
    case 'fresh':
      return 'good';
    case 'stale':
    case 'wide_confidence':
      return 'warn';
    case 'missing':
    case 'api_unavailable':
      return 'fail';
    default:
      return 'neutral';
  }
}

function lamportsToSol(value: string): string {
  if (!/^\d+$/.test(value)) return value;
  const lamports = BigInt(value);
  const whole = lamports / 1_000_000_000n;
  const fraction = lamports % 1_000_000_000n;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}.${fractionText}`;
}

function saveHealthTone(value: number): ConnectorFactTone {
  if (!Number.isFinite(value)) return 'good';
  if (value < 1.05) return 'fail';
  if (value < 1.25) return 'warn';
  return 'good';
}

function formatSaveHealthFactor(value: number): string {
  if (!Number.isFinite(value)) return 'no debt';
  return value.toFixed(3);
}

function orcaPositionFact(position: OrcaPosition, checkedAt: string): ConnectorFact {
  const rangeState = position.inRange === true
    ? 'in range'
    : position.inRange === false
      ? 'out of range'
      : 'range not reported';
  return fact({
    connectorId: 'orca',
    label: `Position ${shortAddress(position.positionMint)}`,
    value: `${rangeState} · ticks ${position.tickLowerIndex} to ${position.tickUpperIndex} · liquidity ${position.liquidity}`,
    tone: position.inRange === false ? 'warn' : positiveString(position.liquidity) ? 'good' : 'neutral',
    checkedAt,
    detail: {
      positionMint: position.positionMint,
      positionAddress: position.positionAddress,
      owner: position.owner,
      tokenAccount: position.tokenAccount,
      whirlpoolAddress: position.whirlpoolAddress,
      tokenMintA: position.tokenMintA,
      tokenMintB: position.tokenMintB,
      currentTickIndex: position.currentTickIndex,
      asOfSlot: position.asOfSlot,
    },
  });
}

function raydiumPositionFact(position: RaydiumPosition, checkedAt: string): ConnectorFact {
  if (position.positionType === 'farm') {
    const amount = position.depositedAmount ?? position.lpAmount ?? 'unknown amount';
    return fact({
      connectorId: 'raydium',
      label: `Farm ${shortAddress(position.farmId ?? position.lpMint ?? 'Raydium')}`,
      value: `${amount} farm LP`,
      tone: positiveString(position.depositedAmount ?? position.lpAmount) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        farmId: position.farmId,
        lpMint: position.lpMint,
        rewardsOwed: position.rewardsOwed,
        asOfSlot: position.asOfSlot,
      },
    });
  }
  if (position.positionType === 'cpmm') {
    const amount = position.lpAmount ?? position.liquidity ?? '0';
    return fact({
      connectorId: 'raydium',
      label: `CPMM LP ${shortAddress(position.poolId ?? position.lpMint ?? 'Raydium')}`,
      value: `${amount} LP liquidity`,
      tone: positiveString(amount) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        poolId: position.poolId,
        lpMint: position.lpMint,
        rawAmount: position.rawAmount,
        tokenAmounts: position.tokenAmounts,
        asOfSlot: position.asOfSlot,
      },
    });
  }
  const rangeState = position.inRange === true
    ? 'in range'
    : position.inRange === false
      ? 'out of range'
      : 'range not reported';
  const rangeText = position.tickLower !== undefined && position.tickUpper !== undefined
    ? `ticks ${position.tickLower} to ${position.tickUpper}`
    : 'tick range not reported';
  const liquidity = position.liquidity ?? '0';
  return fact({
    connectorId: 'raydium',
    label: `CLMM position ${shortAddress(position.positionMint ?? position.positionAddress ?? 'Raydium')}`,
    value: `${rangeState} · ${rangeText} · liquidity ${liquidity}`,
    tone: position.inRange === false ? 'warn' : positiveString(liquidity) ? 'good' : 'neutral',
    checkedAt,
    detail: {
      poolId: position.poolId,
      positionMint: position.positionMint,
      positionAddress: position.positionAddress,
      currentTick: position.currentTick,
      tokenAmounts: position.tokenAmounts,
      asOfSlot: position.asOfSlot,
    },
  });
}

function meteoraPositionFact(position: MeteoraPosition, checkedAt: string): ConnectorFact {
  const rangeState = position.inRange === true
    ? 'in range'
    : position.inRange === false
      ? 'out of range'
      : 'range not reported';
  return fact({
    connectorId: 'meteora',
    label: `Position ${shortAddress(position.positionAddress)}`,
    value: `${rangeState} · bins ${position.lowerBinId} to ${position.upperBinId} · liquidity ${position.liquidity}`,
    tone: position.inRange === false ? 'warn' : positiveString(position.liquidity) ? 'good' : 'neutral',
    checkedAt,
    detail: {
      positionAddress: position.positionAddress,
      owner: position.owner,
      poolAddress: position.poolAddress,
      tokenMintX: position.tokenMintX,
      tokenMintY: position.tokenMintY,
      activeBinId: position.activeBinId,
      asOfSlot: position.asOfSlot,
    },
  });
}

function formatTokenAmounts(amounts: Array<{ mint: string; amount?: string; symbol?: string }>): string {
  if (amounts.length === 0) return 'None reported';
  return amounts
    .map((amount) => `${amount.amount ?? '0'} ${amount.symbol ?? shortAddress(amount.mint)}`)
    .join(' · ');
}

function tokenAmountsPositive(amounts: Array<{ amount?: string }>): boolean {
  return amounts.some((amount) => positiveString(amount.amount));
}

function marginfiTokenLabel(snapshot: MarginfiBankSnapshot): string {
  return snapshot.tokenSymbol ?? shortAddress(snapshot.bankMint);
}

function marginfiPositionValue(position: MarginfiPosition): string {
  const parts = [
    `${position.suppliedAmount} supplied`,
    `${position.borrowedAmount} borrowed`,
  ];
  if (position.suppliedUsd || position.borrowedUsd) {
    parts.push(`${position.suppliedUsd ?? '0'} supplied USD`);
    parts.push(`${position.borrowedUsd ?? '0'} borrowed USD`);
  }
  return parts.join(' · ');
}

function marginfiHealthValue(health: MarginfiHealthPreview['before']): string {
  return `${health.assets} assets · ${health.liabilities} liabilities · ${health.netValue} net · ${health.healthRatioText}`;
}

function marginfiHealthTone(health: MarginfiHealthPreview['before']): ConnectorFactTone {
  if (!health.healthy) return 'fail';
  if (health.healthRatio !== null && health.healthRatio < 1.2) return 'warn';
  return 'good';
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'Not reported';
  return `${trimNumber(value)}%`;
}

function rateTone(value: number): ConnectorFactTone {
  if (!Number.isFinite(value)) return 'neutral';
  return value > 0 ? 'good' : 'neutral';
}

function utilizationTone(value: number): ConnectorFactTone {
  if (!Number.isFinite(value)) return 'neutral';
  if (value >= 98) return 'fail';
  if (value >= 90) return 'warn';
  return 'good';
}

function slippageTone(value: unknown): ConnectorFactTone {
  const parsed = finiteNumber(value);
  if (parsed === undefined) return 'neutral';
  if (parsed > 300) return 'fail';
  if (parsed > 100) return 'warn';
  return 'good';
}

function priceImpactTone(value: unknown): ConnectorFactTone {
  const parsed = finiteNumber(value);
  if (parsed === undefined) return 'neutral';
  if (parsed > 0.05) return 'fail';
  if (parsed > 0.01) return 'warn';
  return 'good';
}

function positiveString(value: string | undefined): boolean {
  if (value === undefined) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function formatRawAmountString(value: string | undefined, decimals = 9): string {
  if (!value) return '0';
  let raw: bigint;
  try {
    raw = BigInt(value);
  } catch {
    return value;
  }
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/\.?0+$/, '');
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeFactRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
