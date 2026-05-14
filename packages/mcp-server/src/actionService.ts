import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';

import {
  ProtocolError,
  SolanaSigningClient,
  type Cluster,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';

import { lifetimeSpendEstimate } from '@solana-agent-wallet-adapter/workflow';

import {
  AdapterError,
  actionForKind,
  assertSupportedCluster,
  requireAdapter,
  type DAppAdapter,
  type DAppAdapterContext,
} from './adapters/index.js';
import type {
  KaminoDepositInput,
  KaminoWithdrawInput,
} from './adapters/kamino/index.js';
import type {
  MeteoraAddLiquidityPrepareInput,
  MeteoraClaimPrepareInput,
  MeteoraClosePositionPrepareInput,
  MeteoraRemoveLiquidityPrepareInput,
} from './adapters/meteora/index.js';
import type {
  OrcaCollectPrepareInput,
  OrcaDecreaseLiquidityPrepareInput,
  OrcaIncreaseLiquidityPrepareInput,
} from './adapters/orca/index.js';
import type {
  RaydiumAddLiquidityPrepareInput,
  RaydiumCollectFeesPrepareInput,
  RaydiumFarmPrepareInput,
  RaydiumRemoveLiquidityPrepareInput,
} from './adapters/raydium/index.js';
import type { MarginfiActionInput } from './adapters/marginfi/index.js';
import { marginfiMinHealthRatio } from './adapters/marginfi/actions.js';
import type { Project0PrepareInput } from './adapters/project0/index.js';
import { project0MinHealthRatio } from './adapters/project0/actions.js';
import type {
  JupiterLendBorrowActionInput,
  JupiterLendEarnActionInput,
  JupiterRecurringCancelOrderInput,
  JupiterRecurringCreateTimeOrderInput,
  JupiterRecurringOrderState,
  JupiterRecurringPriceOrderInput,
  JupiterRecurringQuoteInput,
  JupiterTriggerCancelOrderInput,
  JupiterTriggerChallengeType,
  JupiterTriggerEditOrderInput,
  JupiterTriggerOcoOrderInput,
  JupiterTriggerOrderState,
  JupiterTriggerOtocoOrderInput,
  JupiterTriggerRegisterVaultInput,
  JupiterTriggerSingleOrderInput,
  JupiterTriggerWithdrawOrderFundsInput,
} from './adapters/jupiter/index.js';
import type {
  DriftVaultCancelWithdrawInput,
  DriftVaultCompleteWithdrawInput,
  DriftVaultDepositInput,
  DriftVaultRequestWithdrawInput,
} from './adapters/drift/index.js';
import type {
  LuloCompleteWithdrawInput,
  LuloDepositInput,
  LuloWithdrawInput,
} from './adapters/lulo/index.js';
import type {
  MagicedenBidPrepareInput,
  MagicedenBuyPrepareInput,
  MagicedenCancelBidPrepareInput,
  MagicedenCancelListingPrepareInput,
  MagicedenListPrepareInput,
} from './adapters/magiceden/index.js';
import type {
  SanctumAddInfinityLiquidityInput,
  SanctumRemoveInfinityLiquidityInput,
  SanctumStakeSolToLstInput,
  SanctumSwapLstInput,
  SanctumUnstakeLstToSolInput,
} from './adapters/sanctum/index.js';
import { SANCTUM_INF_MINT } from './adapters/sanctum/constants.js';
import type {
  SaveBorrowInput,
  SaveDepositInput,
  SaveHealthPreviewInput,
  SaveHealthPreviewResult,
  SaveRepayInput,
  SaveWithdrawInput,
} from './adapters/save/index.js';
import type {
  JitoClaimDepositReceiptInput,
  JitoDepositStakeAccountInput,
  JitoQuoteInput,
  JitoStakeSolInput,
  JitoUnstakeJitosolInput,
  JitoWithdrawSolInput,
} from './adapters/jito/index.js';
import type {
  MarinadeClaimDelayedUnstakeInput,
  MarinadeDelayedUnstakeInput,
  MarinadeLiquidStakeInput,
  MarinadeLiquidUnstakeInput,
  MarinadeQuoteReadInput,
} from './adapters/marinade/index.js';
import type {
  SquadsCreateTransferProposalInput,
  SquadsExecuteProposalInput,
  SquadsVoteInput,
} from './adapters/squads/index.js';
import type {
  TensorBidPrepareInput,
  TensorBuyPrepareInput,
  TensorCancelBidPrepareInput,
  TensorCancelListingPrepareInput,
  TensorListPrepareInput,
  TensorSweepPrepareInput,
} from './adapters/tensor/index.js';
import type {
  RealmsCastVoteInput,
  RealmsDepositGovernanceTokensInput,
  RealmsRelinquishVoteInput,
  RealmsWithdrawGovernanceTokensInput,
} from './adapters/realms/index.js';
import type {
  GetPythOnchainAccountInput,
  GetPythOracleEvidenceInput,
  GetPythPriceFeedInput,
  GetPythPriceFeedsBatchInput,
  PythFeedSearchInput,
  PythPostPriceUpdateInput,
} from './adapters/pyth/index.js';
import type {
  WormholeQuoteReadInput,
  WormholeRecoverOrResumeInput,
  WormholeRedeemInput,
  WormholeSupportedRoutesInput,
  WormholeTokenSnapshotInput,
  WormholeTransferInput,
  WormholeTransferStatusInput,
  WormholeWalletBridgeExposureInput,
} from './adapters/wormhole/index.js';
import { assertMaxAmount, formatRawAmount, parseDecimalAmount } from './amounts.js';
import {
  buildPerpsStatus,
  getJupiterPerpsCustodySnapshot,
  getJupiterPerpsPoolSnapshot,
  getJupiterPerpsPositionSnapshot,
  getJupiterPrice,
  getJupiterPriceBatch,
  getJupiterRecentTokens,
  getJupiterTokenCategory,
  getJupiterTokenRiskEvidence,
  getJupiterTokenSearch,
  getJupiterTokensByTag,
  getPredictionEventDetail,
  getPredictionEventMarkets,
  getPredictionEvents,
  getPredictionHistory,
  getPredictionMarketDetail,
  getPredictionOrderbook,
  getPredictionOrders,
  getPredictionOrderStatus,
  getPredictionPositions,
  getPredictionVaultInfo,
  jupiterApiHost,
  jupiterFetchJson,
  searchPredictionEvents,
  type EventDetailInput as JupiterPredictionEventDetailInput,
  type EventMarketsInput as JupiterPredictionEventMarketsInput,
  type GetEventsInput as JupiterPredictionEventsInput,
  type JupiterPerpsCustodySnapshotInput,
  type JupiterPerpsPoolSnapshotInput,
  type JupiterPerpsPositionSnapshotInput,
  type JupiterPerpsStatusInput,
  type JupiterPriceBatchInput,
  type JupiterPriceInput,
  type JupiterTokenByTagInput,
  type JupiterTokenCategoryInput,
  type JupiterTokenRecentInput,
  type JupiterTokenRiskEvidence,
  type JupiterTokenRiskEvidenceInput,
  type JupiterTokenSearchInput,
  type MarketDetailInput as JupiterPredictionMarketDetailInput,
  type OrderbookInput as JupiterPredictionOrderbookInput,
  type OrdersInput as JupiterPredictionOrdersInput,
  type SearchEventsInput as JupiterPredictionSearchEventsInput,
} from './adapters/jupiter/index.js';
import {
  fetchBlinkMetadata,
  prepareBlinkAction as prepareBlinkActionRequest,
  type BlinkActionMetadata,
} from './blinkActions.js';
import {
  readSolanaHeliusHistory,
  readSolanaMarketData,
  readSolanaTokenLists,
  readSolanaTokenSafetyEvidence,
  type SolanaHeliusHistoryInput,
  type SolanaMarketDataInput,
  type SolanaTokenListsInput,
  type SolanaTokenSafetyEvidenceInput,
} from './marketInstruments.js';
import {
  DEFAULT_TOKEN_REGISTRY,
  USDC_MINT,
  WSOL_MINT,
  requireMainnetEnabled,
  type AgentWalletConfig,
  type RecurringPolicyConfig,
  type TokenLimitConfig,
} from './config.js';
import type {
  AddRecurringPaymentInput,
  ActionReceipt,
  PreparedAction,
  PreparedActionKind,
  PreparedActionStore,
  PreparedActionTxStatus,
  RecurringCadence,
  RecurringPayment,
  RecurringPaymentView,
} from './preparedActions.js';
import { TERMINAL_PREPARED_ACTION_STATUSES } from './preparedActions.js';
import {
  prepareTransactionForApproval,
  type PreparedTransactionPayload,
} from './preparedActionTransactionBuilder.js';
import {
  CONNECTOR_APPROVAL_BOUNDARY,
  connectorCapabilityView,
  getConnector,
  listConnectorCapabilities,
  type ConnectorCapability,
  type ConnectorRegistryEntry,
} from './connectorRegistry.js';
import {
  factsFromJupiterOrderPreview,
  factsFromJupiterPerpsStatus,
  factsFromJupiterPredictionEventDetail,
  factsFromJupiterPredictionEvents,
  factsFromJupiterPredictionHistory,
  factsFromJupiterPredictionMarketDetail,
  factsFromJupiterPredictionOrderStatus,
  factsFromJupiterPredictionOrderbook,
  factsFromJupiterPredictionOrders,
  factsFromJupiterPredictionPositions,
  factsFromJupiterPredictionVaultInfo,
  factsFromJupiterPrice,
  factsFromJupiterPriceBatch,
  factsFromJupiterRecurringRead,
  factsFromJupiterTokenRead,
  factsFromJupiterTokenRiskEvidence,
  factsFromJupiterTriggerRead,
  factsFromJupiterLendBorrowHealth,
  factsFromJupiterLendBorrowPositions,
  factsFromJupiterLendBorrowVaults,
  factsFromJupiterLendEarnEarnings,
  factsFromJupiterLendEarnPositions,
  factsFromJupiterLendEarnTokens,
  factsFromJitoDepositReceipts,
  factsFromJitoQuote,
  factsFromJitoStakeAccounts,
  factsFromJitoStakePoolSnapshot,
  factsFromJitoWalletPositions,
  factsFromMarinadeQuote,
  factsFromMarinadeStakeAccounts,
  factsFromMarinadeStateSnapshot,
  factsFromMarinadeUnstakeTickets,
  factsFromMarinadeWalletPositions,
  factsFromKaminoEarningsProof,
  factsFromKaminoPositions,
  factsFromKaminoReserveSnapshot,
  factsFromMarginfiAccountDetail,
  factsFromMarginfiAccountSummaries,
  factsFromMarginfiBankSnapshot,
  factsFromMarginfiHealthPreview,
  factsFromProject0AccountDetail,
  factsFromProject0Banks,
  factsFromProject0HealthPreview,
  factsFromProject0Strategies,
  factsFromProject0Wallet,
  factsFromLuloBalances,
  factsFromLuloPoolMeta,
  factsFromLuloRates,
  factsFromMagicedenApiHealth,
  factsFromMagicedenCollectionBids,
  factsFromMagicedenCollectionListings,
  factsFromMagicedenCollectionSnapshot,
  factsFromMagicedenNftDetail,
  factsFromMagicedenRecentActivity,
  factsFromMagicedenTopCollections,
  factsFromMagicedenWalletNfts,
  factsFromMeteoraPoolSnapshot,
  factsFromMeteoraPositionDetail,
  factsFromMeteoraPositions,
  factsFromOrcaPositionDetail,
  factsFromOrcaPositions,
  factsFromOrcaWhirlpoolSnapshot,
  factsFromRaydiumPoolSnapshot,
  factsFromRaydiumPositionDetail,
  factsFromRaydiumPositions,
  factsFromSaveHealthPreview,
  factsFromSaveMarketSnapshot,
  factsFromSaveObligation,
  factsFromSaveReserveSnapshot,
  factsFromTensorCollectionBids,
  factsFromTensorCollectionListings,
  factsFromTensorCollectionSnapshot,
  factsFromTensorNftDetail,
  factsFromTensorRecentSales,
  factsFromTensorSupportedCollections,
  factsFromTensorWalletMarketplaceExposure,
  factsFromTensorWalletNfts,
  factsFromPythPriceFeed,
  factsFromPythBatch,
  factsFromPythFeedSearch,
  factsFromPythOnchainAccount,
  factsFromPythEvidence,
  factsFromSanctumInfinityPoolSnapshot,
  factsFromSanctumLstList,
  factsFromSanctumLstSnapshot,
  factsFromSanctumQuote,
  factsFromSanctumWalletPositions,
  factsFromWormholeQuote,
  factsFromWormholeSupportedRoutes,
  factsFromWormholeTokenSnapshot,
  factsFromWormholeTransferStatus,
  factsFromWormholeWalletBridgeExposure,
  fact,
  type ConnectorFact,
  type ConnectorFactReadInput,
} from './connectorFacts.js';
import { redactSecrets } from './trace.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export interface AgentWalletActionServiceOptions {
  backend: WalletBackend;
  config: AgentWalletConfig;
  preparedActions?: PreparedActionStore;
  connection?: Connection;
  client?: SolanaSigningClient;
}

export interface SwapInput {
  inputToken?: string;
  outputToken?: string;
  amount: string;
  slippageBps?: number;
  minOutputAmount?: string;
}

export interface SwapOrderInput extends SwapInput {
  taker?: string;
}

export interface PrepareTransferSolInput {
  recipient: string;
  amountSol: string;
  dueAt?: string;
  note?: string;
}

export interface PrepareTransferSplInput {
  token: string;
  recipient: string;
  amount: string;
  dueAt?: string;
  note?: string;
}

export interface PrepareSwapInput extends SwapInput {
  captureQuoteSnapshot?: boolean;
  dueAt?: string;
  note?: string;
}

export interface PrepareBlinkActionInput {
  connector?: string;
  protocol?: string;
  operation?: string;
  blinkUrl: string;
  account?: string;
  parameters?: Record<string, string>;
  expectedAmount?: string;
  expectedToken?: string;
  expectedRecipient?: string;
  position?: string;
  note?: string;
  dueAt?: string;
}

export interface RecurringConnectorTemplateInput {
  connectorId: string;
  actionType: string;
  subActionId?: string;
  params: Record<string, string>;
  blinkUrl?: string;
}

export interface RecurringPaymentInput {
  status?: 'active' | 'paused';
  actionKind?: 'transfer' | 'swap' | 'connector' | 'blink';
  token?: string;
  inputToken?: string;
  outputToken?: string;
  recipient?: string;
  amount?: string;
  cadence?: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
  slippageBps?: number;
  note?: string;
  expiresAt?: string;
  notifications?: { inApp?: boolean; webhookUrl?: string };
  connectorActionTemplate?: RecurringConnectorTemplateInput;
  metadata?: Record<string, unknown>;
}

export interface UpdateRecurringPaymentInput extends RecurringPaymentInput {
  recurringId: string;
}

export class AgentWalletActionService {
  private readonly backend: WalletBackend;
  private readonly config: AgentWalletConfig;
  private readonly preparedActions?: PreparedActionStore;
  private readonly connection: Connection;
  private readonly client: SolanaSigningClient;

  constructor(options: AgentWalletActionServiceOptions) {
    this.backend = options.backend;
    this.config = options.config;
    this.preparedActions = options.preparedActions;
    this.connection = options.connection ?? new Connection(options.config.rpcUrl, 'confirmed');
    this.client = options.client ?? new SolanaSigningClient({ backend: options.backend });
  }

  async walletStatus(): Promise<Record<string, unknown>> {
    const caps = await this.backend.capabilities();
    return {
      connected: Boolean(caps.address),
      address: caps.address ?? null,
      cluster: this.config.cluster,
      rpcUrl: this.config.rpcUrl,
      mainnetEnabled: this.config.mainnet.enabled,
      caps: this.config.mainnet,
      tokens: this.config.tokens,
    };
  }

  async health(): Promise<Record<string, unknown>> {
    const caps = await this.backend.capabilities().catch(() => null);
    return {
      walletConnected: Boolean(caps?.address),
      walletAddress: caps?.address ?? null,
      cluster: this.config.cluster,
      rpcUrl: this.config.rpcUrl,
      rpcWritable: await checkRpc(this.config.rpcUrl),
      mainnetEnabled: this.config.mainnet.enabled,
      capsEnabled: Boolean(this.config.mainnet.enabled),
      safetyCaps: this.config.mainnet,
      allowlistedTokens: this.config.tokens,
      preparedActionStorePath: this.preparedActions?.getStoragePath?.() ?? null,
    };
  }

  async balances(): Promise<Record<string, unknown>> {
    const address = await this.backend.getAddress();
    const owner = new PublicKey(address);
    const lamports = await this.connection.getBalance(owner, 'confirmed');
    return {
      address,
      cluster: this.config.cluster,
      sol: formatRawAmount(BigInt(lamports), 9),
      lamports: lamports.toString(),
      tokens: await readConfiguredTokenBalances(this.connection, owner, this.config),
    };
  }

  async portfolioSummary(): Promise<Record<string, unknown>> {
    const address = await this.backend.getAddress();
    const owner = new PublicKey(address);
    const lamports = await this.connection.getBalance(owner, 'confirmed');
    const configuredTokens = await readConfiguredTokenBalances(this.connection, owner, this.config);
    const parsedTokens = await this.connection
      .getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, 'confirmed')
      .catch(() => ({ value: [] }));
    const configuredMints = new Set(this.config.tokens.map((token) => token.mint));
    const unknownTokenAccounts = parsedTokens.value
      .map((entry) => {
        const parsed = entry.account.data.parsed as {
          info?: {
            mint?: string;
            tokenAmount?: { uiAmountString?: string; amount?: string; decimals?: number };
          };
        };
        return {
          account: entry.pubkey.toBase58(),
          mint: parsed.info?.mint ?? '',
          amount: parsed.info?.tokenAmount?.uiAmountString ?? '0',
          rawAmount: parsed.info?.tokenAmount?.amount ?? '0',
          decimals: parsed.info?.tokenAmount?.decimals ?? 0,
        };
      })
      .filter((token) => token.mint && !configuredMints.has(token.mint));
    const recentSignatures = await this.connection
      .getSignaturesForAddress(owner, { limit: 5 }, 'confirmed')
      .catch(() => []);
    return {
      address,
      cluster: this.config.cluster,
      sol: formatRawAmount(BigInt(lamports), 9),
      lamports: lamports.toString(),
      configuredTokens,
      unknownTokenAccounts,
      recentSignatures: recentSignatures.map((signature) => ({
        signature: signature.signature,
        slot: signature.slot,
        err: signature.err,
        blockTime: signature.blockTime,
      })),
      safetyCaps: this.config.mainnet,
    };
  }

  async prepareTransferSol(input: PrepareTransferSolInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    parseDecimalAmount(input.amountSol, 9, 'SOL transfer amount');
    const from = await this.backend.getAddress();
    const to = new PublicKey(input.recipient).toBase58();
    await this.enforceRecipientCap(to, 'SOL', input.amountSol);
    const action = await this.store().addAction({
      kind: 'transfer_sol',
      walletAddress: from,
      cluster: this.config.cluster,
      summary: `Transfer ${input.amountSol} SOL to ${to}`,
      params: { recipient: to, amountSol: input.amountSol },
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    });
    return { preparedAction: action };
  }

  async prepareTransferSpl(input: PrepareTransferSplInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const tokenConfig = await resolveToken(this.config, this.connection, input.token);
    parseDecimalAmount(input.amount, tokenConfig.decimals, `${tokenConfig.symbol} amount`);
    const from = await this.backend.getAddress();
    const to = new PublicKey(input.recipient).toBase58();
    await this.enforceRecipientCap(to, tokenConfig.symbol, input.amount);
    const action = await this.store().addAction({
      kind: 'transfer_spl',
      walletAddress: from,
      cluster: this.config.cluster,
      summary: `Transfer ${input.amount} ${tokenConfig.symbol} to ${to}`,
      params: { token: tokenConfig.requestToken, recipient: to, amount: input.amount },
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    });
    return { preparedAction: action };
  }

  private async enforceRecipientCap(recipient: string, token: string, amount: string): Promise<void> {
    const config = this.config.recipients?.[recipient];
    if (!config) return;
    const lifetimeMax = config.lifetimeMax?.[token];
    const perMonthMax = config.perMonthMax?.[token];
    if (!lifetimeMax && !perMonthMax) return;

    const receipts = await this.store().listReceipts();
    const matchingApproved = receipts.filter(
      (receipt) =>
        receipt.status === 'approved' &&
        typeof receipt.recipient === 'string' &&
        receipt.recipient === recipient &&
        typeof receipt.token === 'string' &&
        receipt.token === token &&
        typeof receipt.amount === 'string',
    );
    if (lifetimeMax) {
      const lifetimeSpend = matchingApproved.reduce(
        (sum, receipt) => sum + Number(receipt.amount ?? '0'),
        0,
      );
      const proposedTotal = lifetimeSpend + Number(amount);
      if (Number.isFinite(proposedTotal) && proposedTotal > Number(lifetimeMax)) {
        const label = config.label ?? recipient;
        throw new ProtocolError(
          'invalid_request',
          `Per-recipient lifetime cap exceeded for ${label}: already spent ${lifetimeSpend} ${token}, lifetime cap is ${lifetimeMax} ${token}.`,
        );
      }
    }
    if (perMonthMax) {
      const since = monthWindowStart();
      const monthSpend = matchingApproved
        .filter((receipt) => receipt.completedAt >= since)
        .reduce((sum, receipt) => sum + Number(receipt.amount ?? '0'), 0);
      const proposedTotal = monthSpend + Number(amount);
      if (Number.isFinite(proposedTotal) && proposedTotal > Number(perMonthMax)) {
        const label = config.label ?? recipient;
        throw new ProtocolError(
          'invalid_request',
          `Per-recipient monthly cap exceeded for ${label}: already spent ${monthSpend} ${token} this month, monthly cap is ${perMonthMax} ${token}.`,
        );
      }
    }
  }

  async prepareKaminoDeposit(input: KaminoDepositInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('kamino');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'deposit');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareKaminoWithdraw(input: KaminoWithdrawInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('kamino');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'withdraw');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareMeteoraClaimFees(input: MeteoraClaimPrepareInput): Promise<Record<string, unknown>> {
    return this.prepareMeteoraAction('claim_fees', input);
  }

  async prepareMeteoraClaimRewards(input: MeteoraClaimPrepareInput): Promise<Record<string, unknown>> {
    return this.prepareMeteoraAction('claim_rewards', input);
  }

  async prepareMeteoraAddLiquidity(input: MeteoraAddLiquidityPrepareInput): Promise<Record<string, unknown>> {
    return this.prepareMeteoraAction('add_liquidity', input);
  }

  async prepareMeteoraRemoveLiquidity(input: MeteoraRemoveLiquidityPrepareInput): Promise<Record<string, unknown>> {
    return this.prepareMeteoraAction('remove_liquidity', input);
  }

  async prepareMeteoraClosePosition(input: MeteoraClosePositionPrepareInput): Promise<Record<string, unknown>> {
    return this.prepareMeteoraAction('close_position', input);
  }

  private async prepareMeteoraAction(
    operation: 'claim_fees' | 'claim_rewards' | 'add_liquidity' | 'remove_liquidity' | 'close_position',
    input: MeteoraClaimPrepareInput | MeteoraAddLiquidityPrepareInput | MeteoraRemoveLiquidityPrepareInput | MeteoraClosePositionPrepareInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('meteora');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, operation);
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareOrcaIncreaseLiquidity(input: OrcaIncreaseLiquidityPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('orca');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'increase_liquidity');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareOrcaDecreaseLiquidity(input: OrcaDecreaseLiquidityPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('orca');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'decrease_liquidity');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareOrcaCollectFees(input: OrcaCollectPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('orca');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'collect_fees');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareOrcaCollectRewards(input: OrcaCollectPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('orca');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'collect_rewards');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareRaydiumAddLiquidity(input: RaydiumAddLiquidityPrepareInput): Promise<Record<string, unknown>> {
    return this.prepareRaydiumAction('add_liquidity', input);
  }

  async prepareRaydiumRemoveLiquidity(input: RaydiumRemoveLiquidityPrepareInput): Promise<Record<string, unknown>> {
    return this.prepareRaydiumAction('remove_liquidity', input);
  }

  async prepareRaydiumCollectFees(input: RaydiumCollectFeesPrepareInput): Promise<Record<string, unknown>> {
    return this.prepareRaydiumAction('collect_fees', input);
  }

  async prepareRaydiumFarmStake(input: RaydiumFarmPrepareInput): Promise<Record<string, unknown>> {
    return this.prepareRaydiumAction('farm_stake', input);
  }

  async prepareRaydiumFarmUnstake(input: RaydiumFarmPrepareInput): Promise<Record<string, unknown>> {
    return this.prepareRaydiumAction('farm_unstake', input);
  }

  async prepareRaydiumHarvest(input: Omit<RaydiumFarmPrepareInput, 'amount'>): Promise<Record<string, unknown>> {
    return this.prepareRaydiumAction('harvest', input);
  }

  private async prepareRaydiumAction(
    operation: 'add_liquidity' | 'remove_liquidity' | 'collect_fees' | 'farm_stake' | 'farm_unstake' | 'harvest',
    input: RaydiumAddLiquidityPrepareInput | RaydiumRemoveLiquidityPrepareInput | RaydiumCollectFeesPrepareInput | RaydiumFarmPrepareInput | Omit<RaydiumFarmPrepareInput, 'amount'>,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('raydium');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, operation);
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareMarginfiDeposit(input: MarginfiActionInput): Promise<Record<string, unknown>> {
    return this.prepareMarginfiAction('deposit', input);
  }

  async prepareMarginfiWithdraw(input: MarginfiActionInput): Promise<Record<string, unknown>> {
    return this.prepareMarginfiAction('withdraw', input);
  }

  async prepareMarginfiBorrow(input: MarginfiActionInput): Promise<Record<string, unknown>> {
    return this.prepareMarginfiAction('borrow', input);
  }

  async prepareMarginfiRepay(input: MarginfiActionInput): Promise<Record<string, unknown>> {
    return this.prepareMarginfiAction('repay', input);
  }

  private async prepareMarginfiAction(
    operation: 'deposit' | 'withdraw' | 'borrow' | 'repay',
    input: MarginfiActionInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('marginfi');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, operation);
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareProject0CreateAccount(input: Project0PrepareInput): Promise<Record<string, unknown>> {
    return this.prepareProject0Action('create_account', input);
  }

  async prepareProject0Deposit(input: Project0PrepareInput): Promise<Record<string, unknown>> {
    return this.prepareProject0Action('deposit', input);
  }

  async prepareProject0Withdraw(input: Project0PrepareInput): Promise<Record<string, unknown>> {
    return this.prepareProject0Action('withdraw', input);
  }

  async prepareProject0Borrow(input: Project0PrepareInput): Promise<Record<string, unknown>> {
    return this.prepareProject0Action('borrow', input);
  }

  async prepareProject0Repay(input: Project0PrepareInput): Promise<Record<string, unknown>> {
    return this.prepareProject0Action('repay', input);
  }

  private async prepareProject0Action(
    operation: 'create_account' | 'deposit' | 'withdraw' | 'borrow' | 'repay',
    input: Project0PrepareInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('project0');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, operation);
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async jupiterLendEarnTokens(input: { includeInactive?: boolean; assetMint?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.earn_tokens;
    if (!read) throw new AdapterError('jupiter', 'unsupported_method', 'Jupiter Lend Earn tokens read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      cluster: AgentWalletConfig['cluster'];
      tokens: Parameters<typeof factsFromJupiterLendEarnTokens>[0]['tokens'];
    };
    return {
      ...result,
      facts: factsFromJupiterLendEarnTokens({ tokens: result.tokens }),
    };
  }

  async jupiterLendEarnTokenDetail(input: { assetMint: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.earn_token_detail;
    if (!read) throw new AdapterError('jupiter', 'unsupported_method', 'Jupiter Lend Earn token detail read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      cluster: AgentWalletConfig['cluster'];
      token: Parameters<typeof factsFromJupiterLendEarnTokens>[0]['tokens'][number];
    };
    return {
      ...result,
      facts: factsFromJupiterLendEarnTokens({ tokens: [result.token] }),
    };
  }

  async jupiterLendEarnPositions(input: { walletAddress?: string; assetMint?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.earn_positions;
    if (!read) throw new AdapterError('jupiter', 'unsupported_method', 'Jupiter Lend Earn positions read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      walletAddress: string;
      cluster: AgentWalletConfig['cluster'];
      positions: Parameters<typeof factsFromJupiterLendEarnPositions>[0]['positions'];
    };
    return {
      ...result,
      facts: factsFromJupiterLendEarnPositions({ walletAddress: result.walletAddress, positions: result.positions }),
    };
  }

  async jupiterLendEarnEarnings(input: {
    walletAddress?: string;
    assetMint?: string;
    from?: string;
    to?: string;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.earn_earnings;
    if (!read) throw new AdapterError('jupiter', 'unsupported_method', 'Jupiter Lend Earn earnings read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      walletAddress: string;
      cluster: AgentWalletConfig['cluster'];
      earnings: Parameters<typeof factsFromJupiterLendEarnEarnings>[0]['earnings'];
    };
    return {
      ...result,
      facts: factsFromJupiterLendEarnEarnings({ walletAddress: result.walletAddress, earnings: result.earnings }),
    };
  }

  async jupiterLendBorrowVaults(input: {
    vaultId?: number;
    supplyMint?: string;
    borrowMint?: string;
    includeUnavailable?: boolean;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.borrow_vaults;
    if (!read) throw new AdapterError('jupiter', 'unsupported_method', 'Jupiter Lend Borrow vaults read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      cluster: AgentWalletConfig['cluster'];
      vaults: Parameters<typeof factsFromJupiterLendBorrowVaults>[0]['vaults'];
    };
    return {
      ...result,
      facts: factsFromJupiterLendBorrowVaults({ vaults: result.vaults }),
    };
  }

  async jupiterLendBorrowVaultDetail(input: { vaultId: number }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.borrow_vault_detail;
    if (!read) throw new AdapterError('jupiter', 'unsupported_method', 'Jupiter Lend Borrow vault detail read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      cluster: AgentWalletConfig['cluster'];
      vault: Parameters<typeof factsFromJupiterLendBorrowVaults>[0]['vaults'][number];
    };
    return {
      ...result,
      facts: factsFromJupiterLendBorrowVaults({ vaults: [result.vault] }),
    };
  }

  async jupiterLendBorrowPositions(input: {
    walletAddress?: string;
    vaultId?: number;
    positionId?: number;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.borrow_positions;
    if (!read) throw new AdapterError('jupiter', 'unsupported_method', 'Jupiter Lend Borrow positions read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      walletAddress: string;
      cluster: AgentWalletConfig['cluster'];
      positions: Parameters<typeof factsFromJupiterLendBorrowPositions>[0]['positions'];
    };
    return {
      ...result,
      facts: factsFromJupiterLendBorrowPositions({ walletAddress: result.walletAddress, positions: result.positions }),
    };
  }

  async jupiterLendBorrowHealthPreview(input: {
    walletAddress?: string;
    vaultId: number;
    positionId?: number;
    collateralDelta?: string;
    debtDelta?: string;
    minHealthRatio?: number;
    maxLtvBps?: number;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.borrow_health_preview;
    if (!read) throw new AdapterError('jupiter', 'unsupported_method', 'Jupiter Lend Borrow health preview read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      walletAddress: string;
      cluster: AgentWalletConfig['cluster'];
      preview: Parameters<typeof factsFromJupiterLendBorrowHealth>[0];
    };
    return {
      ...result,
      facts: factsFromJupiterLendBorrowHealth(result.preview),
    };
  }

  async prepareJupiterLendEarnDeposit(input: JupiterLendEarnActionInput): Promise<Record<string, unknown>> {
    return this.prepareJupiterLendAction('earn_deposit', input);
  }

  async prepareJupiterLendEarnWithdraw(input: JupiterLendEarnActionInput): Promise<Record<string, unknown>> {
    return this.prepareJupiterLendAction('earn_withdraw', input);
  }

  async prepareJupiterLendEarnMint(input: JupiterLendEarnActionInput): Promise<Record<string, unknown>> {
    return this.prepareJupiterLendAction('earn_mint', input);
  }

  async prepareJupiterLendEarnRedeem(input: JupiterLendEarnActionInput): Promise<Record<string, unknown>> {
    return this.prepareJupiterLendAction('earn_redeem', input);
  }

  async prepareJupiterLendBorrowCreatePosition(input: JupiterLendBorrowActionInput): Promise<Record<string, unknown>> {
    return this.prepareJupiterLendAction('borrow_create_position', input);
  }

  async prepareJupiterLendBorrowDepositCollateral(input: JupiterLendBorrowActionInput): Promise<Record<string, unknown>> {
    return this.prepareJupiterLendAction('borrow_deposit_collateral', input);
  }

  async prepareJupiterLendBorrowBorrow(input: JupiterLendBorrowActionInput): Promise<Record<string, unknown>> {
    return this.prepareJupiterLendAction('borrow_borrow', input);
  }

  async prepareJupiterLendBorrowRepay(input: JupiterLendBorrowActionInput): Promise<Record<string, unknown>> {
    return this.prepareJupiterLendAction('borrow_repay', input);
  }

  async prepareJupiterLendBorrowWithdrawCollateral(input: JupiterLendBorrowActionInput): Promise<Record<string, unknown>> {
    return this.prepareJupiterLendAction('borrow_withdraw_collateral', input);
  }

  private async prepareJupiterLendAction(
    operation:
      | 'earn_deposit'
      | 'earn_withdraw'
      | 'earn_mint'
      | 'earn_redeem'
      | 'borrow_create_position'
      | 'borrow_deposit_collateral'
      | 'borrow_borrow'
      | 'borrow_repay'
      | 'borrow_withdraw_collateral',
    input: JupiterLendEarnActionInput | JupiterLendBorrowActionInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, operation);
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async jupiterTriggerAuthChallenge(input: {
    walletAddress?: string;
    challengeType?: JupiterTriggerChallengeType;
  }): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerRead('trigger_auth_challenge', input);
  }

  async jupiterTriggerAuthVerify(input: {
    walletAddress?: string;
    challengeType: JupiterTriggerChallengeType;
    signature?: string;
    signedTransaction?: string;
  }): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerRead('trigger_auth_verify', input);
  }

  async jupiterTriggerAuthStatus(input: { walletAddress?: string }): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerRead('trigger_auth_status', input);
  }

  async jupiterTriggerVault(input: { walletAddress?: string }): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerRead('trigger_vault', input);
  }

  async jupiterTriggerOrders(input: {
    walletAddress?: string;
    state?: JupiterTriggerOrderState;
    limit?: number;
    offset?: number;
  }): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerRead('trigger_orders', input);
  }

  async jupiterTriggerOrderDetail(input: {
    walletAddress?: string;
    orderId: string;
  }): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerRead('trigger_order_detail', input);
  }

  async jupiterTriggerOrderHistory(input: {
    walletAddress?: string;
    state?: JupiterTriggerOrderState;
    limit?: number;
    offset?: number;
  }): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerRead('trigger_order_history', input);
  }

  async prepareJupiterTriggerRegisterVault(input: JupiterTriggerRegisterVaultInput): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerAction('trigger_register_vault', input);
  }

  async prepareJupiterTriggerSingleOrder(input: JupiterTriggerSingleOrderInput): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerAction('trigger_single_order', input);
  }

  async prepareJupiterTriggerOcoOrder(input: JupiterTriggerOcoOrderInput): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerAction('trigger_oco_order', input);
  }

  async prepareJupiterTriggerOtocoOrder(input: JupiterTriggerOtocoOrderInput): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerAction('trigger_otoco_order', input);
  }

  async prepareJupiterTriggerEditOrder(input: JupiterTriggerEditOrderInput): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerAction('trigger_edit_order', input);
  }

  async prepareJupiterTriggerCancelOrder(input: JupiterTriggerCancelOrderInput): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerAction('trigger_cancel_order', input);
  }

  async prepareJupiterTriggerWithdrawOrderFunds(input: JupiterTriggerWithdrawOrderFundsInput): Promise<Record<string, unknown>> {
    return this.runJupiterTriggerAction('trigger_withdraw_order_funds', input);
  }

  private async runJupiterTriggerRead(readId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads[readId];
    if (!read) {
      throw new ProtocolError('unsupported_method', `Jupiter adapter is missing read ${readId}.`);
    }
    const result = await read.read(input, this.adapterContext(adapter));
    return { result, facts: factsFromJupiterTriggerRead(readId, result) };
  }

  private async runJupiterTriggerAction(actionId: string, input: unknown): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, actionId);
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async jupiterRecurringOrders(input: {
    walletAddress?: string;
    state?: JupiterRecurringOrderState;
    limit?: number;
    page?: number;
    inputMint?: string;
    outputMint?: string;
    recurringType?: 'time' | 'price';
    includeFailedTx?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.runJupiterRecurringRead('recurring_orders', input);
  }

  async jupiterRecurringOrderDetail(input: {
    walletAddress?: string;
    orderId: string;
    recurringType?: 'time' | 'price';
  }): Promise<Record<string, unknown>> {
    return this.runJupiterRecurringRead('recurring_order_detail', input);
  }

  async jupiterRecurringQuote(input: JupiterRecurringQuoteInput): Promise<Record<string, unknown>> {
    return this.runJupiterRecurringRead('recurring_quote', input);
  }

  async prepareJupiterRecurringCreateTimeOrder(input: JupiterRecurringCreateTimeOrderInput): Promise<Record<string, unknown>> {
    return this.runJupiterRecurringAction('recurring_create_time_order', input);
  }

  async prepareJupiterRecurringCancelOrder(input: JupiterRecurringCancelOrderInput): Promise<Record<string, unknown>> {
    return this.runJupiterRecurringAction('recurring_cancel_order', input);
  }

  async prepareJupiterRecurringDepositPriceOrder(input: JupiterRecurringPriceOrderInput): Promise<Record<string, unknown>> {
    return this.runJupiterRecurringAction('recurring_deposit_price_order', input);
  }

  async prepareJupiterRecurringWithdrawPriceOrder(input: JupiterRecurringPriceOrderInput): Promise<Record<string, unknown>> {
    return this.runJupiterRecurringAction('recurring_withdraw_price_order', input);
  }

  private async runJupiterRecurringRead(readId: string, input: unknown): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads[readId];
    if (!read) {
      throw new ProtocolError('unsupported_method', `Jupiter adapter is missing read ${readId}.`);
    }
    const result = await read.read(input, this.adapterContext(adapter));
    return { result, facts: factsFromJupiterRecurringRead(readId, result) };
  }

  private async runJupiterRecurringAction(actionId: string, input: unknown): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('jupiter');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, actionId);
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareDriftVaultDeposit(input: DriftVaultDepositInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('drift');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'vault_deposit');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareDriftVaultRequestWithdraw(
    input: DriftVaultRequestWithdrawInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('drift');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'vault_request_withdraw');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareDriftVaultCancelWithdraw(
    input: DriftVaultCancelWithdrawInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('drift');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'vault_cancel_withdraw');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareDriftVaultCompleteWithdraw(
    input: DriftVaultCompleteWithdrawInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('drift');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'vault_complete_withdraw');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareSquadsCreateTransferProposal(
    input: SquadsCreateTransferProposalInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('squads');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'create_transfer_proposal');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareSquadsApproveProposal(input: SquadsVoteInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('squads');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'approve_proposal');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareSquadsRejectProposal(input: SquadsVoteInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('squads');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'reject_proposal');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareSquadsCancelProposal(input: SquadsVoteInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('squads');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'cancel_proposal');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareSquadsExecuteProposal(
    input: SquadsExecuteProposalInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('squads');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'execute_proposal');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareRealmsCastVote(input: RealmsCastVoteInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('realms');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'cast_vote');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareRealmsRelinquishVote(
    input: RealmsRelinquishVoteInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('realms');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'relinquish_vote');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareRealmsDepositGovernanceTokens(
    input: RealmsDepositGovernanceTokensInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('realms');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'deposit_governance_tokens');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareRealmsWithdrawGovernanceTokens(
    input: RealmsWithdrawGovernanceTokensInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('realms');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'withdraw_governance_tokens');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareLuloDeposit(input: LuloDepositInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('lulo');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'deposit');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareLuloWithdraw(input: LuloWithdrawInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('lulo');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'withdraw');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareLuloCompleteWithdraw(input: LuloCompleteWithdrawInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('lulo');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'complete_withdraw');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareSaveDeposit(input: SaveDepositInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('save');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'deposit');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareSaveWithdraw(input: SaveWithdrawInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('save');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'withdraw');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareSaveBorrow(input: SaveBorrowInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('save');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'borrow');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareSaveRepay(input: SaveRepayInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('save');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'repay');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareJitoStakeSol(input: JitoStakeSolInput): Promise<Record<string, unknown>> {
    return this.prepareJitoAction('stake_sol', input);
  }

  async prepareJitoDepositStakeAccount(input: JitoDepositStakeAccountInput): Promise<Record<string, unknown>> {
    return this.prepareJitoAction('deposit_stake_account', input);
  }

  async prepareJitoUnstakeJitosol(input: JitoUnstakeJitosolInput): Promise<Record<string, unknown>> {
    return this.prepareJitoAction('unstake_jitosol', input);
  }

  async prepareJitoWithdrawSol(input: JitoWithdrawSolInput): Promise<Record<string, unknown>> {
    return this.prepareJitoAction('withdraw_sol', input);
  }

  async prepareJitoClaimDepositReceipt(input: JitoClaimDepositReceiptInput): Promise<Record<string, unknown>> {
    return this.prepareJitoAction('claim_deposit_receipt', input);
  }

  async prepareMarinadeLiquidStake(input: MarinadeLiquidStakeInput): Promise<Record<string, unknown>> {
    return this.prepareMarinadeAction('liquid_stake', input);
  }

  async prepareMarinadeLiquidUnstake(input: MarinadeLiquidUnstakeInput): Promise<Record<string, unknown>> {
    return this.prepareMarinadeAction('liquid_unstake', input);
  }

  async prepareMarinadeDelayedUnstake(input: MarinadeDelayedUnstakeInput): Promise<Record<string, unknown>> {
    return this.prepareMarinadeAction('delayed_unstake', input);
  }

  async prepareMarinadeClaimDelayedUnstake(input: MarinadeClaimDelayedUnstakeInput): Promise<Record<string, unknown>> {
    return this.prepareMarinadeAction('claim_delayed_unstake', input);
  }

  private async prepareJitoAction(
    operation: 'stake_sol' | 'deposit_stake_account' | 'unstake_jitosol' | 'withdraw_sol' | 'claim_deposit_receipt',
    input:
      | JitoStakeSolInput
      | JitoDepositStakeAccountInput
      | JitoUnstakeJitosolInput
      | JitoWithdrawSolInput
      | JitoClaimDepositReceiptInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('jito');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, operation);
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  private async prepareMarinadeAction(
    operation: 'liquid_stake' | 'liquid_unstake' | 'delayed_unstake' | 'claim_delayed_unstake',
    input:
      | MarinadeLiquidStakeInput
      | MarinadeLiquidUnstakeInput
      | MarinadeDelayedUnstakeInput
      | MarinadeClaimDelayedUnstakeInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('marinade');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, operation);
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async luloRates(input: { mintAddress?: string; depositType?: 'protected' | 'boost' | 'regular' }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('lulo');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.rates;
    if (!read) throw new AdapterError('lulo', 'unsupported_method', 'Lulo rates read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromLuloRates>[0];
    return {
      snapshot,
      facts: factsFromLuloRates(snapshot),
    };
  }

  async luloPoolMeta(input: { mintAddress?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('lulo');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.pool_meta;
    if (!read) throw new AdapterError('lulo', 'unsupported_method', 'Lulo pool metadata read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromLuloPoolMeta>[0];
    return {
      snapshot,
      facts: factsFromLuloPoolMeta(snapshot),
    };
  }

  async luloWalletBalances(input: { walletAddress?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('lulo');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_balances;
    if (!read) throw new AdapterError('lulo', 'unsupported_method', 'Lulo balances read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromLuloBalances>[0];
    return {
      snapshot,
      facts: factsFromLuloBalances(snapshot),
    };
  }

  async magicedenApiHealth(input: { includeTradingEndpoints?: boolean }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.api_health;
    if (!read) throw new AdapterError('magiceden', 'unsupported_method', 'Magic Eden api_health read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMagicedenApiHealth>[0];
    return { snapshot, facts: factsFromMagicedenApiHealth(snapshot) };
  }

  async magicedenTopCollections(input: {
    limit?: number;
    timeRange?: string;
  } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.top_collections;
    if (!read) throw new AdapterError('magiceden', 'unsupported_method', 'Magic Eden top_collections read is not registered.');
    const collections = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMagicedenTopCollections>[0];
    return { collections, facts: factsFromMagicedenTopCollections(collections) };
  }

  async magicedenCollectionSnapshot(input: {
    collectionSymbol?: string;
    collectionId?: string;
    includeListings?: boolean;
    includeBids?: boolean;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.collection_snapshot;
    if (!read) throw new AdapterError('magiceden', 'unsupported_method', 'Magic Eden collection_snapshot read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMagicedenCollectionSnapshot>[0];
    return { snapshot, facts: factsFromMagicedenCollectionSnapshot(snapshot) };
  }

  async magicedenCollectionListings(input: {
    collectionSymbol?: string;
    collectionId?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.collection_listings;
    if (!read) throw new AdapterError('magiceden', 'unsupported_method', 'Magic Eden collection_listings read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMagicedenCollectionListings>[0];
    return { snapshot, facts: factsFromMagicedenCollectionListings(snapshot) };
  }

  async magicedenCollectionBids(input: {
    collectionSymbol?: string;
    collectionId?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.collection_bids;
    if (!read) throw new AdapterError('magiceden', 'unsupported_method', 'Magic Eden collection_bids read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMagicedenCollectionBids>[0];
    return { snapshot, facts: factsFromMagicedenCollectionBids(snapshot) };
  }

  async magicedenRecentActivity(input: {
    collectionSymbol?: string;
    collectionId?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.recent_activity;
    if (!read) throw new AdapterError('magiceden', 'unsupported_method', 'Magic Eden recent_activity read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMagicedenRecentActivity>[0];
    return { snapshot, facts: factsFromMagicedenRecentActivity(snapshot) };
  }

  async magicedenWalletNfts(input: {
    walletAddress?: string;
    collectionSymbol?: string;
    collectionId?: string;
    listedOnly?: boolean;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_nfts;
    if (!read) throw new AdapterError('magiceden', 'unsupported_method', 'Magic Eden wallet_nfts read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMagicedenWalletNfts>[0];
    return { snapshot, facts: factsFromMagicedenWalletNfts(snapshot) };
  }

  async magicedenNftDetail(input: {
    mintAddress: string;
    includeListing?: boolean;
    includeBids?: boolean;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.nft_detail;
    if (!read) throw new AdapterError('magiceden', 'unsupported_method', 'Magic Eden nft_detail read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMagicedenNftDetail>[0];
    return { snapshot, facts: factsFromMagicedenNftDetail(snapshot) };
  }

  async prepareMagicedenBuy(input: MagicedenBuyPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'buy');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareMagicedenList(input: MagicedenListPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'list');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareMagicedenCancelListing(
    input: MagicedenCancelListingPrepareInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'cancel_listing');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareMagicedenBid(input: MagicedenBidPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'bid');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareMagicedenCancelBid(
    input: MagicedenCancelBidPrepareInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('magiceden');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'cancel_bid');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async tensorCollectionSnapshot(input: {
    collectionId: string;
    includeListings?: boolean;
    includeBids?: boolean;
    maxListings?: number;
    maxBids?: number;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.collection_snapshot;
    if (!read) throw new AdapterError('tensor', 'unsupported_method', 'Tensor collection_snapshot read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromTensorCollectionSnapshot>[0];
    return { snapshot, facts: factsFromTensorCollectionSnapshot(snapshot) };
  }

  async tensorSupportedCollections(input: { limit?: number } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.supported_collections;
    if (!read) throw new AdapterError('tensor', 'unsupported_method', 'Tensor supported_collections read is not registered.');
    const collections = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromTensorSupportedCollections>[0];
    return { collections, facts: factsFromTensorSupportedCollections(collections) };
  }

  async tensorCollectionListings(input: { collectionId: string; limit?: number }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.collection_listings;
    if (!read) throw new AdapterError('tensor', 'unsupported_method', 'Tensor collection_listings read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromTensorCollectionListings>[0];
    return { snapshot, facts: factsFromTensorCollectionListings(snapshot) };
  }

  async tensorCollectionBids(input: { collectionId: string; limit?: number }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.collection_bids;
    if (!read) throw new AdapterError('tensor', 'unsupported_method', 'Tensor collection_bids read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromTensorCollectionBids>[0];
    return { snapshot, facts: factsFromTensorCollectionBids(snapshot) };
  }

  async tensorRecentSales(input: { collectionId: string; limit?: number }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.recent_sales;
    if (!read) throw new AdapterError('tensor', 'unsupported_method', 'Tensor recent_sales read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromTensorRecentSales>[0];
    return { snapshot, facts: factsFromTensorRecentSales(snapshot) };
  }

  async tensorWalletNfts(input: {
    walletAddress?: string;
    collectionId?: string;
    includeCompressed?: boolean;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_nfts;
    if (!read) throw new AdapterError('tensor', 'unsupported_method', 'Tensor wallet_nfts read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromTensorWalletNfts>[0];
    return { snapshot, facts: factsFromTensorWalletNfts(snapshot) };
  }

  async tensorNftDetail(input: { mintAddress?: string; assetId?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.nft_detail;
    if (!read) throw new AdapterError('tensor', 'unsupported_method', 'Tensor nft_detail read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromTensorNftDetail>[0];
    return { snapshot, facts: factsFromTensorNftDetail(snapshot) };
  }

  async tensorWalletMarketplaceExposure(input: { walletAddress?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_marketplace_exposure;
    if (!read) throw new AdapterError('tensor', 'unsupported_method', 'Tensor wallet_marketplace_exposure read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromTensorWalletMarketplaceExposure>[0];
    return { snapshot, facts: factsFromTensorWalletMarketplaceExposure(snapshot) };
  }

  async prepareTensorBuy(input: TensorBuyPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'buy');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareTensorList(input: TensorListPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'list');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareTensorCancelListing(input: TensorCancelListingPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'cancel_listing');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareTensorBid(input: TensorBidPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'bid');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareTensorCancelBid(input: TensorCancelBidPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'cancel_bid');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async prepareTensorSweep(input: TensorSweepPrepareInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('tensor');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'sweep');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async jupiterTokenSearch(input: JupiterTokenSearchInput): Promise<Record<string, unknown>> {
    assertConnectorCluster(requireRuntimeConnector('jupiter'), this.config.cluster);
    const result = await getJupiterTokenSearch(this.config, input);
    return { search: result, facts: factsFromJupiterTokenRead(result) };
  }

  async jupiterTokensByTag(input: JupiterTokenByTagInput): Promise<Record<string, unknown>> {
    assertConnectorCluster(requireRuntimeConnector('jupiter'), this.config.cluster);
    const result = await getJupiterTokensByTag(this.config, input);
    return { tag: result, facts: factsFromJupiterTokenRead(result) };
  }

  async jupiterTokenCategory(input: JupiterTokenCategoryInput): Promise<Record<string, unknown>> {
    assertConnectorCluster(requireRuntimeConnector('jupiter'), this.config.cluster);
    const result = await getJupiterTokenCategory(this.config, input);
    return { category: result, facts: factsFromJupiterTokenRead(result) };
  }

  async jupiterRecentTokens(input: JupiterTokenRecentInput = {}): Promise<Record<string, unknown>> {
    assertConnectorCluster(requireRuntimeConnector('jupiter'), this.config.cluster);
    const result = await getJupiterRecentTokens(this.config, input);
    return { recent: result, facts: factsFromJupiterTokenRead(result) };
  }

  async jupiterPrice(input: JupiterPriceInput): Promise<Record<string, unknown>> {
    assertConnectorCluster(requireRuntimeConnector('jupiter'), this.config.cluster);
    const price = await getJupiterPrice(this.config, input);
    return { price, facts: factsFromJupiterPrice(price) };
  }

  async jupiterPriceBatch(input: JupiterPriceBatchInput): Promise<Record<string, unknown>> {
    assertConnectorCluster(requireRuntimeConnector('jupiter'), this.config.cluster);
    const batch = await getJupiterPriceBatch(this.config, input);
    return { batch, facts: factsFromJupiterPriceBatch(batch) };
  }

  async jupiterTokenRiskEvidence(input: JupiterTokenRiskEvidenceInput): Promise<Record<string, unknown>> {
    assertConnectorCluster(requireRuntimeConnector('jupiter'), this.config.cluster);
    const evidence = await getJupiterTokenRiskEvidence(this.config, input);
    return { evidence, facts: factsFromJupiterTokenRiskEvidence(evidence) };
  }

  async solanaMarketData(input: SolanaMarketDataInput): Promise<Record<string, unknown>> {
    return readSolanaMarketData(input);
  }

  async solanaTokenLists(input: SolanaTokenListsInput): Promise<Record<string, unknown>> {
    return readSolanaTokenLists(input);
  }

  async solanaTokenSafetyEvidence(input: SolanaTokenSafetyEvidenceInput): Promise<Record<string, unknown>> {
    return readSolanaTokenSafetyEvidence(input);
  }

  async solanaHeliusHistory(input: SolanaHeliusHistoryInput): Promise<Record<string, unknown>> {
    return readSolanaHeliusHistory(input);
  }

  private async jupiterSwapTokenEvidence(input: {
    requestedInputToken?: string;
    requestedOutputToken?: string;
    inputMint?: unknown;
    outputMint?: unknown;
  }): Promise<{ evidence: JupiterTokenRiskEvidence[]; facts: ConnectorFact[] }> {
    const mints = [
      swapEvidenceMint(input.inputMint, input.requestedInputToken, this.config),
      swapEvidenceMint(input.outputMint, input.requestedOutputToken, this.config),
    ].filter((mint): mint is string => mint !== undefined);
    const uniqueMints = [...new Set(mints)];
    const evidence: JupiterTokenRiskEvidence[] = [];
    const facts: ConnectorFact[] = [];
    for (const mint of uniqueMints) {
      try {
        const result = await getJupiterTokenRiskEvidence(this.config, {
          mint,
          includePrice: true,
          includeSearchFallback: true,
        });
        evidence.push(result);
        facts.push(...factsFromJupiterTokenRiskEvidence(result));
      } catch (err) {
        facts.push(fact({
          connectorId: 'jupiter',
          label: 'Jupiter token evidence unavailable',
          value: `Could not read token evidence for ${shortToken(mint)}: ${err instanceof Error ? err.message : String(err)}`,
          tone: 'warn',
          detail: { mint },
        }));
      }
    }
    return { evidence, facts };
  }

  async pythPriceFeed(input: GetPythPriceFeedInput): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('pyth');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.price_feed;
    if (!read) throw new AdapterError('pyth', 'unsupported_method', 'Pyth price feed read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromPythPriceFeed>[0];
    return { snapshot: result.snapshot, facts: factsFromPythPriceFeed(result) };
  }

  async pythPriceFeedsBatch(input: GetPythPriceFeedsBatchInput): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('pyth');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.price_feeds_batch;
    if (!read) throw new AdapterError('pyth', 'unsupported_method', 'Pyth batch read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromPythBatch>[0];
    return { batch: result, facts: factsFromPythBatch(result) };
  }

  async pythFeedSearch(input: PythFeedSearchInput): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('pyth');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.feed_search;
    if (!read) throw new AdapterError('pyth', 'unsupported_method', 'Pyth feed search is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromPythFeedSearch>[0];
    return { search: result, facts: factsFromPythFeedSearch(result) };
  }

  async pythOnchainPriceAccount(input: GetPythOnchainAccountInput): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('pyth');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.onchain_price_account;
    if (!read) throw new AdapterError('pyth', 'unsupported_method', 'Pyth on-chain account read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromPythOnchainAccount>[0];
    return { snapshot: result, facts: factsFromPythOnchainAccount(result) };
  }

  async pythOracleEvidence(input: GetPythOracleEvidenceInput): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('pyth');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.oracle_evidence;
    if (!read) throw new AdapterError('pyth', 'unsupported_method', 'Pyth oracle evidence read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromPythEvidence>[0];
    return { evidence: result, facts: factsFromPythEvidence(result) };
  }

  async preparePythPostPriceUpdate(input: PythPostPriceUpdateInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('pyth');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, 'post_price_update');
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async wormholeSupportedRoutes(input: WormholeSupportedRoutesInput = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('wormhole');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.supported_routes;
    if (!read) throw new AdapterError('wormhole', 'unsupported_method', 'Wormhole supported_routes read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromWormholeSupportedRoutes>[0];
    return { snapshot, facts: factsFromWormholeSupportedRoutes(snapshot) };
  }

  async wormholeTokenSnapshot(input: WormholeTokenSnapshotInput): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('wormhole');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.token_snapshot;
    if (!read) throw new AdapterError('wormhole', 'unsupported_method', 'Wormhole token_snapshot read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromWormholeTokenSnapshot>[0];
    return { snapshot, facts: factsFromWormholeTokenSnapshot(snapshot) };
  }

  async wormholeQuote(input: WormholeQuoteReadInput): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('wormhole');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.quote;
    if (!read) throw new AdapterError('wormhole', 'unsupported_method', 'Wormhole quote read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromWormholeQuote>[0];
    return { snapshot, facts: factsFromWormholeQuote(snapshot) };
  }

  async wormholeTransferStatus(input: WormholeTransferStatusInput): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('wormhole');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.transfer_status;
    if (!read) throw new AdapterError('wormhole', 'unsupported_method', 'Wormhole transfer_status read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromWormholeTransferStatus>[0];
    return { snapshot, facts: factsFromWormholeTransferStatus(snapshot) };
  }

  async wormholeWalletBridgeExposure(input: WormholeWalletBridgeExposureInput = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('wormhole');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_bridge_exposure;
    if (!read) throw new AdapterError('wormhole', 'unsupported_method', 'Wormhole wallet_bridge_exposure read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromWormholeWalletBridgeExposure>[0];
    return { snapshot, facts: factsFromWormholeWalletBridgeExposure(snapshot) };
  }

  async prepareWormholeTransfer(input: WormholeTransferInput): Promise<Record<string, unknown>> {
    return this.prepareWormholeAction('transfer', input);
  }

  async prepareWormholeRedeem(input: WormholeRedeemInput): Promise<Record<string, unknown>> {
    return this.prepareWormholeAction('redeem', input);
  }

  async prepareWormholeRecoverOrResume(input: WormholeRecoverOrResumeInput): Promise<Record<string, unknown>> {
    return this.prepareWormholeAction('recover_or_resume', input);
  }

  private async prepareWormholeAction(
    operation: 'transfer' | 'redeem' | 'recover_or_resume',
    input: WormholeTransferInput | WormholeRedeemInput | WormholeRecoverOrResumeInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('wormhole');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, operation);
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  async sanctumLstList(input: { includeDisabled?: boolean } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('sanctum');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.lst_list;
    if (!read) throw new AdapterError('sanctum', 'unsupported_method', 'Sanctum LST list read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromSanctumLstList>[0];
    return { snapshot, facts: factsFromSanctumLstList(snapshot) };
  }

  async sanctumLstSnapshot(input: {
    lstMint?: string;
    mintOrSymbol?: string;
    includeApy?: boolean;
    apyLimit?: number;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('sanctum');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.lst_snapshot;
    if (!read) throw new AdapterError('sanctum', 'unsupported_method', 'Sanctum LST snapshot read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromSanctumLstSnapshot>[0];
    return { snapshot, facts: factsFromSanctumLstSnapshot(snapshot) };
  }

  async sanctumInfinityPoolSnapshot(input: { includeComposition?: boolean } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('sanctum');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.infinity_pool_snapshot;
    if (!read) throw new AdapterError('sanctum', 'unsupported_method', 'Sanctum Infinity pool snapshot read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromSanctumInfinityPoolSnapshot>[0];
    return { snapshot, facts: factsFromSanctumInfinityPoolSnapshot(snapshot) };
  }

  async sanctumWalletPositions(input: {
    walletAddress?: string;
    includeSmallBalances?: boolean;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('sanctum');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_positions;
    if (!read) throw new AdapterError('sanctum', 'unsupported_method', 'Sanctum wallet positions read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromSanctumWalletPositions>[0];
    return { snapshot, facts: factsFromSanctumWalletPositions(snapshot) };
  }

  async sanctumQuote(input: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps?: number;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('sanctum');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.quote;
    if (!read) throw new AdapterError('sanctum', 'unsupported_method', 'Sanctum quote read is not registered.');
    const inputToken = await this.resolveSanctumTokenIdentifier(input.inputMint);
    const outputToken = await this.resolveSanctumTokenIdentifier(input.outputMint);
    const amountRaw = parseDecimalAmount(input.amount, inputToken.decimals, 'Sanctum quote amount');
    const quote = (await read.read({
      inputMint: inputToken.mint,
      outputMint: outputToken.mint,
      amountRaw: amountRaw.toString(),
      ...(input.slippageBps !== undefined && { slippageBps: input.slippageBps }),
    }, this.adapterContext(adapter))) as Parameters<typeof factsFromSanctumQuote>[0];
    return { quote, facts: factsFromSanctumQuote(quote) };
  }

  async prepareSanctumSwapLst(input: SanctumSwapLstInput): Promise<Record<string, unknown>> {
    return this.prepareSanctumAction('swap_lst', input);
  }

  async prepareSanctumAddInfinityLiquidity(
    input: SanctumAddInfinityLiquidityInput,
  ): Promise<Record<string, unknown>> {
    return this.prepareSanctumAction('add_infinity_liquidity', input);
  }

  async prepareSanctumRemoveInfinityLiquidity(
    input: SanctumRemoveInfinityLiquidityInput,
  ): Promise<Record<string, unknown>> {
    return this.prepareSanctumAction('remove_infinity_liquidity', input);
  }

  async prepareSanctumStakeSolToLst(input: SanctumStakeSolToLstInput): Promise<Record<string, unknown>> {
    return this.prepareSanctumAction('stake_sol_to_lst', input);
  }

  async prepareSanctumUnstakeLstToSol(input: SanctumUnstakeLstToSolInput): Promise<Record<string, unknown>> {
    return this.prepareSanctumAction('unstake_lst_to_sol', input);
  }

  private async prepareSanctumAction(
    operation: 'swap_lst' | 'add_infinity_liquidity' | 'remove_infinity_liquidity' | 'stake_sol_to_lst' | 'unstake_lst_to_sol',
    input: SanctumSwapLstInput
      | SanctumAddInfinityLiquidityInput
      | SanctumRemoveInfinityLiquidityInput
      | SanctumStakeSolToLstInput
      | SanctumUnstakeLstToSolInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const adapter = requireAdapter('sanctum');
    assertSupportedCluster(adapter, this.config.cluster);
    const action = requireAdapterAction(adapter, operation);
    const result = await action.prepare(input, this.adapterContext(adapter));
    const stored = await this.store().addAction(result.addInput);
    return { preparedAction: stored, preview: result.preview };
  }

  private async resolveSanctumTokenIdentifier(value: string): Promise<{ mint: string; decimals: number }> {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new ProtocolError('invalid_request', 'Sanctum token identifier is required.');
    }
    const known = normalizeSanctumKnownToken(trimmed);
    if (known) return { mint: known, decimals: 9 };
    const snapshotResult = await this.sanctumLstSnapshot({ mintOrSymbol: trimmed });
    const snapshot = snapshotResult.snapshot as { mint?: unknown; decimals?: unknown };
    if (typeof snapshot.mint !== 'string' || !snapshot.mint.trim()) {
      throw new AdapterError('sanctum', 'invalid_response', `Sanctum did not return a mint for ${trimmed}.`);
    }
    let normalizedMint: string;
    try {
      normalizedMint = new PublicKey(snapshot.mint).toBase58();
    } catch {
      throw new AdapterError('sanctum', 'invalid_response', `Sanctum returned an invalid mint for ${trimmed}.`);
    }
    return typeof snapshot.decimals === 'number' && Number.isFinite(snapshot.decimals)
      ? { mint: normalizedMint, decimals: snapshot.decimals }
      : { mint: normalizedMint, decimals: 9 };
  }

  async prepareBlinkAction(input: PrepareBlinkActionInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const connector = input.connector ? getConnector(input.connector) : undefined;
    if (input.connector && (!connector || !connector.writeCapabilities.includes('blinks'))) {
      throw new ProtocolError('invalid_request', 'Connector is not registered for Blink-backed actions.');
    }
    if (connector) {
      assertConnectorCluster(connector, this.config.cluster);
    }

    const walletAddress = await this.backend.getAddress();
    const account = input.account?.trim() || walletAddress;
    if (!account) {
      throw new ProtocolError('invalid_request', 'Wallet account is required before preparing this Blink action.');
    }
    if (account !== walletAddress) {
      throw new ProtocolError('unauthorized', 'Prepared action belongs to a different wallet.');
    }

    const metadata = await fetchBlinkMetadata({ url: input.blinkUrl }).catch((): BlinkActionMetadata | undefined => undefined);
    const prepared = await prepareBlinkActionRequest({
      url: input.blinkUrl,
      account,
      ...(input.parameters !== undefined && { parameters: input.parameters }),
    });
    const protocol = cleanOptionalString(input.protocol) ?? connector?.name ?? metadata?.title ?? prepared.title ?? 'Blink';
    const operation = cleanOptionalString(input.operation) ?? prepared.label ?? metadata?.label ?? 'Blink action';
    const simulationSummary = await this.summarizeBlinkSimulation(prepared.transactionBase64).catch(() => undefined);
    const action = await this.store().addAction({
      kind: 'blink_action',
      walletAddress,
      cluster: this.config.cluster,
      summary: `${protocol}: ${operation}`.slice(0, 140),
      params: {
        ...(connector ? { connectorId: connector.id } : {}),
        protocol,
        operation,
        blinkUrl: prepared.actionUrl,
        actionUrl: prepared.actionUrl,
        transactionBase64: prepared.transactionBase64,
        connectorActionSource: 'blink',
        approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
        ...(prepared.title ? { blinkTitle: prepared.title } : metadata?.title ? { blinkTitle: metadata.title } : {}),
        ...(prepared.label ? { blinkLabel: prepared.label } : metadata?.label ? { blinkLabel: metadata.label } : {}),
        ...(prepared.message ? { blinkMessage: prepared.message } : {}),
        ...(input.parameters !== undefined ? { parameters: input.parameters } : {}),
        ...(cleanOptionalString(input.expectedAmount) ? { expectedAmount: cleanOptionalString(input.expectedAmount) } : {}),
        ...(cleanOptionalString(input.expectedToken) ? { expectedToken: cleanOptionalString(input.expectedToken) } : {}),
        ...(cleanOptionalString(input.expectedRecipient) ? { expectedRecipient: cleanOptionalString(input.expectedRecipient) } : {}),
        ...(cleanOptionalString(input.position) ? { position: cleanOptionalString(input.position) } : {}),
        ...(simulationSummary ? { simulationSummary: JSON.stringify(simulationSummary) } : {}),
      },
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    });
    return {
      preparedAction: action,
      ...(simulationSummary ? { simulationSummary } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }

  connectorCapabilities(input: { connectorId?: string } = {}): Record<string, unknown> {
    const connectors = input.connectorId
      ? [connectorCapabilityView(requireRuntimeConnector(input.connectorId), this.config)]
      : listConnectorCapabilities(this.config);
    return {
      cluster: this.config.cluster,
      connectors,
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    };
  }

  async connectorReadFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector(input.connectorId);
    assertConnectorCluster(connector, this.config.cluster);
    try {
      if (connector.id === 'kamino') {
        return await this.kaminoConnectorFacts(input);
      }
      if (connector.id === 'jupiter') {
        return await this.jupiterConnectorFacts(input);
      }
      if (connector.id === 'meteora') {
        return await this.meteoraConnectorFacts(input);
      }
      if (connector.id === 'orca') {
        return await this.orcaConnectorFacts(input);
      }
      if (connector.id === 'raydium') {
        return await this.raydiumConnectorFacts(input);
      }
      if (connector.id === 'marginfi') {
        return await this.marginfiConnectorFacts(input);
      }
      if (connector.id === 'project0') {
        return await this.project0ConnectorFacts(input);
      }
      if (connector.id === 'drift') {
        return await this.driftConnectorFacts(input);
      }
      if (connector.id === 'lulo') {
        return await this.luloConnectorFacts(input);
      }
      if (connector.id === 'save') {
        return await this.saveConnectorFacts(input);
      }
      if (connector.id === 'jito') {
        return await this.jitoConnectorFacts(input);
      }
      if (connector.id === 'marinade') {
        return await this.marinadeConnectorFacts(input);
      }
      if (connector.id === 'sanctum') {
        return await this.sanctumConnectorFacts(input);
      }
      if (connector.id === 'pyth') {
        return await this.pythConnectorFacts(input);
      }
      if (connector.id === 'wormhole') {
        return await this.wormholeConnectorFacts(input);
      }
      if (connector.id === 'tensor') {
        return await this.tensorConnectorFacts(input);
      }
      if (connector.id === 'magiceden') {
        return await this.magicedenConnectorFacts(input);
      }
      if (connector.id === 'realms') {
        return await this.realmsConnectorFacts(input);
      }
      if (connector.id === 'squads') {
        return await this.squadsConnectorFacts(input);
      }
      throw missingConnectorCapability(connector, input.capability, 'read');
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
      throw connectorReadProtocolError(connector, err);
    }
  }

  private async magicedenConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('magiceden');
    const hasCollection = Boolean(input.collectionSymbol?.trim() || input.collectionId?.trim());
    const hasMint = Boolean(input.mintAddress?.trim());
    const capability = input.capability
      ?? (hasMint
        ? 'positions'
        : hasCollection
          ? 'markets'
          : 'positions');

    if (capability === 'markets' || capability === 'marketplace') {
      if (!hasCollection) {
        const result = await this.magicedenTopCollections({
          ...(input.limit !== undefined && { limit: input.limit }),
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          collections: result.collections,
          facts: result.facts,
        };
      }
      const result = await this.magicedenCollectionSnapshot({
        ...(input.collectionSymbol !== undefined && { collectionSymbol: input.collectionSymbol }),
        ...(input.collectionId !== undefined && { collectionId: input.collectionId }),
        ...(input.includeListings !== undefined && { includeListings: input.includeListings }),
        ...(input.includeBids !== undefined && { includeBids: input.includeBids }),
        ...(input.limit !== undefined && { limit: input.limit }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }

    if (capability === 'positions') {
      if (hasMint) {
        const result = await this.magicedenNftDetail({
          mintAddress: input.mintAddress!,
          ...(input.includeListings !== undefined && { includeListing: input.includeListings }),
          ...(input.includeBids !== undefined && { includeBids: input.includeBids }),
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          snapshot: result.snapshot,
          facts: result.facts,
        };
      }
      const result = await this.magicedenWalletNfts({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.collectionSymbol !== undefined && { collectionSymbol: input.collectionSymbol }),
        ...(input.collectionId !== undefined && { collectionId: input.collectionId }),
        ...(input.listedOnly !== undefined && { listedOnly: input.listedOnly }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }

    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async tensorConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('tensor');
    const capability = input.capability
      ?? (input.mintAddress || input.assetId
        ? 'positions'
        : input.collectionId
          ? 'markets'
          : 'positions');
    if (capability === 'markets' || capability === 'marketplace') {
      if (!input.collectionId?.trim()) {
        const result = await this.tensorSupportedCollections({
          ...(input.limit !== undefined && { limit: input.limit }),
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          collections: result.collections,
          facts: result.facts,
        };
      }
      const result = await this.tensorCollectionSnapshot({
        collectionId: input.collectionId,
        ...(input.includeListings !== undefined && { includeListings: input.includeListings }),
        ...(input.includeBids !== undefined && { includeBids: input.includeBids }),
        ...(input.maxListings !== undefined && { maxListings: input.maxListings }),
        ...(input.maxBids !== undefined && { maxBids: input.maxBids }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      if (input.mintAddress?.trim() || input.assetId?.trim()) {
        const result = await this.tensorNftDetail({
          ...(input.mintAddress !== undefined && { mintAddress: input.mintAddress }),
          ...(input.assetId !== undefined && { assetId: input.assetId }),
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          snapshot: result.snapshot,
          facts: result.facts,
        };
      }
      const result = await this.tensorWalletNfts({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.collectionId !== undefined && { collectionId: input.collectionId }),
        ...(input.includeCompressed !== undefined && { includeCompressed: input.includeCompressed }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async pythConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('pyth');
    const capability = input.capability ?? (input.query ? 'markets' : 'oracle');
    if (capability === 'oracle') {
      const result = await this.pythOracleEvidence({
        ...(input.priceFeedId !== undefined ? { priceFeedId: input.priceFeedId } : {}),
        ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
        ...(input.consumerProtocol !== undefined ? { consumerProtocol: input.consumerProtocol } : {}),
        ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
        ...(input.maxConfidenceBps !== undefined ? { maxConfidenceBps: input.maxConfidenceBps } : {}),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        evidence: result.evidence,
        facts: result.facts,
      };
    }
    if (capability === 'markets') {
      if (input.priceFeedIds && input.priceFeedIds.length > 0) {
        const result = await this.pythPriceFeedsBatch({
          priceFeedIds: input.priceFeedIds,
          ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
          ...(input.includeEma !== undefined ? { includeEma: input.includeEma } : {}),
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          batch: result.batch,
          facts: result.facts,
        };
      }
      if (input.query?.trim()) {
        const result = await this.pythFeedSearch({
          query: input.query,
          ...(input.assetType !== undefined ? { assetType: input.assetType } : {}),
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          search: result.search,
          facts: result.facts,
        };
      }
      if (!input.priceFeedId?.trim() && !input.symbol?.trim()) {
        throw new ProtocolError(
          'invalid_request',
          'Pyth markets read requires priceFeedId, priceFeedIds, symbol, or query.',
        );
      }
      const result = await this.pythPriceFeed({
        ...(input.priceFeedId !== undefined ? { priceFeedId: input.priceFeedId } : {}),
        ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
        ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
        ...(input.includeEma !== undefined ? { includeEma: input.includeEma } : {}),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async wormholeConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('wormhole');
    const capability = input.capability ?? (input.walletAddress ? 'positions' : input.amount ? 'bridge' : 'markets');
    if (capability === 'markets') {
      const result = await this.wormholeSupportedRoutes({
        ...(input.sourceChain !== undefined ? { sourceChain: input.sourceChain } : {}),
        ...(input.destinationChain !== undefined ? { destinationChain: input.destinationChain } : {}),
        ...(input.sourceMint !== undefined ? { mintAddress: input.sourceMint } : input.reserveMint !== undefined ? { mintAddress: input.reserveMint } : {}),
        ...(input.routeType !== undefined ? { routeType: input.routeType } : {}),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'bridge') {
      if (input.txid?.trim() || input.vaa?.trim() || input.sequence?.trim() || input.transferId?.trim()) {
        const result = await this.wormholeTransferStatus({
          ...(input.txid !== undefined ? { txid: input.txid } : {}),
          ...(input.vaa !== undefined ? { vaa: input.vaa } : {}),
          ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
          ...(input.transferId !== undefined ? { transferId: input.transferId } : {}),
          ...(input.sourceChain !== undefined ? { sourceChain: input.sourceChain } : {}),
          ...(input.destinationChain !== undefined ? { destinationChain: input.destinationChain } : {}),
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          snapshot: result.snapshot,
          facts: result.facts,
        };
      }
      if (!input.amount?.trim()) {
        throw new ProtocolError('invalid_request', 'amount is required to read Wormhole quote facts.');
      }
      if (!input.sourceMint?.trim()) {
        throw new ProtocolError('invalid_request', 'sourceMint is required to read Wormhole quote facts.');
      }
      if (!input.destinationChain?.trim() || !input.destinationAddress?.trim()) {
        throw new ProtocolError('invalid_request', 'destinationChain and destinationAddress are required to read Wormhole quote facts.');
      }
      const result = await this.wormholeQuote({
        sourceMint: input.sourceMint,
        amount: input.amount,
        destinationChain: input.destinationChain,
        destinationAddress: input.destinationAddress,
        ...(input.routeType !== undefined ? { routeType: input.routeType } : {}),
        ...(input.nativeGasDropoff !== undefined ? { nativeGasDropoff: input.nativeGasDropoff } : {}),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      const result = await this.wormholeWalletBridgeExposure({
        ...(input.walletAddress !== undefined ? { walletAddress: input.walletAddress } : {}),
        ...(input.includePendingTransfers !== undefined ? { includePendingTransfers: input.includePendingTransfers } : {}),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async kaminoConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('kamino');
    const capability = input.capability ?? (input.walletAddress ? 'positions' : 'markets');
    if (capability === 'markets' || capability === 'earn') {
      const result = await this.kaminoReserveSnapshot({
        ...(input.token !== undefined && { token: input.token }),
        ...(input.reserveMint !== undefined && { reserveMint: input.reserveMint }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability: 'markets',
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      const result = await this.kaminoGetPositions({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        walletAddress: result.walletAddress,
        positions: result.positions,
        totals: result.totals,
        facts: result.facts,
      };
    }
    if (capability === 'rewards') {
      const result = await this.kaminoPrepareEarningsProof({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.reserveMint !== undefined && { reserveMint: input.reserveMint }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        proof: {
          payload: result.payload,
          canonicalBase64: result.canonicalBase64,
        },
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async jupiterConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('jupiter');
    const capability = input.capability ?? (input.mints && input.mints.length > 0 ? 'price' : input.mint || input.query || input.tag || input.category ? 'tokens' : 'swap');
    if (capability === 'tokens') {
      if (input.tag) {
        const result = await this.jupiterTokensByTag({
          tag: input.tag,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        return { connector: connectorCapabilityView(connector, this.config), capability, tag: result.tag, facts: result.facts };
      }
      if (input.category) {
        const interval = input.interval ?? '24h';
        const result = await this.jupiterTokenCategory({
          category: input.category,
          interval,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        return { connector: connectorCapabilityView(connector, this.config), capability, category: result.category, facts: result.facts };
      }
      const mint = input.mint ?? input.sourceMint ?? input.reserveMint;
      if (mint?.trim()) {
        const result = await this.jupiterTokenRiskEvidence({
          mint,
          ...(input.includePrice !== undefined ? { includePrice: input.includePrice } : {}),
          ...(input.includeSearchFallback !== undefined ? { includeSearchFallback: input.includeSearchFallback } : {}),
        });
        return { connector: connectorCapabilityView(connector, this.config), capability, evidence: result.evidence, facts: result.facts };
      }
      if (input.query?.trim()) {
        const result = await this.jupiterTokenSearch({
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        return { connector: connectorCapabilityView(connector, this.config), capability, search: result.search, facts: result.facts };
      }
      const recent = await this.jupiterRecentTokens({
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return { connector: connectorCapabilityView(connector, this.config), capability, recent: recent.recent, facts: recent.facts };
    }
    if (capability === 'price') {
      if (input.mints && input.mints.length > 0) {
        const result = await this.jupiterPriceBatch({ mints: input.mints });
        return { connector: connectorCapabilityView(connector, this.config), capability, batch: result.batch, facts: result.facts };
      }
      const mint = input.mint ?? input.sourceMint ?? input.reserveMint;
      if (!mint?.trim()) {
        throw new ProtocolError('invalid_request', 'mint or mints is required to read Jupiter price facts.');
      }
      const result = await this.jupiterPrice({ mint });
      return { connector: connectorCapabilityView(connector, this.config), capability, price: result.price, facts: result.facts };
    }
    if (capability === 'earn') {
      if (input.walletAddress?.trim()) {
        const earnings = await this.jupiterLendEarnPositions({
          walletAddress: input.walletAddress,
          ...(input.reserveMint ? { assetMint: input.reserveMint } : {}),
        });
        return { connector: connectorCapabilityView(connector, this.config), capability, ...earnings };
      }
      const reserveMint = input.reserveMint ?? input.mint;
      if (reserveMint?.trim()) {
        const detail = await this.jupiterLendEarnTokenDetail({ assetMint: reserveMint });
        return { connector: connectorCapabilityView(connector, this.config), capability, ...detail };
      }
      const tokens = await this.jupiterLendEarnTokens({});
      return { connector: connectorCapabilityView(connector, this.config), capability, ...tokens };
    }
    if (capability === 'markets') {
      if (input.reserveMint?.trim() || input.mint?.trim()) {
        const detail = await this.jupiterLendEarnTokenDetail({
          assetMint: (input.reserveMint ?? input.mint) as string,
        });
        return { connector: connectorCapabilityView(connector, this.config), capability, ...detail };
      }
      const vaults = await this.jupiterLendBorrowVaults({});
      return { connector: connectorCapabilityView(connector, this.config), capability, ...vaults };
    }
    if (capability === 'positions') {
      const walletAddress = input.walletAddress?.trim() || (await this.backend.getAddress());
      const positions = await this.jupiterLendBorrowPositions({ walletAddress });
      return { connector: connectorCapabilityView(connector, this.config), capability, ...positions };
    }
    if (capability === 'borrow' || capability === 'withdraw' || capability === 'repay') {
      throw new ProtocolError(
        'invalid_request',
        'Jupiter Borrow health preview needs an explicit vaultId. Call solana_jupiter_lend_borrow_health_preview.',
      );
    }
    if (capability === 'prediction') {
      const result = await this.dispatchJupiterPredictionRead(input);
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        ...result,
      };
    }
    if (capability === 'perps') {
      const status = await this.jupiterPerpsStatus({});
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        ...status,
      };
    }
    if (capability === 'trigger') {
      const result = await this.dispatchJupiterTriggerRead(input);
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        ...result,
      };
    }
    if (capability === 'recurring') {
      const result = await this.dispatchJupiterRecurringRead(input);
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        ...result,
      };
    }
    if (capability !== 'swap') {
      throw missingConnectorCapability(connector, capability, 'read');
    }
    if (!input.amount?.trim()) {
      throw new ProtocolError('invalid_request', 'amount is required to read Jupiter swap preview facts.');
    }
    const preview = await this.jupiterOrderPreview({
      ...(input.inputToken !== undefined && { inputToken: input.inputToken }),
      ...(input.outputToken !== undefined && { outputToken: input.outputToken }),
      amount: input.amount,
      ...(input.slippageBps !== undefined && { slippageBps: input.slippageBps }),
      ...(input.taker !== undefined && { taker: input.taker }),
    });
    return {
      connector: connectorCapabilityView(connector, this.config),
      capability,
      preview,
      facts: preview.facts,
    };
  }

  private async dispatchJupiterTriggerRead(
    input: ConnectorFactReadInput,
  ): Promise<Record<string, unknown>> {
    const op = input.triggerOperation
      ?? (input.triggerOrderId ? 'order_detail' : 'orders');
    switch (op) {
      case 'auth_status':
        return this.jupiterTriggerAuthStatus({
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        });
      case 'vault':
        return this.jupiterTriggerVault({
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        });
      case 'orders':
        return this.jupiterTriggerOrders({
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
          ...(input.triggerState !== undefined && { state: input.triggerState }),
          ...(input.limit !== undefined && { limit: input.limit }),
        });
      case 'order_history':
        return this.jupiterTriggerOrderHistory({
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
          ...(input.triggerState !== undefined && { state: input.triggerState }),
          ...(input.limit !== undefined && { limit: input.limit }),
        });
      case 'order_detail':
        if (!input.triggerOrderId) {
          throw new ProtocolError('invalid_request', 'triggerOrderId is required for Jupiter Trigger order_detail.');
        }
        return this.jupiterTriggerOrderDetail({
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
          orderId: input.triggerOrderId,
        });
    }
  }

  private async dispatchJupiterRecurringRead(
    input: ConnectorFactReadInput,
  ): Promise<Record<string, unknown>> {
    const op = input.recurringOperation ?? (input.recurringOrderId ? 'order_detail' : 'orders');
    switch (op) {
      case 'orders':
        return this.jupiterRecurringOrders({
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
          ...(input.recurringState !== undefined && { state: input.recurringState }),
          ...(input.limit !== undefined && { limit: input.limit }),
          ...(input.recurringPage !== undefined && { page: input.recurringPage }),
          ...(input.inputMint !== undefined && { inputMint: input.inputMint }),
          ...(input.outputMint !== undefined && { outputMint: input.outputMint }),
          ...(input.recurringType !== undefined && { recurringType: input.recurringType }),
          ...(input.includeFailedTx !== undefined && { includeFailedTx: input.includeFailedTx }),
        });
      case 'order_detail':
        if (!input.recurringOrderId) {
          throw new ProtocolError('invalid_request', 'recurringOrderId is required for Jupiter Recurring order_detail.');
        }
        return this.jupiterRecurringOrderDetail({
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
          orderId: input.recurringOrderId,
          ...(input.recurringType !== undefined && { recurringType: input.recurringType }),
        });
      case 'quote':
        if (
          !input.inputMint ||
          !input.outputMint ||
          (!input.amount && !input.amountRaw) ||
          !input.recurringNumberOfOrders ||
          !input.recurringIntervalSeconds
        ) {
          throw new ProtocolError(
            'invalid_request',
            'inputMint, outputMint, amount or amountRaw, recurringNumberOfOrders, and recurringIntervalSeconds are required for Jupiter Recurring quote.',
          );
        }
        return this.jupiterRecurringQuote({
          inputMint: input.inputMint,
          outputMint: input.outputMint,
          ...(input.amount !== undefined ? { totalAmount: input.amount } : {}),
          ...(input.amountRaw !== undefined ? { totalAmountRaw: input.amountRaw } : {}),
          numberOfOrders: input.recurringNumberOfOrders,
          intervalSeconds: input.recurringIntervalSeconds,
          ...(input.recurringStartAt !== undefined && { startAt: input.recurringStartAt }),
          ...(input.recurringMinPrice !== undefined && { minPrice: input.recurringMinPrice }),
          ...(input.recurringMaxPrice !== undefined && { maxPrice: input.recurringMaxPrice }),
        });
    }
  }

  private async dispatchJupiterPredictionRead(
    input: ConnectorFactReadInput,
  ): Promise<Record<string, unknown>> {
    const op = input.predictionOperation
      ?? (input.predictionOrderId
        ? 'order_status'
        : input.predictionMarketId
          ? 'market_detail'
          : input.predictionEventId
            ? 'event_detail'
            : input.query?.trim()
              ? 'search_events'
              : 'events');
    switch (op) {
      case 'events':
        return this.jupiterPredictionEvents({
          ...(input.predictionProvider !== undefined && { provider: input.predictionProvider }),
          ...(input.predictionIncludeMarkets !== undefined && { includeMarkets: input.predictionIncludeMarkets }),
          ...(input.predictionCategory !== undefined && { category: input.predictionCategory }),
          ...(input.predictionSortBy !== undefined && { sortBy: input.predictionSortBy }),
          ...(input.predictionSortDirection !== undefined && { sortDirection: input.predictionSortDirection }),
          ...(input.predictionFilter !== undefined && { filter: input.predictionFilter }),
          ...(input.predictionStart !== undefined && { start: input.predictionStart }),
          ...(input.predictionEnd !== undefined && { end: input.predictionEnd }),
        });
      case 'search_events':
        if (!input.query?.trim()) {
          throw new ProtocolError('invalid_request', 'query is required for prediction search.');
        }
        return this.jupiterPredictionSearchEvents({
          query: input.query,
          ...(input.predictionProvider !== undefined && { provider: input.predictionProvider }),
          ...(input.predictionLimit !== undefined && { limit: input.predictionLimit }),
        });
      case 'event_detail':
        if (!input.predictionEventId) {
          throw new ProtocolError('invalid_request', 'predictionEventId is required for event_detail.');
        }
        return this.jupiterPredictionEventDetail({
          eventId: input.predictionEventId,
          ...(input.predictionIncludeMarkets !== undefined && { includeMarkets: input.predictionIncludeMarkets }),
        });
      case 'event_markets':
        if (!input.predictionEventId) {
          throw new ProtocolError('invalid_request', 'predictionEventId is required for event_markets.');
        }
        return this.jupiterPredictionEventMarkets({ eventId: input.predictionEventId });
      case 'market_detail':
        if (!input.predictionMarketId) {
          throw new ProtocolError('invalid_request', 'predictionMarketId is required for market_detail.');
        }
        return this.jupiterPredictionMarketDetail({ marketId: input.predictionMarketId });
      case 'orderbook':
        if (!input.predictionMarketId) {
          throw new ProtocolError('invalid_request', 'predictionMarketId is required for orderbook.');
        }
        return this.jupiterPredictionOrderbook({ marketId: input.predictionMarketId });
      case 'orders':
        return this.jupiterPredictionOrders({
          ...(input.predictionOwner !== undefined && { owner: input.predictionOwner }),
          ...(input.predictionMarketId !== undefined && { marketId: input.predictionMarketId }),
          ...(input.predictionStatus !== undefined && { status: input.predictionStatus }),
        });
      case 'order_status':
        if (!input.predictionOrderId) {
          throw new ProtocolError('invalid_request', 'predictionOrderId is required for order_status.');
        }
        return this.jupiterPredictionOrderStatus({
          orderId: input.predictionOrderId,
          ...(input.predictionOwner !== undefined && { owner: input.predictionOwner }),
        });
      case 'positions':
        return this.jupiterPredictionPositions({
          ...(input.predictionOwner !== undefined && { owner: input.predictionOwner }),
          ...(input.predictionMarketId !== undefined && { marketId: input.predictionMarketId }),
          ...(input.predictionEventId !== undefined && { eventId: input.predictionEventId }),
        });
      case 'history':
        return this.jupiterPredictionHistory({
          ...(input.predictionOwner !== undefined && { owner: input.predictionOwner }),
          ...(input.predictionMarketId !== undefined && { marketId: input.predictionMarketId }),
          ...(input.predictionEventId !== undefined && { eventId: input.predictionEventId }),
          ...(input.predictionLimit !== undefined && { limit: input.predictionLimit }),
        });
      case 'vault_info':
        return this.jupiterPredictionVaultInfo({
          ...(input.predictionOwner !== undefined && { owner: input.predictionOwner }),
        });
      default:
        throw new ProtocolError(
          'unsupported_method',
          `Jupiter Prediction operation ${op} is not supported. v1 ships read-only endpoints only.`,
        );
    }
  }

  private async meteoraConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('meteora');
    const capability = input.capability ?? (input.positionAddress ? 'positions' : input.poolAddress ? 'markets' : 'positions');
    if (capability === 'markets') {
      if (!input.poolAddress?.trim()) {
        throw new ProtocolError('invalid_request', 'poolAddress is required to read Meteora DLMM market facts.');
      }
      const result = await this.meteoraPoolSnapshot({ poolAddress: input.poolAddress });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      if (input.positionAddress?.trim()) {
        if (!input.poolAddress?.trim()) {
          throw new ProtocolError('invalid_request', 'poolAddress is required with positionAddress to read Meteora position detail facts.');
        }
        const result = await this.meteoraPositionDetail({
          poolAddress: input.poolAddress,
          positionAddress: input.positionAddress,
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          position: result.position,
          facts: result.facts,
        };
      }
      const result = await this.meteoraWalletPositions({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.poolAddress !== undefined && { poolAddress: input.poolAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        walletAddress: result.walletAddress,
        positions: result.positions,
        totals: result.totals,
        facts: result.facts,
      };
    }
    if (capability === 'rewards') {
      if (!input.poolAddress?.trim() || !input.positionAddress?.trim()) {
        throw new ProtocolError('invalid_request', 'poolAddress and positionAddress are required to read Meteora fee and reward facts.');
      }
      const result = await this.meteoraPositionDetail({
        poolAddress: input.poolAddress,
        positionAddress: input.positionAddress,
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        position: result.position,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async orcaConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('orca');
    const capability = input.capability ?? (input.positionMint ? 'positions' : input.whirlpoolAddress ? 'markets' : 'positions');
    if (capability === 'markets') {
      if (!input.whirlpoolAddress?.trim()) {
        throw new ProtocolError('invalid_request', 'whirlpoolAddress is required to read Orca Whirlpool market facts.');
      }
      const result = await this.orcaWhirlpoolSnapshot({
        whirlpoolAddress: input.whirlpoolAddress,
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      if (input.positionMint?.trim()) {
        const result = await this.orcaPositionDetail({
          positionMint: input.positionMint,
          ...(input.whirlpoolAddress !== undefined && { whirlpoolAddress: input.whirlpoolAddress }),
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          position: result.position,
          facts: result.facts,
        };
      }
      const result = await this.orcaWalletPositions({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.whirlpoolAddress !== undefined && { whirlpoolAddress: input.whirlpoolAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        walletAddress: result.walletAddress,
        positions: result.positions,
        totals: result.totals,
        facts: result.facts,
      };
    }
    if (capability === 'rewards') {
      if (!input.positionMint?.trim()) {
        throw new ProtocolError('invalid_request', 'positionMint is required to read Orca fee and reward facts.');
      }
      const result = await this.orcaPositionDetail({
        positionMint: input.positionMint,
        ...(input.whirlpoolAddress !== undefined && { whirlpoolAddress: input.whirlpoolAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        position: result.position,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async raydiumConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('raydium');
    const capability = input.capability ?? (input.positionMint ? 'positions' : input.poolId ? 'markets' : 'positions');
    if (capability === 'markets') {
      if (!input.poolId?.trim()) {
        throw new ProtocolError('invalid_request', 'poolId is required to read Raydium market facts.');
      }
      const result = await this.raydiumPoolSnapshot({
        poolId: input.poolId,
        ...(input.poolType !== undefined && { poolType: input.poolType }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      if (input.positionMint?.trim()) {
        const result = await this.raydiumPositionDetail({
          positionMint: input.positionMint,
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
          ...(input.poolId !== undefined && { poolId: input.poolId }),
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          position: result.position,
          facts: result.facts,
        };
      }
      const result = await this.raydiumWalletPositions({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.poolId !== undefined && { poolId: input.poolId }),
        ...(input.poolType !== undefined && { poolType: input.poolType }),
        ...(input.farmId !== undefined && { farmId: input.farmId }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        walletAddress: result.walletAddress,
        positions: result.positions,
        totals: result.totals,
        facts: result.facts,
      };
    }
    if (capability === 'rewards') {
      if (input.positionMint?.trim()) {
        const result = await this.raydiumPositionDetail({
          positionMint: input.positionMint,
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
          ...(input.poolId !== undefined && { poolId: input.poolId }),
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          position: result.position,
          facts: result.facts,
        };
      }
      const result = await this.raydiumWalletPositions({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.poolId !== undefined && { poolId: input.poolId }),
        ...(input.poolType !== undefined && { poolType: input.poolType }),
        ...(input.farmId !== undefined && { farmId: input.farmId }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        walletAddress: result.walletAddress,
        positions: result.positions,
        totals: result.totals,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async marginfiConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('marginfi');
    const capability = input.capability ?? marginfiDefaultCapability(input);
    if (capability === 'markets') {
      const result = await this.marginfiBankSnapshot({
        ...(input.bankAddress !== undefined && { bankAddress: input.bankAddress }),
        ...(input.bankMint !== undefined && { bankMint: input.bankMint }),
        token: input.token ?? 'SOL',
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      if (input.marginfiAccount?.trim()) {
        const result = await this.marginfiAccountDetail({
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
          marginfiAccount: input.marginfiAccount,
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          account: result.account,
          facts: result.facts,
        };
      }
      const result = await this.marginfiWalletAccounts({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        walletAddress: result.walletAddress,
        accounts: result.accounts,
        facts: result.facts,
      };
    }
    if (capability === 'earn' && !input.amount?.trim()) {
      const result = await this.marginfiBankSnapshot({
        ...(input.bankAddress !== undefined && { bankAddress: input.bankAddress }),
        ...(input.bankMint !== undefined && { bankMint: input.bankMint }),
        token: input.token ?? 'SOL',
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability: 'markets',
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'earn' || capability === 'borrow' || capability === 'withdraw' || capability === 'repay') {
      const operation = capability === 'earn' ? 'deposit' : capability;
      const result = await this.marginfiHealthPreview({
        operation,
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.bankAddress !== undefined && { bankAddress: input.bankAddress }),
        ...(input.bankMint !== undefined && { bankMint: input.bankMint }),
        token: input.token ?? 'SOL',
        ...(input.amount !== undefined && { amount: input.amount }),
        ...(input.marginfiAccount !== undefined && { marginfiAccount: input.marginfiAccount }),
        ...(input.withdrawAll !== undefined && { withdrawAll: input.withdrawAll }),
        ...(input.repayAll !== undefined && { repayAll: input.repayAll }),
        ...(input.createAccountIfMissing !== undefined && { createAccountIfMissing: input.createAccountIfMissing }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        preview: result.preview,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async project0ConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('project0');
    const capability = input.capability ?? project0DefaultCapability(input);
    if (capability === 'markets') {
      const result = await this.project0Banks({
        ...(input.bankAddress !== undefined && { bankAddress: input.bankAddress }),
        ...(input.bankMint !== undefined && { bankMint: input.bankMint }),
        token: input.token ?? input.mint ?? 'SOL',
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        banks: result.banks,
        facts: result.facts,
      };
    }
    if (capability === 'strategies') {
      const result = await this.project0Strategies();
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        strategies: result.strategies,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      if (input.project0Account?.trim()) {
        const result = await this.project0AccountDetail({
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
          project0Account: input.project0Account,
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          account: result.account,
          facts: result.facts,
        };
      }
      if (input.walletAddress?.trim()) {
        const result = await this.project0Wallet({ walletAddress: input.walletAddress });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          wallet: result.wallet,
          facts: result.facts,
        };
      }
      const result = await this.project0AccountDetail({});
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        account: result.account,
        facts: result.facts,
      };
    }
    if (capability === 'earn' || capability === 'borrow' || capability === 'withdraw' || capability === 'repay') {
      const operation = capability === 'earn' ? 'deposit' : capability;
      const result = await this.project0HealthPreview({
        operation,
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.bankAddress !== undefined && { bankAddress: input.bankAddress }),
        ...(input.bankMint !== undefined && { bankMint: input.bankMint }),
        token: input.token ?? 'SOL',
        ...(input.amount !== undefined && { amount: input.amount }),
        ...(input.project0Account !== undefined && { project0Account: input.project0Account }),
        ...(input.withdrawAll !== undefined && { withdrawAll: input.withdrawAll }),
        ...(input.repayAll !== undefined && { repayAll: input.repayAll }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        preview: result.preview,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async driftConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('drift');
    const capability = input.capability ?? driftDefaultCapability(input);
    if (capability === 'markets') {
      if (!input.vaultAddress?.trim()) {
        throw new ProtocolError(
          'invalid_request',
          'vaultAddress is required to read Drift vault market facts.',
        );
      }
      const result = await this.driftVaultSnapshot({ vaultAddress: input.vaultAddress });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'withdraw') {
      if (!input.vaultAddress?.trim()) {
        throw new ProtocolError(
          'invalid_request',
          'vaultAddress is required to read Drift withdraw status.',
        );
      }
      const result = await this.driftWithdrawStatus({
        vaultAddress: input.vaultAddress,
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        status: result.status,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      if (input.subAccountId !== undefined) {
        const result = await this.driftUserSnapshot({
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
          subAccountId: input.subAccountId,
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          source: 'user_snapshot',
          snapshot: result.snapshot,
          facts: result.facts,
        };
      }
      const result = await this.driftWalletVaultPositions({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.vaultAddress !== undefined && { vaultAddress: input.vaultAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        walletAddress: result.walletAddress,
        positions: result.positions,
        totals: result.totals,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async realmsConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('realms');
    const capability = input.capability ?? realmsDefaultCapability(input);

    if (input.proposalAddress?.trim()) {
      const result = await this.realmsProposalSnapshot({
        proposalAddress: input.proposalAddress,
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        source: 'proposal_snapshot',
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (input.governanceAddress?.trim()) {
      const result = await this.realmsGovernanceSnapshot({
        governanceAddress: input.governanceAddress,
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        source: 'governance_snapshot',
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (input.realmAddress?.trim() && !input.walletAddress?.trim()) {
      const result = await this.realmsRealmSnapshot({
        realmAddress: input.realmAddress,
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        source: 'realm_snapshot',
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions' || capability === 'governance' || capability === 'markets') {
      const result = await this.realmsWalletGovernance({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.realmAddress !== undefined && { realmAddress: input.realmAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        source: 'wallet_governance',
        walletAddress: result.walletAddress,
        snapshots: result.snapshots,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async squadsConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('squads');
    const capability =
      input.capability ??
      (input.proposalAddress?.trim() || input.transactionIndex !== undefined
        ? 'governance'
        : input.multisigAddress?.trim()
          ? input.vaultIndex !== undefined
            ? 'treasury'
            : 'governance'
          : 'positions');

    if (input.multisigAddress?.trim() && (input.proposalAddress?.trim() || input.transactionIndex !== undefined)) {
      const result = await this.squadsProposalSnapshot({
        multisigAddress: input.multisigAddress,
        ...(input.proposalAddress !== undefined && { proposalAddress: input.proposalAddress }),
        ...(input.transactionIndex !== undefined && { transactionIndex: input.transactionIndex }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        source: 'proposal_snapshot',
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (input.multisigAddress?.trim() && input.vaultIndex !== undefined) {
      const result = await this.squadsVaultSnapshot({
        multisigAddress: input.multisigAddress,
        vaultIndex: input.vaultIndex,
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        source: 'vault_snapshot',
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (input.multisigAddress?.trim()) {
      const result = await this.squadsMultisigSnapshot({
        multisigAddress: input.multisigAddress,
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        source: 'multisig_snapshot',
        snapshot: result.snapshot,
        summary: result.summary,
        walletRole: result.walletRole,
        facts: result.facts,
      };
    }
    if (capability === 'positions' || capability === 'governance') {
      const result = await this.squadsWalletAuthority({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        source: 'wallet_authority',
        walletAddress: result.walletAddress,
        authority: result.authority,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async luloConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('lulo');
    const capability = input.capability ?? (input.walletAddress ? 'positions' : 'markets');
    if (capability === 'markets' || capability === 'earn') {
      const result = await this.luloRates({
        ...(input.reserveMint !== undefined ? { mintAddress: input.reserveMint } : {}),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability: 'markets',
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      const result = await this.luloWalletBalances({
        ...(input.walletAddress !== undefined ? { walletAddress: input.walletAddress } : {}),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async saveConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('save');
    const capability = input.capability ?? (input.walletAddress ? 'positions' : 'markets');
    if (capability === 'markets' || capability === 'earn') {
      const result = await this.saveReserveSnapshot({
        ...(input.token !== undefined && { token: input.token }),
        ...(input.reserveMint !== undefined && { reserveMint: input.reserveMint }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability: 'markets',
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      const result = await this.saveWalletObligation({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        walletAddress: result.walletAddress,
        obligation: result.obligation,
        facts: result.facts,
      };
    }
    if (capability === 'borrow' || capability === 'withdraw' || capability === 'repay') {
      if (!input.amount?.trim()) {
        throw new ProtocolError('invalid_request', 'amount is required to preview a Save health impact.');
      }
      const operation = capability === 'borrow' ? 'borrow' : capability === 'withdraw' ? 'withdraw' : 'repay';
      const result = await this.saveHealthPreview({
        operation,
        amount: input.amount,
        ...(input.token !== undefined && { token: input.token }),
        ...(input.reserveMint !== undefined && { reserveMint: input.reserveMint }),
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        preview: result.preview,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async jitoConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('jito');
    const hasQuoteInput = Boolean(input.jitoOperation || input.amount || input.solAmount || input.jitoSolAmount || input.stakeAccount);
    const hasReceiptInput = input.claimableOnly !== undefined || input.receiptAddress !== undefined;
    const capability = input.capability ?? (hasQuoteInput ? 'earn' : input.walletAddress || hasReceiptInput ? 'positions' : 'markets');
    if (capability === 'markets') {
      const result = await this.jitoStakePoolSnapshot({
        ...(input.includeValidators !== undefined && { includeValidators: input.includeValidators }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      if (hasReceiptInput) {
        const result = await this.jitoDepositReceipts({
          ...(input.receiptAddress !== undefined && { receiptAddress: input.receiptAddress }),
          ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
          ...(input.claimableOnly !== undefined && { claimableOnly: input.claimableOnly }),
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability,
          walletAddress: result.walletAddress,
          receipts: result.receipts,
          totals: result.totals,
          facts: result.facts,
        };
      }
      const result = await this.jitoWalletPositions({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        includeStakeAccounts: input.includeStakeAccounts ?? true,
        ...(input.delegatedOnly !== undefined && { delegatedOnly: input.delegatedOnly }),
        ...(input.eligibleForJitoDepositOnly !== undefined && { eligibleForJitoDepositOnly: input.eligibleForJitoDepositOnly }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        walletAddress: result.walletAddress,
        jitoSol: result.jitoSol,
        stakeAccounts: result.stakeAccounts,
        totals: result.totals,
        facts: result.facts,
      };
    }
    if (capability === 'earn' || capability === 'withdraw') {
      const operation = input.jitoOperation ?? (capability === 'earn' ? 'stake_sol' : 'unstake_jitosol');
      const result = await this.jitoQuote({
        operation,
        ...(input.solAmount !== undefined ? { solAmount: input.solAmount } : input.amount !== undefined && operation === 'stake_sol' ? { solAmount: input.amount } : {}),
        ...(input.jitoSolAmount !== undefined ? { jitoSolAmount: input.jitoSolAmount } : input.amount !== undefined && operation === 'unstake_jitosol' ? { jitoSolAmount: input.amount } : {}),
        ...(input.stakeAccount !== undefined && { stakeAccount: input.stakeAccount }),
        ...(input.withdrawMode !== undefined && { withdrawMode: input.withdrawMode }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        quote: result.quote,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async marinadeConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('marinade');
    const capability = input.capability ?? (input.walletAddress ? 'positions' : input.amount || input.solAmount || input.msolAmount ? 'earn' : 'markets');
    if (capability === 'markets') {
      const result = await this.marinadeStateSnapshot();
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      const result = await this.marinadeWalletPositions({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'earn' || capability === 'withdraw' || capability === 'swap') {
      const operation = input.marinadeOperation ?? (capability === 'earn' ? 'liquid_stake' : 'liquid_unstake');
      const result = await this.marinadeQuote({
        operation,
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
        ...(input.solAmount !== undefined ? { solAmount: input.solAmount } : input.amount !== undefined && operation === 'liquid_stake' ? { solAmount: input.amount } : {}),
        ...(input.msolAmount !== undefined ? { msolAmount: input.msolAmount } : input.amount !== undefined && operation !== 'liquid_stake' ? { msolAmount: input.amount } : {}),
        ...(input.minSolAmount !== undefined && { minSolAmount: input.minSolAmount }),
        ...(input.minMsolAmount !== undefined && { minMsolAmount: input.minMsolAmount }),
        ...(input.ticketAccount !== undefined && { ticketAccount: input.ticketAccount }),
        ...(input.slippageBps !== undefined && { slippageBps: input.slippageBps }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        quote: result.quote,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  private async sanctumConnectorFacts(input: ConnectorFactReadInput): Promise<Record<string, unknown>> {
    const connector = requireRuntimeConnector('sanctum');
    const capability = input.capability ?? (input.walletAddress ? 'positions' : input.amount ? 'swap' : 'markets');
    if (capability === 'markets' || capability === 'earn') {
      const mintOrSymbol = input.lstMint ?? input.reserveMint ?? input.token;
      if (mintOrSymbol?.trim()) {
        const result = await this.sanctumLstSnapshot({
          lstMint: mintOrSymbol,
          includeApy: true,
        });
        return {
          connector: connectorCapabilityView(connector, this.config),
          capability: 'markets',
          snapshot: result.snapshot,
          facts: result.facts,
        };
      }
      const result = await this.sanctumInfinityPoolSnapshot({ includeComposition: true });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability: 'markets',
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'positions') {
      const result = await this.sanctumWalletPositions({
        ...(input.walletAddress !== undefined && { walletAddress: input.walletAddress }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        snapshot: result.snapshot,
        facts: result.facts,
      };
    }
    if (capability === 'swap' || capability === 'withdraw' || capability === 'add_liquidity') {
      const inputMint = input.inputMint ?? input.reserveMint ?? input.token;
      const outputMint = input.outputMint ?? input.lstMint ?? input.outputToken;
      if (!inputMint?.trim() || !outputMint?.trim() || !input.amount?.trim()) {
        throw new ProtocolError(
          'invalid_request',
          'inputMint, outputMint, and amount are required to read Sanctum quote facts.',
        );
      }
      const result = await this.sanctumQuote({
        inputMint,
        outputMint,
        amount: input.amount,
        ...(input.slippageBps !== undefined && { slippageBps: input.slippageBps }),
      });
      return {
        connector: connectorCapabilityView(connector, this.config),
        capability,
        quote: result.quote,
        facts: result.facts,
      };
    }
    throw missingConnectorCapability(connector, capability, 'read');
  }

  async kaminoReserveSnapshot(input: { token?: string; reserveMint?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('kamino');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.reserve_snapshot;
    if (!read) throw new AdapterError('kamino', 'unsupported_method', 'Kamino reserve snapshot read is not registered.');
    const snapshot = await read.read(input, this.adapterContext(adapter));
    return {
      snapshot,
      facts: factsFromKaminoReserveSnapshot(snapshot as Parameters<typeof factsFromKaminoReserveSnapshot>[0]),
    };
  }

  async kaminoGetPositions(input: { walletAddress?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('kamino');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.positions;
    if (!read) throw new AdapterError('kamino', 'unsupported_method', 'Kamino positions read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      walletAddress: string;
      positions: Parameters<typeof factsFromKaminoPositions>[0]['positions'];
      totals?: Parameters<typeof factsFromKaminoPositions>[0]['totals'];
    } & Record<string, unknown>;
    return {
      ...result,
      facts: factsFromKaminoPositions({
        walletAddress: result.walletAddress,
        positions: result.positions,
        ...(result.totals !== undefined && { totals: result.totals }),
      }),
    };
  }

  async kaminoPrepareEarningsProof(input: { walletAddress?: string; reserveMint?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('kamino');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.earnings_proof;
    if (!read) throw new AdapterError('kamino', 'unsupported_method', 'Kamino earnings proof read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
    return {
      ...result,
      facts: factsFromKaminoEarningsProof(result as unknown as Parameters<typeof factsFromKaminoEarningsProof>[0]),
    };
  }

  async meteoraPoolSnapshot(input: { poolAddress: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('meteora');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.pool_snapshot;
    if (!read) throw new AdapterError('meteora', 'unsupported_method', 'Meteora DLMM pool snapshot read is not registered.');
    const snapshot = await read.read(input, this.adapterContext(adapter));
    return {
      snapshot,
      facts: factsFromMeteoraPoolSnapshot(snapshot as Parameters<typeof factsFromMeteoraPoolSnapshot>[0]),
    };
  }

  async meteoraWalletPositions(input: { walletAddress?: string; poolAddress?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('meteora');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_positions;
    if (!read) throw new AdapterError('meteora', 'unsupported_method', 'Meteora wallet positions read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      walletAddress: string;
      poolAddress?: string;
      positions: Parameters<typeof factsFromMeteoraPositions>[0]['positions'];
      totals?: Parameters<typeof factsFromMeteoraPositions>[0]['totals'];
    } & Record<string, unknown>;
    return {
      ...result,
      facts: factsFromMeteoraPositions({
        walletAddress: result.walletAddress,
        positions: result.positions,
        ...(result.poolAddress !== undefined && { poolAddress: result.poolAddress }),
        ...(result.totals !== undefined && { totals: result.totals }),
      }),
    };
  }

  async meteoraPositionDetail(input: { poolAddress: string; positionAddress: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('meteora');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.position_detail;
    if (!read) throw new AdapterError('meteora', 'unsupported_method', 'Meteora position detail read is not registered.');
    const position = await read.read(input, this.adapterContext(adapter));
    return {
      position,
      facts: factsFromMeteoraPositionDetail(position as Parameters<typeof factsFromMeteoraPositionDetail>[0]),
    };
  }

  async orcaWhirlpoolSnapshot(input: { whirlpoolAddress: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('orca');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.whirlpool_snapshot;
    if (!read) throw new AdapterError('orca', 'unsupported_method', 'Orca Whirlpool snapshot read is not registered.');
    const snapshot = await read.read(input, this.adapterContext(adapter));
    return {
      snapshot,
      facts: factsFromOrcaWhirlpoolSnapshot(snapshot as Parameters<typeof factsFromOrcaWhirlpoolSnapshot>[0]),
    };
  }

  async orcaWalletPositions(input: { walletAddress?: string; whirlpoolAddress?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('orca');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_positions;
    if (!read) throw new AdapterError('orca', 'unsupported_method', 'Orca wallet positions read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromOrcaPositions>[0];
    return {
      ...result,
      facts: factsFromOrcaPositions(result),
    };
  }

  async orcaPositionDetail(input: { positionMint: string; whirlpoolAddress?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('orca');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.position_detail;
    if (!read) throw new AdapterError('orca', 'unsupported_method', 'Orca position detail read is not registered.');
    const position = await read.read(input, this.adapterContext(adapter));
    return {
      position,
      facts: factsFromOrcaPositionDetail(position as Parameters<typeof factsFromOrcaPositionDetail>[0]),
    };
  }

  async raydiumPoolSnapshot(input: { poolId: string; poolType?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('raydium');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.pool_snapshot;
    if (!read) throw new AdapterError('raydium', 'unsupported_method', 'Raydium pool snapshot read is not registered.');
    const snapshot = await read.read(input, this.adapterContext(adapter));
    return {
      snapshot,
      facts: factsFromRaydiumPoolSnapshot(snapshot as Parameters<typeof factsFromRaydiumPoolSnapshot>[0]),
    };
  }

  async raydiumWalletPositions(input: {
    walletAddress?: string;
    poolId?: string;
    poolType?: string;
    farmId?: string;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('raydium');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_positions;
    if (!read) throw new AdapterError('raydium', 'unsupported_method', 'Raydium wallet positions read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromRaydiumPositions>[0];
    return {
      ...result,
      facts: factsFromRaydiumPositions(result),
    };
  }

  async raydiumPositionDetail(input: {
    walletAddress?: string;
    positionMint: string;
    poolId?: string;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('raydium');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.position_detail;
    if (!read) throw new AdapterError('raydium', 'unsupported_method', 'Raydium position detail read is not registered.');
    const position = await read.read(input, this.adapterContext(adapter));
    return {
      position,
      facts: factsFromRaydiumPositionDetail(position as Parameters<typeof factsFromRaydiumPositionDetail>[0]),
    };
  }

  async marginfiBankSnapshot(input: {
    bankAddress?: string;
    bankMint?: string;
    token?: string;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('marginfi');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.bank_snapshot;
    if (!read) throw new AdapterError('marginfi', 'unsupported_method', 'MarginFi bank snapshot read is not registered.');
    const snapshot = await read.read(input, this.adapterContext(adapter));
    return {
      snapshot,
      facts: factsFromMarginfiBankSnapshot(snapshot as Parameters<typeof factsFromMarginfiBankSnapshot>[0]),
    };
  }

  async marginfiWalletAccounts(input: { walletAddress?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('marginfi');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_accounts;
    if (!read) throw new AdapterError('marginfi', 'unsupported_method', 'MarginFi wallet account read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      walletAddress: string;
      accounts: Parameters<typeof factsFromMarginfiAccountSummaries>[0]['accounts'];
    } & Record<string, unknown>;
    return {
      ...result,
      facts: factsFromMarginfiAccountSummaries({
        walletAddress: result.walletAddress,
        accounts: result.accounts,
      }),
    };
  }

  async marginfiAccountDetail(input: {
    walletAddress?: string;
    marginfiAccount?: string;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('marginfi');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.account_detail;
    if (!read) throw new AdapterError('marginfi', 'unsupported_method', 'MarginFi account detail read is not registered.');
    const account = await read.read(input, this.adapterContext(adapter));
    return {
      account,
      facts: factsFromMarginfiAccountDetail(account as Parameters<typeof factsFromMarginfiAccountDetail>[0]),
    };
  }

  async marginfiHealthPreview(
    input: MarginfiActionInput & {
      operation: 'deposit' | 'withdraw' | 'borrow' | 'repay';
      walletAddress?: string;
    },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('marginfi');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.health_preview;
    if (!read) throw new AdapterError('marginfi', 'unsupported_method', 'MarginFi health preview read is not registered.');
    const preview = await read.read(
      {
        ...input,
        minHealthRatio: marginfiMinHealthRatio(this.config),
      },
      this.adapterContext(adapter),
    );
    return {
      preview,
      facts: factsFromMarginfiHealthPreview(preview as Parameters<typeof factsFromMarginfiHealthPreview>[0]),
    };
  }

  async project0Banks(input: {
    bankAddress?: string;
    bankMint?: string;
    token?: string;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('project0');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.banks;
    if (!read) throw new AdapterError('project0', 'unsupported_method', 'Project 0 bank read is not registered.');
    const banks = await read.read(input, this.adapterContext(adapter));
    return {
      banks,
      facts: factsFromProject0Banks(banks as Parameters<typeof factsFromProject0Banks>[0]),
    };
  }

  async project0Strategies(): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('project0');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.strategies;
    if (!read) throw new AdapterError('project0', 'unsupported_method', 'Project 0 strategy read is not registered.');
    const strategies = await read.read({}, this.adapterContext(adapter));
    return {
      strategies,
      facts: factsFromProject0Strategies(strategies as Parameters<typeof factsFromProject0Strategies>[0]),
    };
  }

  async project0Wallet(input: { walletAddress?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('project0');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet;
    if (!read) throw new AdapterError('project0', 'unsupported_method', 'Project 0 wallet read is not registered.');
    const wallet = await read.read(input, this.adapterContext(adapter));
    return {
      wallet,
      facts: factsFromProject0Wallet(wallet as Parameters<typeof factsFromProject0Wallet>[0]),
    };
  }

  async project0AccountDetail(input: {
    walletAddress?: string;
    project0Account?: string;
  }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('project0');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.account_detail;
    if (!read) throw new AdapterError('project0', 'unsupported_method', 'Project 0 account detail read is not registered.');
    const account = await read.read(input, this.adapterContext(adapter));
    return {
      account,
      facts: factsFromProject0AccountDetail(account as Parameters<typeof factsFromProject0AccountDetail>[0]),
    };
  }

  async project0HealthPreview(
    input: Project0PrepareInput & {
      operation: 'deposit' | 'withdraw' | 'borrow' | 'repay';
      walletAddress?: string;
      minHealthRatio?: number;
    },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('project0');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.health_preview;
    if (!read) throw new AdapterError('project0', 'unsupported_method', 'Project 0 health preview read is not registered.');
    const preview = await read.read(
      {
        ...input,
        minHealthRatio: input.minHealthRatio ?? project0MinHealthRatio(this.config),
      },
      this.adapterContext(adapter),
    );
    return {
      preview,
      facts: factsFromProject0HealthPreview(preview as Parameters<typeof factsFromProject0HealthPreview>[0]),
    };
  }

  async driftUserSnapshot(
    input: { walletAddress?: string; subAccountId?: number },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('drift');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.user_snapshot;
    if (!read) throw new AdapterError('drift', 'unsupported_method', 'Drift user snapshot read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async driftVaultSnapshot(input: { vaultAddress: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('drift');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.vault_snapshot;
    if (!read) throw new AdapterError('drift', 'unsupported_method', 'Drift vault snapshot read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async driftWalletVaultPositions(
    input: { walletAddress?: string; vaultAddress?: string },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('drift');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_vault_positions;
    if (!read) throw new AdapterError('drift', 'unsupported_method', 'Drift wallet vault positions read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async driftWithdrawStatus(
    input: { walletAddress?: string; vaultAddress: string },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('drift');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.withdraw_status;
    if (!read) throw new AdapterError('drift', 'unsupported_method', 'Drift withdraw status read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async squadsWalletAuthority(
    input: { walletAddress?: string; includeProposals?: boolean },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('squads');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_authority;
    if (!read) throw new AdapterError('squads', 'unsupported_method', 'Squads wallet authority read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async squadsMultisigSnapshot(
    input: {
      multisigAddress: string;
      includeMembers?: boolean;
      includeVaults?: boolean;
      includeProposals?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('squads');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.multisig_snapshot;
    if (!read) throw new AdapterError('squads', 'unsupported_method', 'Squads multisig snapshot read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async squadsVaultSnapshot(
    input: {
      multisigAddress: string;
      vaultIndex?: number;
      vaultAddress?: string;
      includeBalances?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('squads');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.vault_snapshot;
    if (!read) throw new AdapterError('squads', 'unsupported_method', 'Squads vault snapshot read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async squadsProposalSnapshot(
    input: {
      multisigAddress: string;
      proposalAddress?: string;
      transactionIndex?: number;
      includeInstructions?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('squads');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.proposal_snapshot;
    if (!read) throw new AdapterError('squads', 'unsupported_method', 'Squads proposal snapshot read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async squadsProposalList(
    input: {
      multisigAddress: string;
      status?: 'draft' | 'active' | 'approved' | 'rejected' | 'executed' | 'cancelled' | 'expired' | 'all';
      limit?: number;
    },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('squads');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.proposal_list;
    if (!read) throw new AdapterError('squads', 'unsupported_method', 'Squads proposal list read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async realmsWalletGovernance(
    input: { walletAddress?: string; realmAddress?: string; includeInactive?: boolean },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('realms');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_governance;
    if (!read) throw new AdapterError('realms', 'unsupported_method', 'Realms wallet governance read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async realmsRealmSnapshot(
    input: { realmAddress: string; includeGovernances?: boolean; includeTokenMints?: boolean },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('realms');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.realm_snapshot;
    if (!read) throw new AdapterError('realms', 'unsupported_method', 'Realms realm snapshot read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async realmsGovernanceSnapshot(
    input: { governanceAddress: string; includeConfig?: boolean; includeProposals?: boolean },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('realms');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.governance_snapshot;
    if (!read) throw new AdapterError('realms', 'unsupported_method', 'Realms governance snapshot read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async realmsProposalList(
    input: {
      realmAddress: string;
      governanceAddress?: string;
      state?: 'draft' | 'signing_off' | 'voting' | 'succeeded' | 'defeated' | 'executing' | 'completed' | 'cancelled' | 'executing_with_errors' | 'vetoed' | 'all';
      limit?: number;
    },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('realms');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.proposal_list;
    if (!read) throw new AdapterError('realms', 'unsupported_method', 'Realms proposal list read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async realmsProposalSnapshot(
    input: { proposalAddress: string; includeInstructions?: boolean; includeVoteBreakdown?: boolean },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('realms');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.proposal_snapshot;
    if (!read) throw new AdapterError('realms', 'unsupported_method', 'Realms proposal snapshot read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async realmsVoteRecord(
    input: { proposalAddress: string; walletAddress?: string },
  ): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('realms');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.vote_record;
    if (!read) throw new AdapterError('realms', 'unsupported_method', 'Realms vote record read is not registered.');
    return (await read.read(input, this.adapterContext(adapter))) as Record<string, unknown>;
  }

  async saveReserveSnapshot(input: { token?: string; reserveMint?: string; marketAddress?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('save');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.reserve_snapshot;
    if (!read) throw new AdapterError('save', 'unsupported_method', 'Save reserve snapshot read is not registered.');
    const snapshot = await read.read(input, this.adapterContext(adapter));
    return {
      snapshot,
      facts: factsFromSaveReserveSnapshot(snapshot as Parameters<typeof factsFromSaveReserveSnapshot>[0]),
    };
  }

  async saveListReserves(input: { marketAddress?: string } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('save');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.list_reserves;
    if (!read) throw new AdapterError('save', 'unsupported_method', 'Save list reserves read is not registered.');
    const reserves = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromSaveReserveSnapshot>[0][];
    return {
      reserves,
      facts: reserves.flatMap((reserve) => factsFromSaveReserveSnapshot(reserve)),
    };
  }

  async saveMarketSnapshot(input: { marketAddress?: string } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('save');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.market_snapshot;
    if (!read) throw new AdapterError('save', 'unsupported_method', 'Save market snapshot read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromSaveMarketSnapshot>[0];
    return {
      snapshot,
      facts: factsFromSaveMarketSnapshot(snapshot),
    };
  }

  async saveWalletObligation(input: { walletAddress?: string; marketAddress?: string }): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('save');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_obligation;
    if (!read) throw new AdapterError('save', 'unsupported_method', 'Save wallet obligation read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      walletAddress: string;
      cluster: Cluster;
      obligation: Parameters<typeof factsFromSaveObligation>[0]['obligation'];
    };
    return {
      ...result,
      facts: factsFromSaveObligation({
        walletAddress: result.walletAddress,
        obligation: result.obligation,
      }),
    };
  }

  async saveHealthPreview(input: SaveHealthPreviewInput): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('save');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.health_preview;
    if (!read) throw new AdapterError('save', 'unsupported_method', 'Save health preview read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as SaveHealthPreviewResult;
    return {
      preview: result,
      facts: factsFromSaveHealthPreview(result.preview, {
        operation: result.operation,
        reserveSymbol: result.reserveSymbol,
      }),
    };
  }

  async jitoStakePoolSnapshot(input: { includeValidators?: boolean } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jito');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.stake_pool_snapshot;
    if (!read) throw new AdapterError('jito', 'unsupported_method', 'Jito stake pool snapshot read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromJitoStakePoolSnapshot>[0];
    return {
      snapshot,
      facts: factsFromJitoStakePoolSnapshot(snapshot),
    };
  }

  async jitoWalletPositions(input: {
    walletAddress?: string;
    includeStakeAccounts?: boolean;
    delegatedOnly?: boolean;
    eligibleForJitoDepositOnly?: boolean;
  } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jito');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_positions;
    if (!read) throw new AdapterError('jito', 'unsupported_method', 'Jito wallet positions read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromJitoWalletPositions>[0];
    return {
      ...snapshot,
      facts: factsFromJitoWalletPositions(snapshot),
    };
  }

  async jitoWalletStakeAccounts(input: {
    walletAddress?: string;
    delegatedOnly?: boolean;
    eligibleForJitoDepositOnly?: boolean;
  } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jito');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_stake_accounts;
    if (!read) throw new AdapterError('jito', 'unsupported_method', 'Jito wallet stake accounts read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as {
      walletAddress: string;
      stakeAccounts: Parameters<typeof factsFromJitoStakeAccounts>[0]['stakeAccounts'];
    };
    return {
      ...result,
      facts: factsFromJitoStakeAccounts(result),
    };
  }

  async jitoDepositReceipts(input: {
    walletAddress?: string;
    receiptAddress?: string;
    claimableOnly?: boolean;
  } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jito');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.deposit_receipts;
    if (!read) throw new AdapterError('jito', 'unsupported_method', 'Jito deposit receipts read is not registered.');
    const result = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromJitoDepositReceipts>[0];
    return {
      ...result,
      facts: factsFromJitoDepositReceipts(result),
    };
  }

  async jitoQuote(input: JitoQuoteInput): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('jito');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.quote;
    if (!read) throw new AdapterError('jito', 'unsupported_method', 'Jito quote read is not registered.');
    const quote = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromJitoQuote>[0];
    return {
      quote,
      facts: factsFromJitoQuote(quote),
    };
  }

  async marinadeStateSnapshot(): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('marinade');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.state_snapshot;
    if (!read) throw new AdapterError('marinade', 'unsupported_method', 'Marinade state snapshot read is not registered.');
    const snapshot = (await read.read({}, this.adapterContext(adapter))) as Parameters<typeof factsFromMarinadeStateSnapshot>[0];
    return {
      snapshot,
      facts: factsFromMarinadeStateSnapshot(snapshot),
    };
  }

  async marinadeWalletPositions(input: { walletAddress?: string } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('marinade');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_positions;
    if (!read) throw new AdapterError('marinade', 'unsupported_method', 'Marinade wallet positions read is not registered.');
    const snapshot = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMarinadeWalletPositions>[0];
    return {
      snapshot,
      facts: factsFromMarinadeWalletPositions(snapshot),
    };
  }

  async marinadeWalletStakeAccounts(input: { walletAddress?: string } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('marinade');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.wallet_stake_accounts;
    if (!read) throw new AdapterError('marinade', 'unsupported_method', 'Marinade wallet stake accounts read is not registered.');
    const stakeAccounts = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMarinadeStakeAccounts>[0]['stakeAccounts'];
    const walletAddress = input.walletAddress ?? await this.backend.getAddress();
    const result = { walletAddress, stakeAccounts };
    return {
      ...result,
      facts: factsFromMarinadeStakeAccounts(result),
    };
  }

  async marinadeUnstakeTickets(input: { walletAddress?: string; claimableOnly?: boolean } = {}): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('marinade');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.unstake_tickets;
    if (!read) throw new AdapterError('marinade', 'unsupported_method', 'Marinade unstake tickets read is not registered.');
    const tickets = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMarinadeUnstakeTickets>[0]['tickets'];
    const walletAddress = input.walletAddress ?? await this.backend.getAddress();
    const result = { walletAddress, tickets };
    return {
      ...result,
      facts: factsFromMarinadeUnstakeTickets(result),
    };
  }

  async marinadeQuote(input: MarinadeQuoteReadInput): Promise<Record<string, unknown>> {
    const adapter = requireAdapter('marinade');
    assertSupportedCluster(adapter, this.config.cluster);
    const read = adapter.reads.quote;
    if (!read) throw new AdapterError('marinade', 'unsupported_method', 'Marinade quote read is not registered.');
    const quote = (await read.read(input, this.adapterContext(adapter))) as Parameters<typeof factsFromMarinadeQuote>[0];
    return {
      quote,
      facts: factsFromMarinadeQuote(quote),
    };
  }

  async prepareSwap(input: PrepareSwapInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const swap = await normalizeSwapInput(this.config, this.connection, input);
    const from = await this.backend.getAddress();
    const minimumOutputRaw = minimumOutputRawFromSwapInput(input, swap);
    const quoteSnapshot = input.captureQuoteSnapshot === true
      ? orderSummary(await fetchJupiterOrder(this.config, undefined, swap))
      : undefined;
    const action = await this.store().addAction({
      kind: 'swap',
      walletAddress: from,
      cluster: this.config.cluster,
      summary: `Swap ${input.amount} ${swap.inputSymbol} to ${swap.outputSymbol}`,
      params: {
        connectorId: 'jupiter',
        product: 'swap',
        operation: 'swap',
        approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
        inputToken: swap.inputSymbol,
        outputToken: swap.outputSymbol,
        inputMint: swap.inputMint,
        outputMint: swap.outputMint,
        amount: input.amount,
        amountRaw: swap.amountRaw.toString(),
        slippageBps: swap.slippageBps,
        ...(input.minOutputAmount !== undefined && { minOutputAmount: input.minOutputAmount }),
        ...(minimumOutputRaw !== undefined && { otherAmountThreshold: minimumOutputRaw }),
        ...(quoteSnapshot !== undefined && { quoteSnapshot }),
        maxSwapInput: this.config.mainnet.maxSwapInput,
        apiBaseUrlHost: jupiterApiHost(this.config, 'swap'),
        preparedAt: new Date().toISOString(),
        refreshAtExecution: true,
      },
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    });
    const tokenEvidence = await this.jupiterSwapTokenEvidence({
      requestedInputToken: input.inputToken,
      requestedOutputToken: input.outputToken,
      inputMint: swap.inputMint,
      outputMint: swap.outputMint,
    });
    return {
      preparedAction: action,
      ...(tokenEvidence.evidence.length > 0 && { tokenEvidence: tokenEvidence.evidence }),
      ...(tokenEvidence.facts.length > 0 && { facts: tokenEvidence.facts }),
    };
  }

  async listPreparedActions(): Promise<Record<string, unknown>> {
    const store = this.store();
    const walletAddress = await this.connectedWalletAddress();
    const materialized = await store.materializeDueRecurring();
    const actions = await store.listActions();
    return {
      materialized: this.filterActionsForWallet(materialized, walletAddress),
      actions: this.filterActionsForWallet(actions, walletAddress),
    };
  }

  async rejectPreparedAction(actionId: string, reason?: string): Promise<Record<string, unknown>> {
    const store = this.store();
    await this.requireOwnedPreparedAction(store, actionId);
    return {
      preparedAction: await store.updateAction(actionId, {
        status: 'rejected',
        ...(reason !== undefined && { error: reason }),
      }),
    };
  }

  async archivePreparedAction(actionId: string): Promise<Record<string, unknown>> {
    const store = this.store();
    await this.requireOwnedPreparedAction(store, actionId);
    return { preparedAction: await store.archiveAction(actionId) };
  }

  async deletePreparedAction(actionId: string): Promise<Record<string, unknown>> {
    const store = this.store();
    await this.requireOwnedPreparedAction(store, actionId);
    return { deleted: await store.deleteAction(actionId) };
  }

  async prepareTransactionForActionApproval(
    actionId: string,
  ): Promise<PreparedTransactionPayload> {
    requireActionAllowed(this.config);
    const store = this.store();
    const action = await this.requireOwnedPreparedAction(store, actionId);
    if (TERMINAL_PREPARED_ACTION_STATUSES.has(action.status)) {
      throw new ProtocolError(
        'invalid_request',
        `Prepared action ${action.id} is already ${action.status}.`,
      );
    }
    return prepareTransactionForApproval(action, this.adapterContext());
  }

  async prepareConnectorTransactionStateless(input: {
    kind: string;
    params: Record<string, unknown>;
    walletAddress: string;
    cluster: Cluster;
    summary?: string;
  }): Promise<PreparedTransactionPayload> {
    requireActionAllowed(this.config);
    const now = new Date().toISOString();
    const action: PreparedAction = {
      id: `stateless_${now}`,
      kind: input.kind as PreparedActionKind,
      status: 'ready',
      walletAddress: input.walletAddress,
      cluster: input.cluster,
      summary: input.summary ?? `Prepare ${input.kind.replace(/_/g, ' ')}`,
      params: input.params,
      dueAt: now,
      createdAt: now,
      updatedAt: now,
    };
    return prepareTransactionForApproval(action, this.adapterContext());
  }

  async executePreparedAction(actionId: string): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const store = this.store();
    const action = await this.requireOwnedPreparedAction(store, actionId);
    assertPreparedActionExecutable(action);
    await store.updateAction(actionId, { status: 'approval_pending' });
    try {
      const result = await this.executePreparedActionRecord(action);
      const txids = result.txids?.filter((txid) => txid.trim()) ?? [];
      const txid = typeof result.txid === 'string' && result.txid.trim()
        ? result.txid
        : txids[0];
      const updated = await store.updateAction(actionId, {
        status: 'approved',
        ...(txid !== undefined ? { txid } : {}),
        ...(txids.length > 0 ? { txids } : {}),
        ...(txid !== undefined || txids.length > 0 ? { txStatus: 'pending' as const } : {}),
        confirmedAt: undefined,
        txError: undefined,
        error: undefined,
      });
      return { preparedAction: updated, result };
    } catch (err) {
      await store.updateAction(actionId, {
        status: preparedFailureStatus(err),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async recordPreparedActionTransaction(input: {
    actionId: string;
    txid?: string;
    txids?: string[];
    txStatus?: PreparedActionTxStatus;
    error?: string;
  }): Promise<Record<string, unknown>> {
    const store = this.store();
    await this.requireOwnedPreparedAction(store, input.actionId);
    const txStatus = input.txStatus ?? 'pending';
    const now = new Date().toISOString();
    const txids = input.txids?.filter((txid) => txid.trim()) ?? [];
    const txid = input.txid ?? txids[0];
    const updated = await store.updateAction(input.actionId, {
      status: txStatus === 'failed' ? 'failed' : 'approved',
      ...(txid !== undefined && { txid }),
      ...(txids.length > 0 && { txids }),
      txStatus,
      confirmedAt: txStatus === 'confirmed' ? now : undefined,
      txError: txStatus === 'failed' ? input.error ?? 'Transaction failed.' : undefined,
      error: txStatus === 'failed' ? input.error ?? 'Transaction failed.' : undefined,
    });
    return { preparedAction: updated };
  }

  async refreshPreparedActionTxStatuses(): Promise<Record<string, unknown>> {
    const store = this.store();
    const walletAddress = await this.connectedWalletAddress();
    const actions = this.filterActionsForWallet(await store.listActions(), walletAddress);
    const pending = actions.filter((action) => txidsForAction(action).length > 0 && action.txStatus !== 'confirmed' && action.txStatus !== 'failed');
    const updates: Array<{ actionId: string; txid: string; txStatus: PreparedActionTxStatus }> = [];
    for (const action of pending) {
      const txids = txidsForAction(action);
      const statuses = await this.connection.getSignatureStatuses(txids);
      const failedIndex = statuses.value.findIndex((status) => Boolean(status?.err));
      if (failedIndex >= 0) {
        const txid = txids[failedIndex]!;
        await store.updateAction(action.id, {
          txStatus: 'failed',
          txError: JSON.stringify(statuses.value[failedIndex]?.err),
        });
        updates.push({ actionId: action.id, txid, txStatus: 'failed' });
        continue;
      }
      const allConfirmed = statuses.value.length === txids.length &&
        statuses.value.every((status) => status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized');
      if (allConfirmed) {
        await store.updateAction(action.id, {
          txStatus: 'confirmed',
          confirmedAt: new Date().toISOString(),
          txError: undefined,
        });
        updates.push({ actionId: action.id, txid: txids[0]!, txStatus: 'confirmed' });
        continue;
      }
      if (action.txStatus !== 'pending') {
        await store.updateAction(action.id, { txStatus: 'pending' });
        updates.push({ actionId: action.id, txid: txids[0]!, txStatus: 'pending' });
      }
    }
    return { updates, actions: this.filterActionsForWallet(await store.listActions(), walletAddress) };
  }

  async receipts(): Promise<Record<string, unknown>> {
    const walletAddress = await this.connectedWalletAddress();
    return { receipts: this.filterReceiptsForWallet(await this.store().listReceipts(), walletAddress) };
  }

  async createRecurringPayment(input: RecurringPaymentInput): Promise<Record<string, unknown>> {
    const store = this.store();
    const walletAddress = await this.connectedWalletAddress();
    const recurringPayment = await store.addRecurringPayment(
      await buildRecurringPaymentInput(input, walletAddress, this.config, this.connection),
    );
    const materialized = await store.materializeDueRecurring();
    return {
      recurringPayment,
      materialized: this.filterActionsForWallet(materialized, walletAddress),
      actions: this.filterActionsForWallet(await store.listActions(), walletAddress),
    };
  }

  async listRecurringPayments(): Promise<Record<string, unknown>> {
    const store = this.store();
    const walletAddress = await this.connectedWalletAddress();
    const materialized = await store.materializeDueRecurring();
    return {
      materialized: this.filterActionsForWallet(materialized, walletAddress),
      recurringPayments: this.filterRecurringPaymentsForWallet(await store.listRecurringPaymentViews(), walletAddress),
    };
  }

  async updateRecurringPayment(input: UpdateRecurringPaymentInput): Promise<Record<string, unknown>> {
    const store = this.store();
    const walletAddress = await this.connectedWalletAddress();
    const current = await this.requireOwnedRecurringPayment(store, input.recurringId);
    const mergedInput: RecurringPaymentInput = {
      ...current,
      ...input,
      slippageBps: normalizeRecurringSlippageBps(input.slippageBps ?? current.slippageBps),
    };
    const recurringPayment = await store.updateRecurringPayment(
      input.recurringId,
      await buildRecurringPaymentInput(mergedInput, current.walletAddress, this.config, this.connection),
    );
    const materialized = await store.materializeDueRecurring();
    return {
      recurringPayment,
      materialized: this.filterActionsForWallet(materialized, walletAddress),
      actions: this.filterActionsForWallet(await store.listActions(), walletAddress),
    };
  }

  async pauseRecurringPayment(recurringId: string): Promise<Record<string, unknown>> {
    const store = this.store();
    await this.requireOwnedRecurringPayment(store, recurringId);
    return { recurringPayment: await store.updateRecurringPayment(recurringId, { status: 'paused' }) };
  }

  async resumeRecurringPayment(recurringId: string): Promise<Record<string, unknown>> {
    const store = this.store();
    await this.requireOwnedRecurringPayment(store, recurringId);
    return { recurringPayment: await store.updateRecurringPayment(recurringId, { status: 'active' }) };
  }

  async deleteRecurringPayment(recurringId: string): Promise<Record<string, unknown>> {
    const store = this.store();
    await this.requireOwnedRecurringPayment(store, recurringId);
    return { deleted: await store.deleteRecurringPayment(recurringId) };
  }

  async transferSol(input: { recipient: string; amountSol: string }): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const lamports = parseDecimalAmount(input.amountSol, 9, 'SOL transfer amount');
    const from = new PublicKey(await this.backend.getAddress());
    const balance = await this.connection.getBalance(from, 'confirmed');
    if (BigInt(balance) < lamports) {
      throw new ProtocolError('unauthorized', `Insufficient SOL balance for ${input.amountSol} SOL transfer.`);
    }
    const to = new PublicKey(input.recipient);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: to,
        lamports: Number(lamports),
      }),
    );
    await prepareTransaction(this.connection, tx, from);
    const txid = await this.signAndBroadcastTransaction(tx, `Transfer ${input.amountSol} SOL to ${to.toBase58()}`);
    return {
      cluster: this.config.cluster,
      from: from.toBase58(),
      recipient: to.toBase58(),
      amountSol: input.amountSol,
      txid,
      explorerUrl: explorerUrl(txid, this.config.cluster),
    };
  }

  async transferSpl(input: { token: string; recipient: string; amount: string }): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const tokenConfig = await resolveToken(this.config, this.connection, input.token);
    const rawAmount = parseDecimalAmount(input.amount, tokenConfig.decimals, `${tokenConfig.symbol} amount`);
    const owner = new PublicKey(await this.backend.getAddress());
    const recipientOwner = new PublicKey(input.recipient);
    const mint = new PublicKey(tokenConfig.mint);
    const sourceAta = await getAssociatedTokenAddress(mint, owner, tokenConfig.tokenProgramId);
    const sourceBalance = await this.connection.getTokenAccountBalance(sourceAta).catch(() => null);
    if (!sourceBalance || BigInt(sourceBalance.value.amount) < rawAmount) {
      throw new ProtocolError('unauthorized', `Insufficient ${tokenConfig.symbol} balance for ${input.amount} transfer.`);
    }
    const destinationAta = await getAssociatedTokenAddress(mint, recipientOwner, tokenConfig.tokenProgramId);
    const tx = new Transaction();
    const destinationAccount = await this.connection.getAccountInfo(destinationAta, 'confirmed');
    if (!destinationAccount) {
      tx.add(createAssociatedTokenAccountInstruction(owner, destinationAta, recipientOwner, mint, tokenConfig.tokenProgramId));
    }
    tx.add(createTransferCheckedInstruction(sourceAta, mint, destinationAta, owner, rawAmount, tokenConfig.decimals, tokenConfig.tokenProgramId));
    await prepareTransaction(this.connection, tx, owner);
    const txid = await this.signAndBroadcastTransaction(
      tx,
      `Transfer ${input.amount} ${tokenConfig.symbol} to ${recipientOwner.toBase58()}`,
    );
    return {
      cluster: this.config.cluster,
      from: owner.toBase58(),
      recipient: recipientOwner.toBase58(),
      token: tokenConfig.symbol,
      mint: tokenConfig.mint,
      amount: input.amount,
      txid,
      explorerUrl: explorerUrl(txid, this.config.cluster),
    };
  }

  async getSwapQuote(input: SwapInput): Promise<Record<string, unknown>> {
    return this.jupiterOrderPreview(input);
  }

  async jupiterOrderPreview(input: SwapOrderInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const order = await this.getSwapOrder(input);
    const summary = orderSummary(order);
    const tokenEvidence = await this.jupiterSwapTokenEvidence({
      requestedInputToken: input.inputToken,
      requestedOutputToken: input.outputToken,
      inputMint: summary.inputMint,
      outputMint: summary.outputMint,
    });
    return {
      ...summary,
      ...(tokenEvidence.evidence.length > 0 && { tokenEvidence: tokenEvidence.evidence }),
      facts: [
        ...factsFromJupiterOrderPreview(summary),
        ...tokenEvidence.facts,
      ],
    };
  }

  async jupiterPerpsStatus(input: JupiterPerpsStatusInput = {}): Promise<Record<string, unknown>> {
    assertJupiterSwapCluster(this.config);
    const snapshot = buildPerpsStatus(this.config, input);
    return {
      connectorId: 'jupiter' as const,
      product: 'perps' as const,
      readOnly: true,
      apiStatus: snapshot.apiStatus,
      officialDocsStatus: snapshot.officialDocsStatus,
      data: snapshot,
      warnings: snapshot.warnings,
      facts: factsFromJupiterPerpsStatus(snapshot),
    };
  }

  async jupiterPerpsPoolSnapshot(input: JupiterPerpsPoolSnapshotInput): Promise<Record<string, unknown>> {
    assertJupiterSwapCluster(this.config);
    getJupiterPerpsPoolSnapshot(input);
  }

  async jupiterPerpsCustodySnapshot(input: JupiterPerpsCustodySnapshotInput): Promise<Record<string, unknown>> {
    assertJupiterSwapCluster(this.config);
    getJupiterPerpsCustodySnapshot(input);
  }

  async jupiterPerpsPositionSnapshot(input: JupiterPerpsPositionSnapshotInput = {}): Promise<Record<string, unknown>> {
    assertJupiterSwapCluster(this.config);
    const walletAddress = input.walletAddress?.trim() || (await this.backend.getAddress());
    getJupiterPerpsPositionSnapshot({ ...input, walletAddress });
  }

  async jupiterPredictionEvents(input: JupiterPredictionEventsInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const envelope = await getPredictionEvents(this.config, input);
    return { ...envelope, facts: factsFromJupiterPredictionEvents(envelope.data) };
  }

  async jupiterPredictionSearchEvents(
    input: JupiterPredictionSearchEventsInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const envelope = await searchPredictionEvents(this.config, input);
    return { ...envelope, facts: factsFromJupiterPredictionEvents(envelope.data) };
  }

  async jupiterPredictionEventDetail(
    input: JupiterPredictionEventDetailInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const envelope = await getPredictionEventDetail(this.config, input);
    return { ...envelope, facts: factsFromJupiterPredictionEventDetail(envelope.data) };
  }

  async jupiterPredictionEventMarkets(
    input: JupiterPredictionEventMarketsInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const envelope = await getPredictionEventMarkets(this.config, input);
    return { ...envelope, facts: factsFromJupiterPredictionEventDetail(envelope.data) };
  }

  async jupiterPredictionMarketDetail(
    input: JupiterPredictionMarketDetailInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const envelope = await getPredictionMarketDetail(this.config, input);
    return { ...envelope, facts: factsFromJupiterPredictionMarketDetail(envelope.data) };
  }

  async jupiterPredictionOrderbook(
    input: JupiterPredictionOrderbookInput,
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const envelope = await getPredictionOrderbook(this.config, input);
    return { ...envelope, facts: factsFromJupiterPredictionOrderbook(envelope.data) };
  }

  async jupiterPredictionOrders(
    input: { owner?: string; marketId?: string; status?: JupiterPredictionOrdersInput['status'] },
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const owner = input.owner?.trim() || (await this.backend.getAddress());
    const envelope = await getPredictionOrders(this.config, {
      owner,
      ...(input.marketId !== undefined && { marketId: input.marketId }),
      ...(input.status !== undefined && { status: input.status }),
    });
    return { ...envelope, facts: factsFromJupiterPredictionOrders(envelope.data) };
  }

  async jupiterPredictionOrderStatus(
    input: { orderId: string; owner?: string },
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const owner = input.owner?.trim() || (await this.backend.getAddress());
    const envelope = await getPredictionOrderStatus(this.config, { orderId: input.orderId, owner });
    return { ...envelope, facts: factsFromJupiterPredictionOrderStatus(envelope.data) };
  }

  async jupiterPredictionPositions(
    input: { owner?: string; marketId?: string; eventId?: string },
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const owner = input.owner?.trim() || (await this.backend.getAddress());
    const envelope = await getPredictionPositions(this.config, {
      owner,
      ...(input.marketId !== undefined && { marketId: input.marketId }),
      ...(input.eventId !== undefined && { eventId: input.eventId }),
    });
    return { ...envelope, facts: factsFromJupiterPredictionPositions(envelope.data) };
  }

  async jupiterPredictionHistory(
    input: { owner?: string; marketId?: string; eventId?: string; limit?: number },
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const owner = input.owner?.trim() || (await this.backend.getAddress());
    const envelope = await getPredictionHistory(this.config, {
      owner,
      ...(input.marketId !== undefined && { marketId: input.marketId }),
      ...(input.eventId !== undefined && { eventId: input.eventId }),
      ...(input.limit !== undefined && { limit: input.limit }),
    });
    return { ...envelope, facts: factsFromJupiterPredictionHistory(envelope.data) };
  }

  async jupiterPredictionVaultInfo(
    input: { owner?: string },
  ): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const owner = input.owner?.trim() || (await this.backend.getAddress());
    const envelope = await getPredictionVaultInfo(this.config, { owner });
    return { ...envelope, facts: factsFromJupiterPredictionVaultInfo(envelope.data) };
  }

  async getSwapOrder(input: SwapOrderInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const taker = input.taker ? new PublicKey(input.taker).toBase58() : await this.backend.getAddress();
    return fetchJupiterOrder(this.config, taker, await normalizeSwapInput(this.config, this.connection, input));
  }

  async executeSignedSwap(input: {
    signedTransaction: string;
    requestId: string;
    lastValidBlockHeight?: string | number;
  }): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    return executeJupiterOrder(this.config, input.signedTransaction, {
      requestId: input.requestId,
      ...(input.lastValidBlockHeight !== undefined && { lastValidBlockHeight: input.lastValidBlockHeight }),
    });
  }

  async swap(input: SwapInput): Promise<Record<string, unknown>> {
    requireActionAllowed(this.config);
    const taker = await this.backend.getAddress();
    const swap = await normalizeSwapInput(this.config, this.connection, input);
    return this.signAndExecuteJupiterSwap(input, taker, swap, minimumOutputRawFromSwapInput(input, swap));
  }

  private async signAndExecuteJupiterSwap(
    input: SwapInput,
    taker: string,
    swap: NormalizedSwapInput,
    minimumOutputRaw?: string,
  ): Promise<Record<string, unknown> & { txid: string }> {
    const order = await fetchJupiterOrder(this.config, taker, swap);
    if (!order.transaction || typeof order.transaction !== 'string') {
      throw new ProtocolError(
        'invalid_request',
        typeof order.errorMessage === 'string'
          ? order.errorMessage
          : 'Jupiter did not return a transaction for this order.',
      );
    }
    enforceMinimumPreparedOutput(order, minimumOutputRaw);
    const swapSummary = `Swap ${input.amount} ${swap.inputSymbol} to ${swap.outputSymbol}`;
    await this.simulateBeforeSign(order.transaction, swapSummary);
    const signed = await this.client.signTransaction(order.transaction, {
      cluster: this.config.cluster,
      summary: swapSummary,
    });
    const executed = await executeJupiterOrder(this.config, signed.signature, order);
    const txid = executionSignature(executed);
    return {
      ...orderSummary(order),
      status: executed.status,
      txid,
      explorerUrl: explorerUrl(txid, this.config.cluster),
      execution: executionSummary(executed),
    };
  }

  async executePreparedActionRecord(action: PreparedAction): Promise<Record<string, unknown> & { txid?: string; txids?: string[] }> {
    const currentAddress = await this.backend.getAddress();
    if (currentAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Prepared action belongs to ${action.walletAddress}, but connected wallet is ${currentAddress}.`,
      );
    }
    if (action.cluster !== this.config.cluster) {
      throw new ProtocolError(
        'cluster_mismatch',
        `Prepared action targets ${action.cluster}, but server is configured for ${this.config.cluster}.`,
      );
    }
    switch (action.kind) {
      case 'transfer_sol':
        return this.executePreparedSolTransfer(action);
      case 'transfer_spl':
        return this.executePreparedSplTransfer(action);
      case 'swap':
        return this.executePreparedSwap(action);
      case 'kamino_deposit':
      case 'kamino_withdraw':
      case 'meteora_claim_fees':
      case 'meteora_claim_rewards':
      case 'meteora_add_liquidity':
      case 'meteora_remove_liquidity':
      case 'meteora_close_position':
      case 'orca_increase_liquidity':
      case 'orca_decrease_liquidity':
      case 'orca_collect_fees':
      case 'orca_collect_rewards':
      case 'marginfi_deposit':
      case 'marginfi_withdraw':
      case 'marginfi_borrow':
      case 'marginfi_repay':
      case 'project0_create_account':
      case 'project0_deposit':
      case 'project0_withdraw':
      case 'project0_borrow':
      case 'project0_repay':
      case 'drift_vault_deposit':
      case 'drift_vault_request_withdraw':
      case 'drift_vault_cancel_withdraw':
      case 'drift_vault_complete_withdraw':
      case 'save_deposit':
      case 'save_withdraw':
      case 'save_borrow':
      case 'save_repay':
      case 'jito_stake_sol':
      case 'jito_deposit_stake_account':
      case 'jito_unstake_jitosol':
      case 'jito_withdraw_sol':
      case 'jito_claim_deposit_receipt':
      case 'marinade_liquid_stake':
      case 'marinade_liquid_unstake':
      case 'marinade_delayed_unstake':
      case 'marinade_claim_delayed_unstake':
      case 'lulo_deposit':
      case 'lulo_withdraw':
      case 'lulo_complete_withdraw':
      case 'raydium_add_liquidity':
      case 'raydium_remove_liquidity':
      case 'raydium_collect_fees':
      case 'raydium_farm_stake':
      case 'raydium_farm_unstake':
      case 'raydium_harvest':
      case 'tensor_buy':
      case 'tensor_list':
      case 'tensor_cancel_listing':
      case 'tensor_bid':
      case 'tensor_cancel_bid':
      case 'tensor_sweep':
      case 'magiceden_buy':
      case 'magiceden_list':
      case 'magiceden_cancel_listing':
      case 'magiceden_bid':
      case 'magiceden_cancel_bid':
      case 'sanctum_swap_lst':
      case 'sanctum_add_infinity_liquidity':
      case 'sanctum_remove_infinity_liquidity':
      case 'sanctum_stake_sol_to_lst':
      case 'sanctum_unstake_lst_to_sol':
      case 'realms_cast_vote':
      case 'realms_relinquish_vote':
      case 'realms_deposit_governance_tokens':
      case 'realms_withdraw_governance_tokens':
      case 'pyth_post_price_update':
      case 'squads_create_transfer_proposal':
      case 'squads_approve_proposal':
      case 'squads_reject_proposal':
      case 'squads_cancel_proposal':
      case 'squads_execute_proposal':
      case 'wormhole_transfer':
      case 'wormhole_redeem':
      case 'wormhole_recover_or_resume':
      case 'jupiter_lend_earn_deposit':
      case 'jupiter_lend_earn_withdraw':
      case 'jupiter_lend_earn_mint':
      case 'jupiter_lend_earn_redeem':
      case 'jupiter_lend_borrow_create_position':
      case 'jupiter_lend_borrow_deposit_collateral':
      case 'jupiter_lend_borrow_borrow':
      case 'jupiter_lend_borrow_repay':
      case 'jupiter_lend_borrow_withdraw_collateral':
      case 'jupiter_trigger_register_vault':
      case 'jupiter_trigger_single_order':
      case 'jupiter_trigger_oco_order':
      case 'jupiter_trigger_otoco_order':
      case 'jupiter_trigger_edit_order':
      case 'jupiter_trigger_cancel_order':
      case 'jupiter_trigger_withdraw_order_funds':
      case 'jupiter_recurring_create_time_order':
      case 'jupiter_recurring_cancel_order':
      case 'jupiter_recurring_deposit_price_order':
      case 'jupiter_recurring_withdraw_price_order':
        return this.executePreparedAdapterAction(action);
      case 'blink_action':
        return this.executePreparedBlinkAction(action);
      default:
        throw new ProtocolError(
          'unsupported_method',
          `Unsupported prepared action kind ${action.kind}.`,
        );
    }
  }

  private async executePreparedAdapterAction(action: PreparedAction): Promise<Record<string, unknown> & { txid?: string; txids?: string[] }> {
    const match = actionForKind(action.kind);
    if (!match) {
      throw new ProtocolError(
        'unsupported_method',
        `No adapter is registered for prepared action kind ${action.kind}.`,
      );
    }
    assertSupportedCluster(match.adapter, this.config.cluster);
    const result = await match.action.execute(action, this.adapterContext(match.adapter));
    return {
      adapter: match.adapter.id,
      action: match.action.id,
      ...(result.txid !== undefined && { txid: result.txid }),
      ...(result.txids !== undefined && { txids: result.txids }),
      signedAt: result.signedAt,
      ...(result.txid !== undefined && { explorerUrl: explorerUrl(result.txid, this.config.cluster) }),
      ...(result.txids !== undefined && { explorerUrls: result.txids.map((txid) => explorerUrl(txid, this.config.cluster)) }),
      ...(result.preview ? { preview: result.preview } : {}),
    };
  }

  private adapterContext(adapter?: DAppAdapter): DAppAdapterContext {
    void adapter;
    const signTransaction = async (transactionBase64: string, summary: string): Promise<string> => {
      await this.simulateBeforeSign(transactionBase64, summary);
      const signed = await this.client.signTransaction(transactionBase64, {
        cluster: this.config.cluster,
        summary,
      });
      return signed.signature;
    };
    const signAndBroadcast = async (transactionBase64: string, summary: string): Promise<string> => {
      await this.simulateBeforeSign(transactionBase64, summary);
      const signed = await this.client.signTransaction(transactionBase64, {
        cluster: this.config.cluster,
        summary,
      });
      return this.connection.sendRawTransaction(Buffer.from(signed.signature, 'base64'), {
        preflightCommitment: 'confirmed',
        maxRetries: 5,
      });
    };
    const signAndBroadcastMany = async (transactionsBase64: string[], summary: string): Promise<string[]> => {
      const txids: string[] = [];
      for (let index = 0; index < transactionsBase64.length; index += 1) {
        const suffix = transactionsBase64.length > 1 ? ` (${index + 1}/${transactionsBase64.length})` : '';
        txids.push(await signAndBroadcast(transactionsBase64[index]!, `${summary}${suffix}`));
      }
      return txids;
    };
    const signMessage = async (message: string, summary: string): Promise<string> => {
      const signed = await this.client.signMessage(message, {
        cluster: this.config.cluster,
        summary,
      });
      return signed.signature;
    };
    return {
      backend: this.backend,
      config: this.config,
      connection: this.connection,
      signTransaction,
      signAndBroadcast,
      signAndBroadcastMany,
      signMessage,
      store: this.store(),
    };
  }

  private store(): PreparedActionStore {
    if (!this.preparedActions) {
      throw new ProtocolError('unsupported_method', 'Prepared action store is not configured.');
    }
    return this.preparedActions;
  }

  private async connectedWalletAddress(): Promise<string> {
    return this.backend.getAddress();
  }

  private assertConnectedWalletOwns(recordWalletAddress: string, connectedWalletAddress: string, label: string): void {
    if (recordWalletAddress.trim().toLowerCase() !== connectedWalletAddress.trim().toLowerCase()) {
      throw new ProtocolError('unauthorized', `${label} belongs to a different wallet.`);
    }
  }

  private filterActionsForWallet(actions: PreparedAction[], walletAddress: string): PreparedAction[] {
    return actions.filter((action) => action.walletAddress.trim().toLowerCase() === walletAddress.trim().toLowerCase());
  }

  private filterReceiptsForWallet(receipts: ActionReceipt[], walletAddress: string): ActionReceipt[] {
    return receipts.filter((receipt) => receipt.walletAddress.trim().toLowerCase() === walletAddress.trim().toLowerCase());
  }

  private filterRecurringPaymentsForWallet<T extends RecurringPayment | RecurringPaymentView>(payments: T[], walletAddress: string): T[] {
    return payments.filter((payment) => payment.walletAddress.trim().toLowerCase() === walletAddress.trim().toLowerCase());
  }

  private async requireOwnedPreparedAction(store: PreparedActionStore, actionId: string): Promise<PreparedAction> {
    const action = await store.getAction(actionId);
    if (!action) {
      throw new ProtocolError('invalid_request', `Unknown prepared action: ${actionId}`);
    }
    this.assertConnectedWalletOwns(action.walletAddress, await this.connectedWalletAddress(), 'Prepared action');
    return action;
  }

  private async requireOwnedRecurringPayment(store: PreparedActionStore, recurringId: string): Promise<RecurringPayment> {
    const current = (await store.listRecurringPayments()).find((payment) => payment.id === recurringId);
    if (!current) {
      throw new ProtocolError('invalid_request', `Unknown recurring payment: ${recurringId}`);
    }
    this.assertConnectedWalletOwns(current.walletAddress, await this.connectedWalletAddress(), 'Recurring payment');
    return current;
  }

  private async executePreparedSolTransfer(action: PreparedAction): Promise<Record<string, unknown> & { txid: string }> {
    const recipient = requireStringParam(action, 'recipient');
    const amountSol = requireStringParam(action, 'amountSol');
    return this.transferSol({ recipient, amountSol }) as Promise<Record<string, unknown> & { txid: string }>;
  }

  private async executePreparedSplTransfer(action: PreparedAction): Promise<Record<string, unknown> & { txid: string }> {
    const token = requireStringParam(action, 'token');
    const recipient = requireStringParam(action, 'recipient');
    const amount = requireStringParam(action, 'amount');
    return this.transferSpl({ token, recipient, amount }) as Promise<Record<string, unknown> & { txid: string }>;
  }

  private async executePreparedSwap(action: PreparedAction): Promise<Record<string, unknown> & { txid: string }> {
    const input = {
      inputToken: requireStringParam(action, 'inputToken'),
      outputToken: requireStringParam(action, 'outputToken'),
      amount: requireStringParam(action, 'amount'),
      ...(typeof action.params.minOutputAmount === 'string' ? { minOutputAmount: action.params.minOutputAmount } : {}),
      slippageBps:
        typeof action.params.slippageBps === 'number'
          ? action.params.slippageBps
          : this.config.mainnet.maxSlippageBps,
    };
    const taker = await this.backend.getAddress();
    const swap = await normalizeSwapInput(this.config, this.connection, input);
    return this.signAndExecuteJupiterSwap(input, taker, swap, preparedMinimumOutputRaw(action));
  }

  private async executePreparedBlinkAction(action: PreparedAction): Promise<Record<string, unknown> & { txid: string }> {
    const transactionBase64 = await this.blinkTransactionBase64ForAction(action);
    const summary = action.summary || 'Blink action';
    await this.simulateBeforeSign(transactionBase64, summary);
    const signed = await this.client.signTransaction(transactionBase64, {
      cluster: this.config.cluster,
      summary,
    });
    const txid = await this.connection.sendRawTransaction(Buffer.from(signed.signature, 'base64'), {
      preflightCommitment: 'confirmed',
      maxRetries: 5,
    });
    return {
      txid,
      explorerUrl: explorerUrl(txid, this.config.cluster),
      connectorId: action.params.connectorId ?? null,
      protocol: action.params.protocol ?? null,
      operation: action.params.operation ?? null,
    };
  }

  private async blinkTransactionBase64ForAction(action: PreparedAction): Promise<string> {
    const stored = typeof action.params.transactionBase64 === 'string'
      ? action.params.transactionBase64.trim()
      : '';
    if (stored) return stored;
    const refreshed = await prepareBlinkActionRequest({
      url: requireStringParam(action, 'blinkUrl'),
      account: action.walletAddress,
      parameters: stringRecordParam(action, 'parameters'),
    });
    return refreshed.transactionBase64;
  }

  private async signAndBroadcastTransaction(transaction: Transaction, summary: string): Promise<string> {
    const transactionBase64 = txToBase64(transaction);
    await this.simulateBeforeSign(transactionBase64, summary);
    const signed = await this.client.signTransaction(transactionBase64, {
      cluster: this.config.cluster,
      summary,
    });
    return this.connection.sendRawTransaction(Buffer.from(signed.signature, 'base64'), {
      preflightCommitment: 'confirmed',
      maxRetries: 5,
    });
  }

  private async summarizeBlinkSimulation(transactionBase64: string): Promise<{
    ok: boolean;
    invokedPrograms: string[];
    closesTokenAccount: boolean;
    transfersSpl: boolean;
    transfersSol: boolean;
    logsTail: string[];
    unitsConsumed?: number;
    error?: string;
  }> {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(transactionBase64, 'base64');
    } catch (err) {
      return {
        ok: false,
        invokedPrograms: [],
        closesTokenAccount: false,
        transfersSpl: false,
        transfersSol: false,
        logsTail: [],
        error: err instanceof Error ? err.message : 'invalid base64',
      };
    }
    let invokedPrograms: string[] = [];
    let logs: string[] = [];
    let unitsConsumed: number | undefined;
    let simulationErr: unknown = null;
    let parsedOk = false;
    try {
      const versioned = VersionedTransaction.deserialize(bytes);
      const message = versioned.message;
      const programs = new Set<string>();
      for (const ix of message.compiledInstructions) {
        const key = message.staticAccountKeys[ix.programIdIndex];
        if (key) programs.add(key.toBase58());
      }
      invokedPrograms = Array.from(programs);
      parsedOk = true;
      const result = await this.connection.simulateTransaction(versioned, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      });
      simulationErr = result.value.err;
      logs = result.value.logs ?? [];
      unitsConsumed = result.value.unitsConsumed ?? undefined;
    } catch (versionedErr) {
      try {
        const legacy = Transaction.from(bytes);
        const programs = new Set<string>();
        for (const ix of legacy.instructions) {
          programs.add(ix.programId.toBase58());
        }
        invokedPrograms = Array.from(programs);
        parsedOk = true;
        const result = await this.connection.simulateTransaction(legacy);
        simulationErr = result.value.err;
        logs = result.value.logs ?? [];
        unitsConsumed = result.value.unitsConsumed ?? undefined;
      } catch (legacyErr) {
        return {
          ok: false,
          invokedPrograms,
          closesTokenAccount: false,
          transfersSpl: false,
          transfersSol: false,
          logsTail: [],
          error: legacyErr instanceof Error ? legacyErr.message : versionedErr instanceof Error ? versionedErr.message : 'unparseable transaction',
        };
      }
    }
    const closesTokenAccount = logs.some((line) => /Instruction:\s*CloseAccount/i.test(line));
    const transfersSpl = logs.some((line) => /Instruction:\s*Transfer\b/i.test(line) || /Instruction:\s*TransferChecked\b/i.test(line));
    const transfersSol = logs.some((line) => /Program 11111111111111111111111111111111 (invoke|success)/.test(line));
    return {
      ok: parsedOk && !simulationErr,
      invokedPrograms,
      closesTokenAccount,
      transfersSpl,
      transfersSol,
      logsTail: logs.slice(-12),
      ...(unitsConsumed !== undefined ? { unitsConsumed } : {}),
      ...(simulationErr ? { error: JSON.stringify(simulationErr) } : {}),
    };
  }

  private async simulateBeforeSign(transactionBase64: string, summary: string): Promise<void> {
    if (process.env.AGENT_WALLET_SKIP_SIMULATION === '1') return;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(transactionBase64, 'base64');
    } catch {
      return;
    }
    let simulationErr: unknown = null;
    let logs: string[] | undefined;
    try {
      const versioned = VersionedTransaction.deserialize(bytes);
      const result = await this.connection.simulateTransaction(versioned, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      });
      simulationErr = result.value.err;
      logs = result.value.logs ?? undefined;
    } catch {
      try {
        const legacy = Transaction.from(bytes);
        const result = await this.connection.simulateTransaction(legacy);
        simulationErr = result.value.err;
        logs = result.value.logs ?? undefined;
      } catch {
        return;
      }
    }
    if (simulationErr) {
      const tail = logs && logs.length > 0 ? ` Last log: ${logs[logs.length - 1]}.` : '';
      throw new ProtocolError(
        'simulation_failed',
        `Pre-flight simulation rejected "${summary}": ${JSON.stringify(simulationErr)}.${tail} Refusing to ask the wallet to sign.`,
      );
    }
  }
}

function requireRuntimeConnector(idOrAlias: string): ConnectorRegistryEntry {
  const connector = getConnector(idOrAlias);
  if (!connector) {
    throw new ProtocolError('invalid_request', `Unknown connector: ${idOrAlias}`);
  }
  return connector;
}

function assertConnectorCluster(connector: ConnectorRegistryEntry, cluster: Cluster): void {
  if (!connector.supportedClusters.includes(cluster)) {
    throw new ProtocolError(
      'cluster_mismatch',
      `${connector.name} is only available on ${connector.supportedClusters.join(', ')}; current cluster is ${cluster}.`,
    );
  }
}

function marginfiDefaultCapability(input: ConnectorFactReadInput): ConnectorCapability {
  if (input.operation) {
    return input.operation === 'deposit' ? 'earn' : input.operation;
  }
  if (input.marginfiAccount || input.walletAddress) {
    return 'positions';
  }
  if (input.amount) {
    return 'earn';
  }
  return 'markets';
}

function project0DefaultCapability(input: ConnectorFactReadInput): ConnectorCapability {
  if (input.operation) {
    return input.operation === 'deposit' ? 'earn' : input.operation;
  }
  if (input.project0Account || input.walletAddress) {
    return 'positions';
  }
  if (input.amount) {
    return 'earn';
  }
  return 'markets';
}

function driftDefaultCapability(input: ConnectorFactReadInput): ConnectorCapability {
  if (input.operation === 'withdraw') return 'withdraw';
  if (input.walletAddress || input.subAccountId !== undefined) return 'positions';
  if (input.vaultAddress) return 'markets';
  return 'positions';
}

function realmsDefaultCapability(input: ConnectorFactReadInput): ConnectorCapability {
  if (input.proposalAddress?.trim() || input.governanceAddress?.trim()) return 'markets';
  if (input.realmAddress?.trim() && !input.walletAddress?.trim()) return 'markets';
  return 'governance';
}

function missingConnectorCapability(
  connector: ConnectorRegistryEntry,
  capability: ConnectorCapability | undefined,
  mode: 'read' | 'write',
): ProtocolError {
  const available = mode === 'read' ? connector.readCapabilities : connector.writeCapabilities;
  const label = capability ?? 'requested capability';
  return new ProtocolError(
    'unsupported_method',
    `${connector.name} does not expose ${label} ${mode} capability in the MCP runtime. Available ${mode} capabilities: ${available.length ? available.join(', ') : 'none'}.`,
  );
}

function connectorReadProtocolError(
  connector: ConnectorRegistryEntry,
  err: unknown,
): ProtocolError {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = String(redactSecrets(raw));
  return new ProtocolError(
    'unsupported_method',
    `${connector.name} connector read is unavailable: ${redacted}`,
    { cause: err },
  );
}

function requireAdapterAction(adapter: DAppAdapter, id: string) {
  const action = adapter.actions[id];
  if (!action) {
    throw new ProtocolError(
      'unsupported_method',
      `Adapter ${adapter.id} does not expose action ${id}.`,
    );
  }
  return action;
}

export function assertPreparedActionExecutable(action: PreparedAction, now = new Date()): void {
  if (action.status === 'scheduled') {
    const dueAt = new Date(action.dueAt);
    if (Number.isFinite(dueAt.getTime()) && dueAt.getTime() > now.getTime()) {
      throw new ProtocolError(
        'invalid_request',
        `Prepared action ${action.id} is scheduled for ${action.dueAt} and is not due yet.`,
      );
    }
  }
  if (!['ready', 'overdue', 'failed'].includes(action.status)) {
    throw new ProtocolError(
      'invalid_request',
      `Prepared action ${action.id} cannot be executed from status ${action.status}.`,
    );
  }
}

export function preparedFailureStatus(err: unknown): PreparedAction['status'] {
  if (err instanceof ProtocolError && err.code === 'user_rejected') {
    return 'rejected';
  }
  if (err instanceof ProtocolError && err.code === 'unauthorized') {
    return 'blocked';
  }
  return 'failed';
}

function txidsForAction(action: PreparedAction): string[] {
  const txids = Array.isArray(action.txids)
    ? action.txids.filter((txid): txid is string => typeof txid === 'string' && txid.trim() !== '').map((txid) => txid.trim())
    : [];
  if (txids.length > 0) return [...new Set(txids)];
  return action.txid ? [action.txid] : [];
}

function requireActionAllowed(config: AgentWalletConfig): void {
  void config;
}

function normalizeRecurringSlippageBps(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function buildRecurringPaymentInput(
  input: RecurringPaymentInput,
  walletAddress: string,
  config: AgentWalletConfig,
  connection: Connection,
): Promise<AddRecurringPaymentInput> {
  requireActionAllowed(config);
  const actionKind: 'transfer' | 'swap' | 'connector' | 'blink' =
    input.actionKind === 'connector' || input.actionKind === 'blink' || input.actionKind === 'swap'
      ? input.actionKind
      : input.outputToken
        ? 'swap'
        : 'transfer';
  if (actionKind === 'connector' || actionKind === 'blink') {
    if (!input.connectorActionTemplate) {
      throw new ProtocolError(
        'invalid_request',
        `connectorActionTemplate is required when actionKind is "${actionKind}".`,
      );
    }
    const template = input.connectorActionTemplate;
    if (!template.connectorId.trim()) {
      throw new ProtocolError('invalid_request', 'connectorActionTemplate.connectorId is required.');
    }
    if (!template.actionType.trim()) {
      throw new ProtocolError('invalid_request', 'connectorActionTemplate.actionType is required.');
    }
    if (actionKind === 'blink' && !template.blinkUrl?.trim()) {
      throw new ProtocolError(
        'invalid_request',
        'connectorActionTemplate.blinkUrl is required when actionKind is "blink".',
      );
    }
  }
  const tokenSeed = input.token ?? input.inputToken ?? (actionKind === 'connector' || actionKind === 'blink' ? input.connectorActionTemplate?.params?.token ?? 'SOL' : undefined);
  const token = normalizeTokenIdentifier(requireString(tokenSeed, 'token'));
  const amountSeed = input.amount ?? (actionKind === 'connector' || actionKind === 'blink' ? input.connectorActionTemplate?.params?.amount ?? '0' : undefined);
  const amount = requireString(amountSeed, 'amount');
  const inputToken = normalizeTokenIdentifier(input.inputToken ?? token);
  const outputToken = actionKind === 'swap'
    ? normalizeTokenIdentifier(requireString(input.outputToken, 'outputToken'))
    : undefined;
  let recipient = '';
  if (actionKind === 'transfer') {
    recipient = new PublicKey(requireString(input.recipient, 'recipient')).toBase58();
  } else if (input.recipient) {
    try {
      recipient = new PublicKey(input.recipient).toBase58();
    } catch {
      recipient = '';
    }
  }
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 500) : undefined;
  const localTime = typeof input.localTime === 'string' && input.localTime.trim() ? input.localTime.trim() : undefined;
  if (localTime !== undefined && !/^\d{2}:\d{2}$/.test(localTime)) {
    throw new ProtocolError('invalid_request', 'localTime must be HH:MM in 24-hour local time.');
  }
  const schedule = normalizeRecurringSchedule({
    cadence: input.cadence ?? 'weekly',
    dayOfWeek: input.dayOfWeek,
    dayOfMonth: input.dayOfMonth,
    intervalDays: input.intervalDays,
    intervalHours: input.intervalHours,
    intervalMinutes: input.intervalMinutes,
    localTime,
    startAt: input.startAt,
    maxOccurrences: input.maxOccurrences,
  });

  if (actionKind === 'swap') {
    const inputTokenConfig = inputToken === 'SOL' ? { decimals: 9, symbol: 'SOL' } : await resolveToken(config, connection, inputToken);
    parseDecimalAmount(amount, inputTokenConfig.decimals, `${inputTokenConfig.symbol} recurring swap amount`);
  } else if (actionKind === 'transfer') {
    if (token === 'SOL') {
      parseDecimalAmount(amount, 9, 'SOL recurring payment amount');
    } else {
      const tokenConfig = await resolveToken(config, connection, token);
      parseDecimalAmount(amount, tokenConfig.decimals, `${tokenConfig.symbol} recurring payment amount`);
    }
  }
  // For connector/blink, amount is a free-form parametric value; validation runs per occurrence.

  if (actionKind === 'blink') {
    const minDailyMinutes = 60 * 24;
    const intervalMinutes = (schedule.intervalDays ?? 0) * 60 * 24
      + (schedule.intervalHours ?? 0) * 60
      + (schedule.intervalMinutes ?? 0);
    const cadenceLooksDaily = schedule.cadence === 'weekly' || schedule.cadence === 'monthly';
    if (!cadenceLooksDaily && intervalMinutes > 0 && intervalMinutes < minDailyMinutes) {
      throw new ProtocolError(
        'invalid_request',
        'Recurring Blink schedules require at least a 1-day cadence.',
      );
    }
  }

  const expiresAt = normalizeExpiresAt(input.expiresAt);
  const notifications = normalizeNotifications(input.notifications);

  enforceRecurringPolicy(config.recurring, token, amount, {
    cadence: schedule.cadence,
    dayOfWeek: schedule.dayOfWeek,
    dayOfMonth: schedule.dayOfMonth,
    intervalDays: schedule.intervalDays,
    intervalHours: schedule.intervalHours,
    intervalMinutes: schedule.intervalMinutes,
    localTime: schedule.localTime,
    startAt: schedule.startAt,
    maxOccurrences: schedule.maxOccurrences,
    createdAt: new Date().toISOString(),
    expiresAt,
  });

  const status: 'active' | 'paused' = input.status === 'paused' ? 'paused' : 'active';
  return {
    walletAddress,
    status,
    cluster: config.cluster,
    ...(actionKind === 'swap' ? { actionKind: 'swap' as const, inputToken, outputToken, slippageBps: input.slippageBps ?? config.mainnet.maxSlippageBps } : {}),
    ...(actionKind === 'connector' || actionKind === 'blink'
      ? {
          actionKind,
          ...(input.connectorActionTemplate ? { connectorActionTemplate: input.connectorActionTemplate } : {}),
        }
      : {}),
    token,
    recipient,
    amount,
    ...schedule,
    ...(note !== undefined && { note }),
    ...(expiresAt !== undefined && { expiresAt }),
    ...(notifications !== undefined && { notifications }),
    ...(input.metadata !== undefined && { metadata: input.metadata }),
  };
}

function enforceRecurringPolicy(
  policy: RecurringPolicyConfig | undefined,
  token: string,
  amount: string,
  cadenceFields: Parameters<typeof lifetimeSpendEstimate>[0],
): void {
  if (!policy) return;
  const lifetime = policy.maxLifetimeAmount?.[token];
  const perWeek = policy.maxPerWeekAmount?.[token];
  const perMonth = policy.maxPerMonthAmount?.[token];
  if (!lifetime && !perWeek && !perMonth) return;

  const estimate = lifetimeSpendEstimate(cadenceFields, amount, new Date());
  if (lifetime && estimate.bounded && estimate.totalAmount && compareDecimal(estimate.totalAmount, lifetime) > 0) {
    throw new ProtocolError(
      'invalid_request',
      `This schedule would spend up to ${estimate.totalAmount} ${token} total, exceeding your configured lifetime cap of ${lifetime} ${token}.`,
    );
  }
  if (perWeek && compareDecimal(estimate.perWeek, perWeek) > 0) {
    throw new ProtocolError(
      'invalid_request',
      `This schedule would spend up to ${estimate.perWeek} ${token} per week, exceeding your configured cap of ${perWeek} ${token} per week.`,
    );
  }
  if (perMonth && compareDecimal(estimate.perMonth, perMonth) > 0) {
    throw new ProtocolError(
      'invalid_request',
      `This schedule would spend up to ${estimate.perMonth} ${token} per month, exceeding your configured cap of ${perMonth} ${token} per month.`,
    );
  }
}

function compareDecimal(left: string, right: string): number {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function monthWindowStart(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function normalizeNotifications(
  value: unknown,
): { inApp?: boolean; webhookUrl?: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_request', 'notifications must be an object.');
  }
  const obj = value as Record<string, unknown>;
  const result: { inApp?: boolean; webhookUrl?: string } = {};
  if (obj.inApp !== undefined) {
    if (typeof obj.inApp !== 'boolean') {
      throw new ProtocolError('invalid_request', 'notifications.inApp must be a boolean.');
    }
    result.inApp = obj.inApp;
  }
  if (obj.webhookUrl !== undefined && obj.webhookUrl !== null && obj.webhookUrl !== '') {
    if (typeof obj.webhookUrl !== 'string') {
      throw new ProtocolError('invalid_request', 'notifications.webhookUrl must be a string.');
    }
    try {
      const parsed = new URL(obj.webhookUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
    } catch {
      throw new ProtocolError('invalid_request', 'notifications.webhookUrl must be a valid http(s) URL.');
    }
    result.webhookUrl = obj.webhookUrl;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeExpiresAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ProtocolError('invalid_request', 'expiresAt must be an ISO timestamp string.');
  }
  const trimmed = value.trim();
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new ProtocolError('invalid_request', 'expiresAt must be a valid ISO timestamp.');
  }
  return trimmed;
}

function normalizeRecurringSchedule(input: {
  cadence: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
}): {
  cadence: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
} {
  if (input.maxOccurrences !== undefined && (!Number.isInteger(input.maxOccurrences) || input.maxOccurrences < 1)) {
    throw new ProtocolError('invalid_request', 'maxOccurrences must be a positive integer when provided.');
  }
  if (input.cadence === 'weekly') {
    if (input.localTime === undefined) {
      throw new ProtocolError('invalid_request', 'localTime is required for weekly recurring payments.');
    }
    if (!Number.isInteger(input.dayOfWeek) || input.dayOfWeek === undefined || input.dayOfWeek < 0 || input.dayOfWeek > 6) {
      throw new ProtocolError('invalid_request', 'dayOfWeek must be an integer from 0 to 6 for weekly recurring payments.');
    }
    return {
      cadence: input.cadence,
      dayOfWeek: input.dayOfWeek,
      localTime: input.localTime,
      ...(input.maxOccurrences !== undefined && { maxOccurrences: input.maxOccurrences }),
    };
  }
  if (input.cadence === 'monthly') {
    if (input.localTime === undefined) {
      throw new ProtocolError('invalid_request', 'localTime is required for monthly recurring payments.');
    }
    if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth === undefined || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
      throw new ProtocolError('invalid_request', 'dayOfMonth must be an integer from 1 to 31 for monthly recurring payments.');
    }
    return {
      cadence: input.cadence,
      dayOfMonth: input.dayOfMonth,
      localTime: input.localTime,
      ...(input.maxOccurrences !== undefined && { maxOccurrences: input.maxOccurrences }),
    };
  }
  if (input.cadence === 'interval_days') {
    if (!Number.isInteger(input.intervalDays) || input.intervalDays === undefined || input.intervalDays < 1 || input.intervalDays > 365) {
      throw new ProtocolError('invalid_request', 'intervalDays must be an integer from 1 to 365 for every-N-days recurring payments.');
    }
    return {
      cadence: input.cadence,
      intervalDays: input.intervalDays,
      ...(input.startAt !== undefined && { startAt: input.startAt }),
      ...(input.maxOccurrences !== undefined && { maxOccurrences: input.maxOccurrences }),
    };
  }
  if (input.cadence === 'interval_hours') {
    if (!Number.isInteger(input.intervalHours) || input.intervalHours === undefined || input.intervalHours < 1 || input.intervalHours > 8760) {
      throw new ProtocolError('invalid_request', 'intervalHours must be an integer from 1 to 8760 for every-N-hours recurring payments.');
    }
    return {
      cadence: input.cadence,
      intervalHours: input.intervalHours,
      ...(input.startAt !== undefined && { startAt: input.startAt }),
      ...(input.maxOccurrences !== undefined && { maxOccurrences: input.maxOccurrences }),
    };
  }
  if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes === undefined || input.intervalMinutes < 1 || input.intervalMinutes > 525600) {
    throw new ProtocolError('invalid_request', 'intervalMinutes must be an integer from 1 to 525600 for every-N-minutes recurring payments.');
  }
  return {
    cadence: input.cadence,
    intervalMinutes: input.intervalMinutes,
    ...(input.startAt !== undefined && { startAt: input.startAt }),
    ...(input.maxOccurrences !== undefined && { maxOccurrences: input.maxOccurrences }),
  };
}

async function readConfiguredTokenBalances(
  connection: Connection,
  owner: PublicKey,
  config: AgentWalletConfig,
): Promise<Array<{ symbol: string; mint: string; amount: string; rawAmount: string }>> {
  const tokens = [];
  for (const token of config.tokens) {
    const ata = await getAssociatedTokenAddress(new PublicKey(token.mint), owner);
    const balance = await connection.getTokenAccountBalance(ata).catch(() => null);
    tokens.push({
      symbol: token.symbol,
      mint: token.mint,
      amount: balance?.value.uiAmountString ?? '0',
      rawAmount: balance?.value.amount ?? '0',
    });
  }
  return tokens;
}

function requireStringParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `Prepared action ${action.id} is missing ${key}.`);
  }
  return value;
}

function stringRecordParam(action: PreparedAction, key: string): Record<string, string> | undefined {
  const value = action.params[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .map(([entryKey, entryValue]) => [
      entryKey,
      typeof entryValue === 'string' ? entryValue : '',
    ] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `${label} is required.`);
  }
  return value.trim();
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

async function checkRpc(rpcUrl: string): Promise<{ ok: boolean; message: string }> {
  try {
    const connection = new Connection(rpcUrl, 'confirmed');
    await connection.getLatestBlockhash('confirmed');
    return { ok: true, message: 'RPC accepted latest-blockhash request.' };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'RPC check failed.',
    };
  }
}

interface NormalizedSwapInput {
  inputMint: string;
  outputMint: string;
  inputSymbol: string;
  outputSymbol: string;
  inputDecimals: number;
  outputDecimals: number;
  amountRaw: bigint;
  slippageBps: number;
}

interface ResolvedTokenConfig extends TokenLimitConfig {
  requestToken: string;
  tokenProgramId: PublicKey;
}

function assertJupiterSwapCluster(config: AgentWalletConfig): void {
  if (config.cluster !== 'mainnet-beta') {
    throw new ProtocolError(
      'cluster_mismatch',
      `Jupiter swaps are only available on mainnet-beta; current cluster is ${config.cluster}.`,
    );
  }
  requireMainnetEnabled(config);
}

async function normalizeSwapInput(
  config: AgentWalletConfig,
  connection: Connection,
  input: SwapInput,
): Promise<NormalizedSwapInput> {
  assertJupiterSwapCluster(config);
  const inputToken = await resolveSwapToken(config, connection, input.inputToken ?? 'SOL');
  const outputToken = await resolveSwapToken(config, connection, input.outputToken ?? 'USDC');
  const slippageBps = input.slippageBps ?? config.mainnet.maxSlippageBps;
  if (!Number.isInteger(slippageBps) || slippageBps < 0) {
    throw new ProtocolError('invalid_request', 'Jupiter swap slippageBps must be a non-negative integer.');
  }
  if (slippageBps > config.mainnet.maxSlippageBps) {
    throw new ProtocolError(
      'unauthorized',
      `Jupiter swap slippage ${slippageBps} bps exceeds configured cap of ${config.mainnet.maxSlippageBps} bps.`,
    );
  }
  const amountRaw = parseDecimalAmount(input.amount, inputToken.decimals, `${inputToken.symbol} swap amount`);
  assertMaxAmount(amountRaw, config.mainnet.maxSwapInput, inputToken.decimals, `${inputToken.symbol} swap amount`);
  return {
    inputMint: inputToken.mint,
    outputMint: outputToken.mint,
    inputSymbol: inputToken.symbol,
    outputSymbol: outputToken.symbol,
    inputDecimals: inputToken.decimals,
    outputDecimals: outputToken.decimals,
    amountRaw,
    slippageBps,
  };
}

async function resolveSwapToken(
  config: AgentWalletConfig,
  connection: Connection,
  token: string,
): Promise<ResolvedTokenConfig> {
  if (isNativeSolToken(token)) {
    return {
      symbol: 'SOL',
      mint: WSOL_MINT,
      decimals: 9,
      maxTransfer: config.mainnet.maxSwapInput,
      requestToken: 'SOL',
      tokenProgramId: TOKEN_PROGRAM_ID,
    };
  }
  return resolveToken(config, connection, token);
}

async function resolveToken(
  config: AgentWalletConfig,
  connection: Connection,
  token: string,
): Promise<ResolvedTokenConfig> {
  const trimmed = token.trim();
  const known = findKnownToken(config, trimmed);
  const mintText = known?.mint ?? trimmed;
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintText);
  } catch {
    throw new ProtocolError(
      'invalid_request',
      `Token ${token} is not a known symbol. Paste the token mint address.`,
    );
  }
  const account = await connection.getParsedAccountInfo(mint, 'confirmed').catch(() => null);
  const owner = account?.value?.owner;
  const tokenProgramId = owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const parsedData = account?.value?.data;
  const parsed = parsedData && typeof parsedData === 'object' && 'parsed' in parsedData
    ? parsedData.parsed as { info?: { decimals?: unknown } }
    : undefined;
  const decimals = known?.decimals ?? (typeof parsed?.info?.decimals === 'number' ? parsed.info.decimals : undefined);
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
    throw new ProtocolError('invalid_request', `Could not read decimals for token mint ${shortToken(mint.toBase58())}.`);
  }
  const rawMint = mint.toBase58();
  const requestToken = known && known.symbol.toLowerCase() === trimmed.toLowerCase() ? known.symbol : rawMint;
  return {
    symbol: known?.symbol ?? shortToken(rawMint),
    mint: rawMint,
    decimals,
    maxTransfer: known?.maxTransfer ?? '',
    requestToken,
    tokenProgramId,
  };
}

function findKnownToken(config: AgentWalletConfig, token: string): TokenLimitConfig | undefined {
  const normalized = token.toLowerCase();
  return [...config.tokens, ...DEFAULT_TOKEN_REGISTRY].find(
    (entry) => entry.symbol.toLowerCase() === normalized || entry.mint.toLowerCase() === normalized,
  );
}

function swapEvidenceMint(
  mintValue: unknown,
  requestedToken: string | undefined,
  config: AgentWalletConfig,
): string | undefined {
  const mint = typeof mintValue === 'string' && looksLikeMintAddress(mintValue) ? mintValue : undefined;
  if (!mint || mint === WSOL_MINT) return undefined;
  const requested = requestedToken?.trim();
  if (requested && looksLikeMintAddress(requested) && requested !== WSOL_MINT) return mint;
  return findKnownToken(config, mint) ? undefined : mint;
}

function isNativeSolToken(token: string): boolean {
  const trimmed = token.trim();
  return trimmed.toUpperCase() === 'SOL' || trimmed === WSOL_MINT;
}

function normalizeSanctumKnownToken(token: string): string | undefined {
  const trimmed = token.trim();
  const upper = trimmed.toUpperCase();
  if (upper === 'SOL' || trimmed === WSOL_MINT) return WSOL_MINT;
  if (upper === 'INF' || trimmed === SANCTUM_INF_MINT) return SANCTUM_INF_MINT;
  return undefined;
}

function normalizeTokenIdentifier(token: string): string {
  const trimmed = token.trim();
  return looksLikeMintAddress(trimmed) ? trimmed : trimmed.toUpperCase();
}

function looksLikeMintAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function shortToken(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}

async function fetchJupiterOrder(
  config: AgentWalletConfig,
  taker: string | undefined,
  swap: NormalizedSwapInput,
): Promise<Record<string, unknown>> {
  return jupiterFetchJson(config, 'swap', '/order', {
    searchParams: {
      inputMint: swap.inputMint,
      outputMint: swap.outputMint,
      amount: swap.amountRaw.toString(),
      taker,
      slippageBps: swap.slippageBps,
    },
  });
}

async function executeJupiterOrder(
  config: AgentWalletConfig,
  signedTransaction: string,
  order: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = order.requestId;
  if (typeof requestId !== 'string') {
    throw new ProtocolError('invalid_request', 'Jupiter order did not include requestId.');
  }
  const body = await jupiterFetchJson(config, 'swap', '/execute', {
    method: 'POST',
    body: {
      signedTransaction,
      requestId,
      ...(typeof order.lastValidBlockHeight === 'string' || typeof order.lastValidBlockHeight === 'number'
        ? { lastValidBlockHeight: order.lastValidBlockHeight }
        : {}),
    },
  });
  assertJupiterExecutionSucceeded(body);
  return body;
}

function orderSummary(order: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: order.mode,
    router: order.router,
    inputMint: order.inputMint,
    outputMint: order.outputMint,
    inAmount: order.inAmount,
    inUsdValue: order.inUsdValue,
    outAmount: order.outAmount,
    outUsdValue: order.outUsdValue,
    swapUsdValue: order.swapUsdValue,
    otherAmountThreshold: order.otherAmountThreshold,
    swapMode: order.swapMode,
    slippageBps: order.slippageBps,
    priceImpact: order.priceImpact,
    priceImpactPct: order.priceImpactPct,
    routePlan: summarizeJupiterRoutePlan(order.routePlan),
    feeMint: order.feeMint,
    feeBps: order.feeBps,
    platformFee: safeRecord(order.platformFee),
    signatureFeeLamports: order.signatureFeeLamports,
    signatureFeePayer: order.signatureFeePayer,
    prioritizationFeeLamports: order.prioritizationFeeLamports,
    prioritizationFeePayer: order.prioritizationFeePayer,
    rentFeeLamports: order.rentFeeLamports,
    rentFeePayer: order.rentFeePayer,
    swapType: order.swapType,
    gasless: order.gasless,
    taker: order.taker,
    quoteId: order.quoteId,
    maker: order.maker,
    expireAt: order.expireAt,
    requestId: order.requestId,
    lastValidBlockHeight: order.lastValidBlockHeight,
    totalTime: order.totalTime,
    hasTransaction: Boolean(order.transaction),
    errorCode: order.errorCode,
    errorMessage: order.errorMessage ?? order.error,
  };
}

function assertJupiterExecutionSucceeded(executed: Record<string, unknown>): void {
  const status = typeof executed.status === 'string' ? executed.status : '';
  const code = typeof executed.code === 'number' || typeof executed.code === 'string' ? executed.code : undefined;
  if (status.toLowerCase() === 'failed' || (typeof code === 'number' && code !== 0) || (typeof code === 'string' && code && code !== '0')) {
    const signature = typeof executed.signature === 'string' ? ` signature ${executed.signature}` : '';
    const error = typeof executed.error === 'string' && executed.error ? `: ${executed.error}` : '';
    throw new ProtocolError(
      'wallet_unreachable',
      `Jupiter execute failed${code !== undefined ? ` with code ${code}` : ''}${signature}${error}`,
    );
  }
}

function executionSignature(executed: Record<string, unknown>): string {
  const signature = typeof executed.signature === 'string' ? executed.signature : typeof executed.txid === 'string' ? executed.txid : '';
  if (!signature) {
    throw new ProtocolError('wallet_unreachable', 'Jupiter execution did not return a transaction signature.');
  }
  return signature;
}

function executionSummary(executed: Record<string, unknown>): Record<string, unknown> {
  return {
    status: executed.status,
    signature: executed.signature,
    slot: executed.slot,
    code: executed.code,
    totalInputAmount: executed.totalInputAmount,
    totalOutputAmount: executed.totalOutputAmount,
    inputAmountResult: executed.inputAmountResult,
    outputAmountResult: executed.outputAmountResult,
    swapEvents: Array.isArray(executed.swapEvents) ? executed.swapEvents : undefined,
    error: executed.error,
  };
}

function summarizeJupiterRoutePlan(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const record = safeRecord(entry);
    const swapInfo = safeRecord(record?.swapInfo);
    return {
      label: swapInfo?.label,
      ammKey: swapInfo?.ammKey,
      inputMint: swapInfo?.inputMint,
      outputMint: swapInfo?.outputMint,
      inAmount: swapInfo?.inAmount,
      outAmount: swapInfo?.outAmount,
      percent: record?.percent,
      bps: record?.bps,
      usdValue: record?.usdValue,
    };
  });
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function preparedMinimumOutputRaw(action: PreparedAction): string | undefined {
  const snapshot = safeRecord(action.params.quoteSnapshot);
  const threshold = action.params.otherAmountThreshold ?? snapshot?.otherAmountThreshold;
  return typeof threshold === 'string' && /^\d+$/.test(threshold) ? threshold : undefined;
}

function minimumOutputRawFromSwapInput(
  input: Pick<SwapInput, 'minOutputAmount'>,
  swap: NormalizedSwapInput,
): string | undefined {
  if (input.minOutputAmount === undefined) return undefined;
  return parseDecimalAmount(input.minOutputAmount, swap.outputDecimals, `${swap.outputSymbol} minimum output`).toString();
}

function enforceMinimumPreparedOutput(order: Record<string, unknown>, minimumOutputRaw: string | undefined): void {
  if (!minimumOutputRaw) return;
  const outAmount = typeof order.outAmount === 'string' && /^\d+$/.test(order.outAmount) ? BigInt(order.outAmount) : undefined;
  if (outAmount !== undefined && outAmount < BigInt(minimumOutputRaw)) {
    throw new ProtocolError(
      'unauthorized',
      `Refreshed Jupiter output ${outAmount.toString()} is below the prepared minimum output ${minimumOutputRaw}.`,
    );
  }
}

async function prepareTransaction(connection: Connection, transaction: Transaction, feePayer: PublicKey): Promise<void> {
  transaction.feePayer = feePayer;
  const latest = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = latest.blockhash;
}

function txToBase64(transaction: Transaction): string {
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

async function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgramId = TOKEN_PROGRAM_ID,
): Promise<PublicKey> {
  const [address] = await PublicKey.findProgramAddress(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function createTransferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
  tokenProgramId = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: tokenProgramId,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function explorerUrl(signature: string, cluster: Cluster): string {
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${signature}${suffix}`;
}
