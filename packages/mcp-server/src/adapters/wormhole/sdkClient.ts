import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Connection,
  type Keypair,
} from '@solana/web3.js';

import { parseDecimalAmount } from '../../amounts.js';
import { AdapterError } from '../types.js';
import {
  WORMHOLE_ADAPTER_ID,
  WORMHOLE_PROGRAM_IDS,
  WORMHOLE_RPC_BASE_URL_ENV,
  WORMHOLE_SOURCE_CHAIN,
  type WormholeNetwork,
  type WormholeRouteMode,
  type WormholeRouteType,
} from './constants.js';
import type {
  WormholeBuildRedeemInput,
  WormholeBuildTransferInput,
  WormholeBuiltTransaction,
  WormholeClient,
  WormholeQuoteInput,
  WormholeQuoteSnapshot,
  WormholeRouteSnapshot,
  WormholeStatusInput,
  WormholeSupportedRoutesSnapshot,
  WormholeTokenSnapshot,
  WormholeTransferStatus,
  WormholeWalletBridgeExposure,
} from './client.js';

interface BuildWormholeSdkClientOptions {
  rpcUrl: string;
  apiBaseUrl?: string;
  evmRpcUrls?: Record<string, string | undefined>;
}

interface SdkBundle {
  wormhole: typeof import('@wormhole-foundation/sdk').wormhole;
  Wormhole: typeof import('@wormhole-foundation/sdk').Wormhole;
  TokenTransfer: typeof import('@wormhole-foundation/sdk').TokenTransfer;
  canonicalAddress: typeof import('@wormhole-foundation/sdk').canonicalAddress;
  isNative: typeof import('@wormhole-foundation/sdk').isNative;
  solana: typeof import('@wormhole-foundation/sdk/solana').default;
  evm: typeof import('@wormhole-foundation/sdk/evm').default;
}

type SdkNetwork = 'Mainnet' | 'Testnet';
type SdkChain = 'Solana' | 'Ethereum' | 'Base' | 'Arbitrum' | 'Optimism' | 'Polygon' | 'Avalanche' | 'Bsc';
type SdkModule = typeof import('@wormhole-foundation/sdk');
type SdkSolanaTokenId = import('@wormhole-foundation/sdk').TokenId<'Solana'>;
type SdkSolanaChainAddress = import('@wormhole-foundation/sdk').ChainAddress<'Solana'>;
type SdkChainAddress = import('@wormhole-foundation/sdk').ChainAddress<SdkChain>;
type SdkQuote = Awaited<ReturnType<SdkModule['TokenTransfer']['quoteTransfer']>>;
type SdkUnsignedTransaction = import('@wormhole-foundation/sdk').UnsignedTransaction;
type SdkWormhole = import('@wormhole-foundation/sdk').Wormhole<SdkNetwork>;
type SdkChainContext<C extends SdkChain = SdkChain> = import('@wormhole-foundation/sdk').ChainContext<SdkNetwork, C>;
type SdkPlatformLoader = import('@wormhole-foundation/sdk').PlatformLoader<any>;

const EVM_RPC_ENV_BY_CHAIN: Record<Exclude<SdkChain, 'Solana'>, string[]> = {
  Ethereum: ['WORMHOLE_ETHEREUM_RPC_URL', 'ETHEREUM_RPC_URL'],
  Base: ['WORMHOLE_BASE_RPC_URL', 'BASE_RPC_URL'],
  Arbitrum: ['WORMHOLE_ARBITRUM_RPC_URL', 'ARBITRUM_RPC_URL'],
  Optimism: ['WORMHOLE_OPTIMISM_RPC_URL', 'OPTIMISM_RPC_URL'],
  Polygon: ['WORMHOLE_POLYGON_RPC_URL', 'POLYGON_RPC_URL'],
  Avalanche: ['WORMHOLE_AVALANCHE_RPC_URL', 'AVALANCHE_RPC_URL'],
  Bsc: ['WORMHOLE_BSC_RPC_URL', 'BSC_RPC_URL', 'BNB_RPC_URL'],
};

interface WormholeSdkContext {
  sdk: SdkBundle;
  sdkNetwork: SdkNetwork;
  wh: SdkWormhole;
  sourceChain: SdkChainContext<'Solana'>;
  destinationChain?: SdkChain;
  destination?: SdkChainContext;
  sourceToken?: SdkSolanaTokenId;
}

let cachedSdk: SdkBundle | undefined;

async function loadSdk(): Promise<SdkBundle> {
  if (cachedSdk) return cachedSdk;
  const [sdk, solanaPlatform, evmPlatform] = await Promise.all([
    import('@wormhole-foundation/sdk'),
    import('@wormhole-foundation/sdk/solana'),
    import('@wormhole-foundation/sdk/evm'),
  ]);
  cachedSdk = {
    wormhole: sdk.wormhole,
    Wormhole: sdk.Wormhole,
    TokenTransfer: sdk.TokenTransfer,
    canonicalAddress: sdk.canonicalAddress,
    isNative: sdk.isNative,
    solana: solanaPlatform.default,
    evm: evmPlatform.default,
  };
  return cachedSdk;
}

export function buildWormholeSdkClient(options: BuildWormholeSdkClientOptions): WormholeClient {
  const rpcUrl = options.rpcUrl.trim();
  const apiBaseUrl = options.apiBaseUrl?.trim() || process.env[WORMHOLE_RPC_BASE_URL_ENV]?.trim();
  const chainOverrides = buildChainOverrides(rpcUrl, options.evmRpcUrls);

  async function context(input: { wormholeNetwork: WormholeNetwork; destinationChain?: string; sourceMint?: string }): Promise<WormholeSdkContext> {
    const sdkNetwork = sdkNetworkFromAdapter(input.wormholeNetwork);
    const sdk = await loadSdk();
    const platformLoaders: SdkPlatformLoader[] = [sdk.solana as SdkPlatformLoader, sdk.evm as SdkPlatformLoader];
    const wh = await sdk.wormhole(sdkNetwork, platformLoaders, {
      ...(apiBaseUrl ? { api: apiBaseUrl } : {}),
      chains: chainOverrides,
    });
    const sourceChain = wh.getChain('Solana');
    const destinationChain = input.destinationChain ? sdkChainFromAdapter(input.destinationChain) : undefined;
    const destination = destinationChain ? wh.getChain(destinationChain) : undefined;
    const sourceToken = input.sourceMint
      ? sdk.Wormhole.tokenId('Solana', tokenAddressForSdk(input.sourceMint)) as SdkSolanaTokenId
      : undefined;
    return { sdk, sdkNetwork, wh, sourceChain, destinationChain, destination, sourceToken };
  }

  async function quoteTokenBridge(
    input: WormholeQuoteInput & { wormholeNetwork: WormholeNetwork },
    mode: WormholeRouteMode,
  ): Promise<WormholeQuoteSnapshot> {
    const ctx = await context({
      wormholeNetwork: input.wormholeNetwork,
      destinationChain: input.destinationChain,
      sourceMint: input.sourceMint,
    });
    if (!ctx.destination || !ctx.destinationChain || !ctx.sourceToken) {
      throw unsupportedRoute('Wormhole transfer requires Solana source token and destination chain.');
    }
    const amountRaw = BigInt(input.amountRaw);
    const nativeGasRaw = input.nativeGasDropoff
      ? parseDecimalAmount(input.nativeGasDropoff, input.sourceDecimals ?? 0, 'Wormhole native gas dropoff')
      : 0n;
    const quote = await sdkQuote(ctx, {
      sourceToken: ctx.sourceToken,
      amountRaw,
      mode,
      nativeGasRaw,
    });
    return quoteSnapshotFromSdkQuote(input, {
      sdk: ctx.sdk,
      sourceToken: ctx.sourceToken,
      destinationChain: ctx.destinationChain,
      quote,
      mode,
      sourceDecimals: input.sourceDecimals,
    });
  }

  return {
    async getSupportedRoutes(_connection: Connection, input): Promise<WormholeSupportedRoutesSnapshot> {
      const destinationChains = input.destinationChain
        ? [input.destinationChain]
        : ['Ethereum', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'Avalanche', 'Bsc'];
      const routes: WormholeRouteSnapshot[] = [];
      const ctx = await context({
        wormholeNetwork: input.wormholeNetwork,
        ...(input.mintAddress !== undefined && { sourceMint: input.mintAddress }),
      });
      for (const destination of destinationChains) {
        let sdkDestination: SdkChain;
        try {
          sdkDestination = sdkChainFromAdapter(destination);
        } catch (err) {
          routes.push(unsupportedRouteSnapshot(destination, input.routeType ?? 'auto', err));
          continue;
        }
        if (!input.mintAddress || !ctx.sourceToken) {
          routes.push(routeSnapshot({
            destinationChain: destination,
            routeType: 'token_bridge',
            mode: 'manual',
            supported: true,
            prepareSupported: true,
            sourceMint: input.mintAddress,
            destinationToken: undefined,
            warnings: ['Quote with a specific source mint to verify destination token mapping before approval.'],
          }));
          continue;
        }
        const destinationContext = ctx.wh.getChain(sdkDestination);
        const routeType = input.routeType ?? 'auto';
        if (routeType === 'cctp' || routeType === 'ntt') {
          routes.push(unsupportedRouteSnapshot(destination, routeType, undefined));
          continue;
        }
        if (routeType === 'auto') {
          const automatic = await destinationTokenForMode(ctx.sdk, ctx.sourceChain, destinationContext, ctx.sourceToken, 'automatic');
          if (automatic) {
            routes.push(routeSnapshot({
              destinationChain: destination,
              routeType: 'token_bridge',
              mode: 'automatic',
              supported: true,
              prepareSupported: true,
              sourceMint: input.mintAddress,
              destinationToken: automatic,
            }));
          }
        }
        const manual = await destinationTokenForMode(ctx.sdk, ctx.sourceChain, destinationContext, ctx.sourceToken, 'manual');
        routes.push(routeSnapshot({
          destinationChain: destination,
          routeType: 'token_bridge',
          mode: 'manual',
          supported: manual !== undefined,
          prepareSupported: manual !== undefined,
          sourceMint: input.mintAddress,
          destinationToken: manual,
          warnings: manual
            ? ['Manual redemption is required on the destination chain after Guardian attestation.']
            : ['No wrapped destination token was found for this mint on the destination chain. The token may need Wormhole attestation first.'],
        }));
      }
      return {
        sourceChain: WORMHOLE_SOURCE_CHAIN,
        wormholeNetwork: input.wormholeNetwork,
        ...(input.destinationChain !== undefined && { destinationChain: input.destinationChain }),
        ...(input.mintAddress !== undefined && { mintAddress: input.mintAddress }),
        ...(input.routeType !== undefined && { routeType: input.routeType }),
        routes,
        asOfIso: new Date().toISOString(),
      };
    },

    async getTokenSnapshot(_connection: Connection, input): Promise<WormholeTokenSnapshot> {
      const ctx = await context({ wormholeNetwork: input.wormholeNetwork, sourceMint: input.mintAddress });
      if (!ctx.sourceToken) throw unsupportedRoute('Wormhole token snapshot requires a source mint.');
      const decimals = await ctx.sourceChain.getDecimals(ctx.sourceToken.address as never);
      const destinationChains = input.destinationChain
        ? [input.destinationChain]
        : ['Ethereum', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'Avalanche', 'Bsc'];
      const wrappedAssets = [];
      const supportedRoutes = [];
      for (const destination of destinationChains) {
        try {
          const sdkDestination = sdkChainFromAdapter(destination);
          const destinationContext = ctx.wh.getChain(sdkDestination);
          const destinationToken = await destinationTokenForMode(ctx.sdk, ctx.sourceChain, destinationContext, ctx.sourceToken, 'manual');
          if (destinationToken) {
            wrappedAssets.push({ chain: destination, address: destinationToken, tokenBridgeWrapped: true });
            supportedRoutes.push(routeSnapshot({
              destinationChain: destination,
              routeType: 'token_bridge',
              mode: 'manual',
              supported: true,
              prepareSupported: true,
              sourceMint: input.mintAddress,
              destinationToken,
            }));
          }
        } catch {
          // Ignore unsupported chains in token snapshots; the caller can quote
          // a specific destination to get a precise unsupported-route error.
        }
      }
      return {
        mintAddress: input.mintAddress,
        sourceChain: WORMHOLE_SOURCE_CHAIN,
        wormholeNetwork: input.wormholeNetwork,
        decimals,
        ...(input.includeWrappedAssets !== false && wrappedAssets.length > 0 ? { wrappedAssets } : {}),
        supportedRoutes,
        asOfIso: new Date().toISOString(),
      };
    },

    async quoteTransfer(_connection: Connection, input): Promise<WormholeQuoteSnapshot> {
      if (input.routeType === 'cctp' || input.routeType === 'ntt') {
        throw unsupportedRoute(`Wormhole ${input.routeType} routes are not wired in this connector yet. Use token_bridge/WTT.`);
      }
      const candidates: WormholeRouteMode[] = input.routeMode
        ? [input.routeMode]
        : input.routeType === 'token_bridge'
          ? ['manual']
          : input.nativeGasDropoff
            ? ['automatic']
            : ['automatic', 'manual'];
      const failures: string[] = [];
      for (const mode of candidates) {
        try {
          return await quoteTokenBridge(input, mode);
        } catch (err) {
          failures.push(errorMessage(err));
        }
      }
      throw quoteFailure(input, failures);
    },

    async getTransferStatus(_connection: Connection, input): Promise<WormholeTransferStatus> {
      const ctx = await context({
        wormholeNetwork: input.wormholeNetwork,
        ...(input.destinationChain !== undefined && { destinationChain: input.destinationChain }),
      });
      const updatedAtIso = new Date().toISOString();
      if (input.vaa?.trim()) {
        return {
          transferId: input.transferId,
          sourceChain: input.sourceChain ?? WORMHOLE_SOURCE_CHAIN,
          destinationChain: input.destinationChain,
          vaa: input.vaa.trim(),
          vaaAvailable: true,
          redeemed: false,
          state: input.destinationChain?.toLowerCase() === 'solana' ? 'ready_to_redeem' : 'pending_vaa',
          nextAction: input.destinationChain?.toLowerCase() === 'solana' ? 'redeem_on_solana' : 'redeem_on_destination',
          solanaExecutable: input.destinationChain?.toLowerCase() === 'solana',
          warnings: input.destinationChain?.toLowerCase() === 'solana'
            ? undefined
            : ['Destination-chain redemption is outside this Solana connector.'],
          updatedAtIso,
        };
      }
      if (!input.txid?.trim()) {
        return {
          transferId: input.transferId,
          sourceChain: input.sourceChain ?? WORMHOLE_SOURCE_CHAIN,
          destinationChain: input.destinationChain,
          vaaAvailable: false,
          redeemed: false,
          state: 'unknown',
          nextAction: 'none',
          solanaExecutable: false,
          warnings: ['Provide a source txid or VAA to resolve Wormhole transfer status.'],
          updatedAtIso,
        };
      }
      const status = await ctx.wh.getTransactionStatus(input.txid.trim(), 15_000).catch(() => null);
      return transferStatusFromSdkStatus(status, input, updatedAtIso);
    },

    async getWalletBridgeExposure(_connection: Connection, input): Promise<WormholeWalletBridgeExposure> {
      const ctx = await context({ wormholeNetwork: input.wormholeNetwork });
      const transactions = await ctx.wh.getTransactionsForAddress(input.walletAddress, 10, 0).catch(() => null);
      const statuses = (transactions ?? []).map((status) => transferStatusFromSdkStatus(status, {
        sourceChain: WORMHOLE_SOURCE_CHAIN,
        wormholeNetwork: input.wormholeNetwork,
        txid: status.txHash,
      }, new Date().toISOString()));
      return {
        walletAddress: input.walletAddress,
        sourceChain: WORMHOLE_SOURCE_CHAIN,
        pendingTransfers: input.includePendingTransfers === false
          ? []
          : statuses.filter((status) => status.state !== 'redeemed' && status.state !== 'failed'),
        recentTransfers: statuses,
        asOfIso: new Date().toISOString(),
      };
    },

    async buildTransferTransaction(connection: Connection, input): Promise<WormholeBuiltTransaction> {
      if (input.quote.routeType !== 'token_bridge') {
        throw unsupportedRoute(`Wormhole ${input.quote.routeType} transaction building is not wired yet. Use token_bridge/WTT.`);
      }
      const ctx = await context({
        wormholeNetwork: input.wormholeNetwork,
        destinationChain: input.destinationChain,
        sourceMint: input.sourceMint,
      });
      if (!ctx.destination || !ctx.destinationChain || !ctx.sourceToken) {
        throw unsupportedRoute('Wormhole transfer requires Solana source token and destination chain.');
      }
      const walletAddress = requireWallet(input.walletAddress);
      const from = ctx.sdk.Wormhole.chainAddress('Solana', walletAddress) as SdkSolanaChainAddress;
      const to = ctx.sdk.Wormhole.chainAddress(ctx.destinationChain, input.destinationAddress);
      const amountRaw = BigInt(input.amountRaw);
      const generator = input.quote.mode === 'automatic'
        ? await automaticTransferGenerator(ctx, from, to, ctx.sourceToken, amountRaw, input)
        : await manualTransferGenerator(ctx, from, to, ctx.sourceToken, amountRaw);
      const unsignedTransactions = await collectUnsignedTransactions(generator);
      const transactionBase64 = await serializeSingleSolanaTransaction(connection, walletAddress, unsignedTransactions);
      return {
        transactionBase64,
        programIds: programIdsForMode(ctx, input.quote.mode),
        reusable: false,
        quoteSnapshot: input.quote,
        routeSnapshot: input.quote.routeSnapshot,
        warnings: input.quote.warnings,
      };
    },

    async buildRedeemTransaction(_connection: Connection, _input: WormholeBuildRedeemInput): Promise<WormholeBuiltTransaction> {
      throw unsupportedRoute(
        'Wormhole Solana redeem transaction building is not wired yet because SDK redemption can require multiple prerequisite transactions.',
      );
    },

    async buildRecoverOrResumeTransaction(_connection: Connection, _input): Promise<WormholeBuiltTransaction> {
      throw unsupportedRoute(
        'Wormhole recover/resume transaction building is not wired yet because SDK recovery can require multiple prerequisite transactions.',
      );
    },
  };
}

async function sdkQuote(
  ctx: WormholeSdkContext,
  input: {
    sourceToken: SdkSolanaTokenId;
    amountRaw: bigint;
    mode: WormholeRouteMode;
    nativeGasRaw: bigint;
  },
): Promise<SdkQuote> {
  const protocol = input.mode === 'automatic' ? 'AutomaticTokenBridge' : 'TokenBridge';
  return ctx.sdk.TokenTransfer.quoteTransfer(ctx.wh, ctx.sourceChain, ctx.destination!, {
    token: input.sourceToken,
    amount: input.amountRaw,
    protocol,
    ...(protocol === 'AutomaticTokenBridge' && input.nativeGasRaw > 0n ? { nativeGas: input.nativeGasRaw } : {}),
  } as never);
}

async function manualTransferGenerator(
  ctx: WormholeSdkContext,
  from: SdkSolanaChainAddress,
  to: SdkChainAddress,
  sourceToken: SdkSolanaTokenId,
  amountRaw: bigint,
): Promise<AsyncGenerator<SdkUnsignedTransaction>> {
  const tokenBridge = await ctx.sourceChain.getTokenBridge();
  return tokenBridge.transfer(from.address as never, to as never, sourceToken.address as never, amountRaw) as AsyncGenerator<SdkUnsignedTransaction>;
}

async function automaticTransferGenerator(
  ctx: WormholeSdkContext,
  from: SdkSolanaChainAddress,
  to: SdkChainAddress,
  sourceToken: SdkSolanaTokenId,
  amountRaw: bigint,
  input: WormholeBuildTransferInput & { wormholeNetwork: WormholeNetwork },
): Promise<AsyncGenerator<SdkUnsignedTransaction>> {
  const tokenBridge = await ctx.sourceChain.getAutomaticTokenBridge();
  const nativeGasRaw = input.nativeGasDropoff
    ? parseDecimalAmount(input.nativeGasDropoff, input.sourceDecimals ?? 0, 'Wormhole native gas dropoff')
    : 0n;
  return tokenBridge.transfer(from.address as never, to as never, sourceToken.address as never, amountRaw, nativeGasRaw) as AsyncGenerator<SdkUnsignedTransaction>;
}

async function destinationTokenForMode(
  sdk: SdkBundle,
  sourceChain: SdkChainContext<'Solana'>,
  destinationChain: SdkChainContext | undefined,
  sourceToken: SdkSolanaTokenId,
  mode: WormholeRouteMode,
): Promise<string | undefined> {
  if (!destinationChain) return undefined;
  try {
    if (mode === 'automatic') {
      const sourceAutomatic = await sourceChain.getAutomaticTokenBridge();
      const destinationAutomatic = await destinationChain.getAutomaticTokenBridge();
      const registeredSource = sdk.isNative(sourceToken.address)
        ? true
        : await sourceAutomatic.isRegisteredToken(sourceToken.address as never);
      if (!registeredSource) return undefined;
      const destination = await sdk.TokenTransfer.lookupDestinationToken(sourceChain, destinationChain, sourceToken as never);
      const registeredDestination = await destinationAutomatic.isRegisteredToken(destination.address as never);
      return registeredDestination ? sdk.canonicalAddress(destination) : undefined;
    }
    const destination = await sdk.TokenTransfer.lookupDestinationToken(sourceChain, destinationChain, sourceToken as never);
    return sdk.canonicalAddress(destination);
  } catch {
    return undefined;
  }
}

function quoteSnapshotFromSdkQuote(
  input: WormholeQuoteInput & { wormholeNetwork: WormholeNetwork },
  values: {
    sdk: SdkBundle;
  sourceToken: SdkSolanaTokenId;
    destinationChain: SdkChain;
    quote: SdkQuote;
    mode: WormholeRouteMode;
    sourceDecimals?: number;
  },
): WormholeQuoteSnapshot {
  const destinationToken = values.sdk.canonicalAddress(values.quote.destinationToken.token);
  const bridgeFee = values.quote.relayFee
    ? rawToUiAmount(values.quote.relayFee.amount, values.sourceDecimals ?? 0)
    : '0';
  const estimatedDestinationAmount = rawToUiAmount(
    values.quote.destinationToken.amount,
    values.sourceDecimals ?? 0,
  );
  const warnings = [
    ...(values.quote.warnings?.map((warning) => errorMessage(warning)) ?? []),
    ...(values.mode === 'manual'
      ? ['Manual redemption is required on the destination chain after Guardian attestation.']
      : []),
  ];
  return {
    quoteId: [
      'wormhole',
      input.wormholeNetwork.toLowerCase(),
      values.mode,
      input.sourceMint,
      input.destinationChain,
      Date.now().toString(36),
    ].join(':'),
    sourceChain: WORMHOLE_SOURCE_CHAIN,
    destinationChain: input.destinationChain,
    sourceMint: input.sourceMint,
    destinationToken,
    destinationAddress: input.destinationAddress,
    amount: input.amount,
    amountRaw: input.amountRaw,
    routeType: 'token_bridge',
    mode: values.mode,
    estimatedDestinationAmount,
    bridgeFee,
    bridgeFeeToken: values.sdk.canonicalAddress(values.quote.relayFee?.token ?? values.sourceToken),
    ...(input.nativeGasDropoff !== undefined && { nativeGasDropoff: input.nativeGasDropoff }),
    manualRedemptionRequired: values.mode === 'manual',
    relayerSupported: values.mode === 'automatic',
    etaSeconds: values.quote.eta,
    programIds: programIdsForMode({ wh: undefined, destinationChain: values.destinationChain }, values.mode),
    routeSnapshot: routeSnapshot({
      destinationChain: input.destinationChain,
      routeType: 'token_bridge',
      mode: values.mode,
      supported: true,
      prepareSupported: true,
      sourceMint: input.sourceMint,
      destinationToken,
      bridgeFee,
    }),
    warnings: warnings.length > 0 ? warnings : undefined,
    asOfIso: new Date().toISOString(),
    ...(values.quote.expires !== undefined ? { expiresAtIso: values.quote.expires.toISOString() } : {}),
  };
}

function routeSnapshot(input: {
  destinationChain: string;
  routeType: WormholeRouteType;
  mode: WormholeRouteMode;
  supported: boolean;
  prepareSupported: boolean;
  sourceMint?: string;
  destinationToken?: string;
  bridgeFee?: string;
  warnings?: string[];
}): WormholeRouteSnapshot {
  return {
    sourceChain: WORMHOLE_SOURCE_CHAIN,
    destinationChain: input.destinationChain,
    routeType: input.routeType,
    mode: input.mode,
    supported: input.supported,
    prepareSupported: input.prepareSupported,
    manualRedemptionRequired: input.mode === 'manual',
    relayerSupported: input.mode === 'automatic',
    ...(input.sourceMint !== undefined && { sourceMint: input.sourceMint }),
    ...(input.destinationToken !== undefined && { destinationToken: input.destinationToken }),
    ...(input.bridgeFee !== undefined && { bridgeFee: input.bridgeFee }),
    programIds: programIdsForMode(undefined, input.mode),
    ...(input.warnings !== undefined && { warnings: input.warnings }),
  };
}

function unsupportedRouteSnapshot(
  destinationChain: string,
  routeType: WormholeRouteType,
  err: unknown,
): WormholeRouteSnapshot {
  const concreteRouteType = routeType === 'auto' ? 'token_bridge' : routeType;
  return routeSnapshot({
    destinationChain,
    routeType: concreteRouteType,
    mode: 'manual',
    supported: false,
    prepareSupported: false,
    warnings: [err ? errorMessage(err) : `Wormhole ${routeType} is not wired in this connector.`],
  });
}

function transferStatusFromSdkStatus(
  status: unknown,
  input: WormholeStatusInput & { wormholeNetwork: WormholeNetwork },
  updatedAtIso: string,
): WormholeTransferStatus {
  const record = isRecord(status) ? status : undefined;
  const globalTx = isRecord(record?.globalTx) ? record.globalTx : undefined;
  const destinationTx = isRecord(globalTx?.destinationTx) ? globalTx.destinationTx : undefined;
  const sourceTxid = stringValue(record?.txHash) ?? input.txid;
  const destinationTxid = stringValue(destinationTx?.txHash);
  const destinationChain = input.destinationChain ?? chainNameFromWormholeId(numberValue(record?.standardizedProperties, 'toChain'));
  const redeemed = destinationTxid !== undefined || stringValue(destinationTx?.status)?.toLowerCase() === 'completed';
  const vaaAvailable = Boolean(record);
  return {
    transferId: input.transferId ?? stringValue(record?.id),
    sourceChain: input.sourceChain ?? WORMHOLE_SOURCE_CHAIN,
    ...(destinationChain !== undefined && { destinationChain }),
    ...(sourceTxid !== undefined && { sourceTxid }),
    ...(destinationTxid !== undefined && { destinationTxid }),
    vaaAvailable,
    redeemed,
    state: redeemed ? 'redeemed' : vaaAvailable ? 'ready_to_redeem' : 'pending_vaa',
    nextAction: redeemed
      ? 'none'
      : destinationChain?.toLowerCase() === 'solana'
        ? 'redeem_on_solana'
        : vaaAvailable
          ? 'redeem_on_destination'
          : 'wait_for_vaa',
    solanaExecutable: destinationChain?.toLowerCase() === 'solana' && !redeemed,
    warnings: destinationChain && destinationChain.toLowerCase() !== 'solana' && !redeemed
      ? ['Destination-chain redemption is outside this Solana connector.']
      : undefined,
    updatedAtIso,
  };
}

async function collectUnsignedTransactions(generator: AsyncGenerator<SdkUnsignedTransaction>): Promise<SdkUnsignedTransaction[]> {
  const transactions: SdkUnsignedTransaction[] = [];
  for await (const transaction of generator) transactions.push(transaction);
  return transactions;
}

async function serializeSingleSolanaTransaction(
  connection: Connection,
  walletAddress: string,
  transactions: SdkUnsignedTransaction[],
): Promise<string> {
  if (transactions.length !== 1) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'multi_tx_not_supported',
      `Wormhole SDK produced ${transactions.length} transactions; this connector currently supports one transaction per approval.`,
    );
  }
  const transaction = transactions[0];
  if (!transaction || transaction.chain !== 'Solana') {
    throw unsupportedRoute('Wormhole SDK did not return a Solana source transaction.');
  }
  const solanaTransaction = isRecord(transaction.transaction) ? transaction.transaction : undefined;
  const sdkTransaction = solanaTransaction?.transaction;
  const signers = Array.isArray(solanaTransaction?.signers) ? solanaTransaction.signers as Keypair[] : [];
  if (sdkTransaction instanceof VersionedTransaction) {
    if (signers.length > 0) sdkTransaction.sign(signers);
    return Buffer.from(sdkTransaction.serialize()).toString('base64');
  }
  if (sdkTransaction instanceof Transaction) {
    sdkTransaction.feePayer = sdkTransaction.feePayer ?? new PublicKey(walletAddress);
    if (!sdkTransaction.recentBlockhash) {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      sdkTransaction.recentBlockhash = blockhash;
    }
    if (signers.length > 0) sdkTransaction.partialSign(...signers);
    return sdkTransaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }
  throw unsupportedRoute('Wormhole SDK returned an unsupported Solana transaction shape.');
}

function programIdsForMode(
  ctx: { wh?: unknown; destinationChain?: SdkChain } | undefined,
  mode: WormholeRouteMode,
): string[] {
  void ctx;
  if (mode === 'manual') return WORMHOLE_PROGRAM_IDS;
  return [
    ...WORMHOLE_PROGRAM_IDS,
    '3vxKRPwUTiEkeUVyoZ9MXFe1V71sRLbLqu1gRYaWmehQ',
  ];
}

function sdkNetworkFromAdapter(network: WormholeNetwork): SdkNetwork {
  if (network === 'Mainnet' || network === 'Testnet') return network;
  throw unsupportedRoute(`Unsupported Wormhole network ${network}.`);
}

function sdkChainFromAdapter(chain: string): SdkChain {
  const normalized = chain.replace(/[\s_-]+/g, '').toLowerCase();
  if (normalized === 'solana') return 'Solana';
  if (normalized === 'ethereum' || normalized === 'eth') return 'Ethereum';
  if (normalized === 'base') return 'Base';
  if (normalized === 'arbitrum') return 'Arbitrum';
  if (normalized === 'optimism') return 'Optimism';
  if (normalized === 'polygon') return 'Polygon';
  if (normalized === 'avalanche' || normalized === 'avax') return 'Avalanche';
  if (normalized === 'bsc' || normalized === 'bnb' || normalized === 'binance') return 'Bsc';
  throw unsupportedRoute(`Wormhole SDK client is currently wired for Solana to EVM Token Bridge routes; ${chain} is not supported yet.`);
}

function buildChainOverrides(
  solanaRpcUrl: string,
  evmRpcUrls: Record<string, string | undefined> | undefined,
): Record<string, { rpc: string }> {
  const overrides: Record<string, { rpc: string }> = {
    Solana: { rpc: solanaRpcUrl },
  };
  for (const [chain, envNames] of Object.entries(EVM_RPC_ENV_BY_CHAIN)) {
    const rpc = evmRpcUrls?.[chain]?.trim() ?? firstEnv(envNames);
    if (rpc) overrides[chain] = { rpc };
  }
  return overrides;
}

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function tokenAddressForSdk(sourceMint: string): string {
  return sourceMint === 'native' ? 'native' : sourceMint;
}

function requireWallet(walletAddress: string | undefined): string {
  if (walletAddress?.trim()) return walletAddress.trim();
  throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_request', 'Wormhole transfer requires a connected wallet address.');
}

function rawToUiAmount(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionText}`;
}

function chainNameFromWormholeId(id: number | undefined): string | undefined {
  switch (id) {
    case 1:
      return 'Solana';
    case 2:
      return 'Ethereum';
    case 4:
      return 'Bsc';
    case 5:
      return 'Polygon';
    case 6:
      return 'Avalanche';
    case 23:
      return 'Arbitrum';
    case 24:
      return 'Optimism';
    case 30:
      return 'Base';
    default:
      return undefined;
  }
}

function numberValue(record: unknown, key: string): number | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function unsupportedRoute(message: string): AdapterError {
  return new AdapterError(WORMHOLE_ADAPTER_ID, 'unsupported_route', message);
}

function quoteFailure(input: WormholeQuoteInput, failures: string[]): AdapterError {
  const message = failures.join(' ');
  if (failures.some(isNetworkFailureMessage)) {
    return new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'sdk_request_failed',
      `Wormhole SDK quote failed while checking Solana ${input.sourceMint} to ${input.destinationChain}: ${message}`,
    );
  }
  return unsupportedRoute(
    `No Wormhole Token Bridge route from Solana ${input.sourceMint} to ${input.destinationChain}. ${message}`,
  );
}

function isNetworkFailureMessage(message: string): boolean {
  return /\b(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network|timeout)\b/i.test(message);
}
