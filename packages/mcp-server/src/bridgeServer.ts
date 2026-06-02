import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  ProtocolError,
  SolanaSigningClient,
  type AdapterCapabilities,
  type ProtocolErrorPayload,
  type SigningRequest,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';
import { IosLinkBackend } from '@solana-agent-wallet-adapter/ios-link';
import { Connection, PublicKey } from '@solana/web3.js';

import {
  AgentWalletActionService,
} from './actionService.js';
import { AdapterError, type ConnectorSecretsMap } from './adapters/types.js';
import {
  AgentRegistry,
  isAgentTier,
  publicizeAgent,
  tierMeetsMinimum,
  type AgentTier,
  type RegisteredAgent,
} from './agentRegistry.js';
import { BridgeAiPlanner, type AiPlanRequest, type AiReviewRequest, type AiAskRequest, type AiChatRequest } from './aiPlanner.js';
import { makeTransactionSimulator } from './simulationDigest.js';
import {
  birdeyeConfigFromEnv,
  requestBirdeyeExitLiquidityMulti,
  requestBirdeyeHistoryPrice,
  requestBirdeyeNewListings,
  requestBirdeyeOhlcv,
  requestBirdeyePriceMulti,
  requestBirdeyePriceVolumeMulti,
  requestBirdeyePriceVolumeSingle,
  requestBirdeyeSearch,
  requestBirdeyeTokenCreationInfo,
  requestBirdeyeTokenHolders,
  requestBirdeyeTokenListV3,
  requestBirdeyeTokenMetadata,
  requestBirdeyeTokenSecurity,
  requestBirdeyeTrendingTokens,
  requestBirdeyeWalletTokenList,
  type BirdeyeHistoryPriceType,
  type BirdeyeOhlcvType,
  type BirdeyePriceVolumeType,
  type BirdeyeTokenListSortBy,
} from './birdeye.js';
import { getBirdeyeWebSocketSnapshot } from './birdeyeWebSocket.js';
import {
  listCoinGeckoEndpointCatalog,
  requestCoinGeckoEndpoint,
  requestCoinGeckoGlobal,
  requestCoinGeckoSolanaTokenEvidence,
} from './coingecko.js';
import { heliusConfigFromEnv } from './helius.js';
import { defaultRpcUrl, getPhoenixVulcanPolicy, type AgentWalletConfig } from './config.js';
import { parseDecimalAmount } from './amounts.js';
import { LocalBridgeBackend } from './localBridgeBackend.js';
import type { LabArtifact, LabArtifactStore } from './labArtifacts.js';
import type { PreparedAction, PreparedActionStore, PreparedActionTxStatus } from './preparedActions.js';
import { trace } from './trace.js';
import { VulcanUpstreamClient, VulcanWalletRegistry } from './upstreamMcp/index.js';

const MAX_BRIDGE_JSON_BYTES = 1024 * 1024;

export interface BridgeServerHandle {
  url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateBridgeServerOptions {
  backend: LocalBridgeBackend | IosLinkBackend;
  actionConfig?: AgentWalletConfig;
  preparedActions?: PreparedActionStore;
  labArtifacts?: LabArtifactStore;
  host?: string;
  port?: number;
  agentRegistry?: AgentRegistry;
  agentsPersistPath?: string;
}

export function createBridgeServer(options: CreateBridgeServerOptions): BridgeServerHandle {
  const host = options.host ?? '127.0.0.1';
  assertLoopbackBind(host);
  const port = options.port ?? 8787;
  const backend = options.backend;
  const actionConfig = options.actionConfig;
  const preparedActions = options.preparedActions;
  const labArtifacts = options.labArtifacts;
  const { client: vulcanUpstreamClient, registry: vulcanWalletRegistry } =
    actionConfig ? buildVulcanWalletStuff(actionConfig) : { client: undefined, registry: undefined };
  const actionService = actionConfig
    ? new AgentWalletActionService({
        backend,
        config: actionConfig,
        ...(preparedActions !== undefined && { preparedActions }),
        ...(vulcanUpstreamClient ? { vulcanUpstreamClient } : {}),
        ...(vulcanWalletRegistry ? { vulcanWalletRegistry } : {}),
      })
    : undefined;
  const aiPlanner = new BridgeAiPlanner();
  // Wire a transaction simulator if we have an action config (i.e. mainnet/devnet RPC).
  // The planner uses this to populate `context.simulationDigest` when a request includes
  // `context.transactionBase64`, lighting up the workflow's tx_gate analyzers live.
  // Also threads the same Connection into the capability-resolver shims so the
  // `network_metric` atom type (TPS / slot height / validator jailed / epoch progress)
  // resolves live against the configured Solana RPC (Helius, QuickNode, public, etc.).
  if (actionConfig) {
    try {
      const simConnection = new Connection(actionConfig.rpcUrl, 'confirmed');
      aiPlanner.simulator = makeTransactionSimulator(simConnection);
      aiPlanner.connection = simConnection;
    } catch {
      // Bad RPC URL → no simulator, no network_metric resolver; both atom kinds stay
      // unresolved and the review still works.
    }
  }
  const agentRegistry = options.agentRegistry ?? new AgentRegistry({
    ...(options.agentsPersistPath ? { persistPath: options.agentsPersistPath } : {}),
    fallbackToken: backend.token,
  });
  const url = `http://${host}:${port}/`;
  backend.setApprovalBaseUrl(url);

  let server: Server | null = null;

  return {
    url,
    async start() {
      await agentRegistry.load().catch(() => undefined);
      if (vulcanUpstreamClient) {
        try {
          await vulcanUpstreamClient.start();
          trace('vulcan.upstream.connected', {});
        } catch (err) {
          trace('vulcan.upstream.start_failed', {
            message: err instanceof Error ? err.message : String(err),
          });
          // Soft-fail: bridge still serves; Vulcan-routed actions return unsupported_method.
        }
      }
      await new Promise<void>((resolve, reject) => {
        server = createServer((req, res) => {
          void handleRequest(req, res, backend, actionConfig, preparedActions, labArtifacts, actionService, aiPlanner, agentRegistry);
        });
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
    },
    async stop() {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => (err ? reject(err) : resolve()));
        });
        server = null;
      }
      // D4: tear down all wallet subprocesses when running in multi-wallet mode. Single-client mode falls through
      // to the existing path.
      if (vulcanWalletRegistry) {
        try {
          await vulcanWalletRegistry.stopAll();
        } catch {
          // Ignore: subprocess teardown is best-effort.
        }
      }
      if (vulcanUpstreamClient?.isRunning()) {
        try {
          await vulcanUpstreamClient.stop();
        } catch {
          // Ignore: subprocess teardown is best-effort.
        }
      }
    },
  };
}

/**
 * Builds the upstream Vulcan plumbing from policy config. Returns either a single-client setup (the legacy path) or
 * a multi-wallet registry. Returns `{}` when Vulcan is disabled.
 *
 * D4 multi-wallet mode is triggered when `walletPasswordsByEnvVar` is non-empty. Otherwise the existing single-client
 * path is used, preserving backward compatibility for deployments that haven't migrated.
 */
function buildVulcanWalletStuff(config: AgentWalletConfig): {
  client?: VulcanUpstreamClient;
  registry?: VulcanWalletRegistry;
} {
  const policy = getPhoenixVulcanPolicy(config);
  if (!policy.enabled) return {};

  const baseOptions: ConstructorParameters<typeof VulcanUpstreamClient>[0] = {
    binaryPath: policy.binaryPath,
    allowDangerous: policy.allowDangerous,
    toolCallTimeoutMs: policy.maxToolCallTimeoutMs,
    autoRestart: policy.autoRestart,
  };
  if (policy.restartBackoffMs) baseOptions.restartBackoffMs = policy.restartBackoffMs;
  if (policy.requiredServerName) baseOptions.requiredServerName = policy.requiredServerName;
  if (policy.requiredServerVersion) baseOptions.requiredServerVersion = policy.requiredServerVersion;

  // Multi-wallet mode: build a registry that lazily spawns one subprocess per wallet on demand.
  if (policy.walletPasswordsByEnvVar && Object.keys(policy.walletPasswordsByEnvVar).length > 0) {
    const walletPasswordsByName: Record<string, string> = {};
    const missing: string[] = [];
    for (const [walletName, envVar] of Object.entries(policy.walletPasswordsByEnvVar)) {
      const password = process.env[envVar]?.trim();
      if (password) walletPasswordsByName[walletName] = password;
      else if (policy.allowDangerous) missing.push(`${walletName} (expects ${envVar})`);
    }
    if (missing.length > 0) {
      const reason = `multi-wallet mode missing passwords for: ${missing.join(', ')}; affected wallets will be unable to sign.`;
      trace('vulcan.upstream.config_skipped', { reason });
      if (process.env.VULCAN_LOG_LEVEL !== 'silent') {
        // eslint-disable-next-line no-console
        console.warn(`[vulcan-upstream] ${reason}`);
      }
    }
    const registryOptions: ConstructorParameters<typeof VulcanWalletRegistry>[0] = {
      baseOptions,
      walletPasswordsByName,
    };
    const defaultName = policy.defaultWalletName ?? policy.walletName;
    if (defaultName) registryOptions.defaultWalletName = defaultName;
    if (policy.allowedWallets) registryOptions.allowedWallets = policy.allowedWallets;
    return { registry: new VulcanWalletRegistry(registryOptions) };
  }

  // Single-wallet legacy path.
  const password = policy.allowDangerous ? process.env[policy.walletPasswordEnvVar]?.trim() : undefined;
  if (policy.allowDangerous && !password) {
    const reason = `allowDangerous requires ${policy.walletPasswordEnvVar} to be set; disabling signing tools.`;
    trace('vulcan.upstream.config_skipped', { reason });
    if (process.env.VULCAN_LOG_LEVEL !== 'silent') {
      // eslint-disable-next-line no-console
      console.warn(
        `[vulcan-upstream] PHOENIX_VULCAN_ALLOW_DANGEROUS=true but ${policy.walletPasswordEnvVar} is not set. ` +
          'Signing tools will be unavailable; the bridge will not start Vulcan.',
      );
    }
    return {};
  }
  const clientOptions: ConstructorParameters<typeof VulcanUpstreamClient>[0] = { ...baseOptions };
  if (policy.walletName) clientOptions.walletName = policy.walletName;
  if (password) clientOptions.walletPassword = password;
  return { client: new VulcanUpstreamClient(clientOptions) };
}

function assertLoopbackBind(host: string): void {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.')
  ) {
    return;
  }
  throw new ProtocolError(
    'invalid_request',
    `Refusing to bind the local bridge to non-loopback host "${host}". Use 127.0.0.1 or localhost.`,
  );
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  backend: LocalBridgeBackend | IosLinkBackend,
  actionConfig: AgentWalletConfig | undefined,
  preparedActions: PreparedActionStore | undefined,
  labArtifacts: LabArtifactStore | undefined,
  actionService: AgentWalletActionService | undefined,
  aiPlanner: BridgeAiPlanner,
  agentRegistry: AgentRegistry,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  const agent = authorize(req, url, backend, agentRegistry);
  if (!agent) {
    writeJson(res, 401, { error: 'unauthorized' });
    return;
  }
  if (!agent.enabled) {
    writeJson(res, 401, { error: 'unauthorized', message: 'Agent disabled.' });
    return;
  }
  if (requiresHostBridgeToken(req.method, url.pathname) && !usesHostBridgeToken(req, url, backend)) {
    writeJson(res, 403, {
      error: 'forbidden',
      message: 'Only the wallet host bridge token can control wallet connection or resolve approvals.',
      requiredRole: 'wallet_host',
    });
    return;
  }
  if (req.method && req.method !== 'OPTIONS') {
    const tierRequired = requiredTier(req.method, url.pathname);
    if (tierRequired && !tierMeetsMinimum(agent.tier, tierRequired)) {
      writeJson(res, 403, {
        error: 'forbidden',
        message: `Agent "${agent.label}" tier (${agent.tier}) cannot access ${req.method} ${url.pathname}.`,
        requiredTier: tierRequired,
        actualTier: agent.tier,
      });
      return;
    }
  }
  agentRegistry.markSeen(agent.token);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      writeHtml(res, bridgeHtml(backend.token, bridgeOrigin(url)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/ios/approval') {
      if (!isIosBackend(backend)) {
        throw new ProtocolError('unsupported_method', 'iOS approval route is not configured.');
      }
      const requestId = url.searchParams.get('requestId');
      if (!requestId) {
        throw new ProtocolError('invalid_request', 'Missing requestId.');
      }
      writeHtml(res, await iosApprovalHtml(backend, requestId));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/ios/callback/')) {
      if (!isIosBackend(backend)) {
        throw new ProtocolError('unsupported_method', 'iOS callback route is not configured.');
      }
      const approval = await backend.handleCallback(url);
      writeHtml(res, iosCallbackHtml(approval.status));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/status') {
      writeJson(res, 200, await backend.capabilities());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/agents') {
      const reveal = url.searchParams.get('reveal') === '1';
      const agents = agentRegistry.list();
      const payload = reveal
        ? agents.map((a) => ({ ...publicizeAgent(a), token: a.token }))
        : agents.map(publicizeAgent);
      writeJson(res, 200, { agents: payload });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/agents') {
      const body = (await readJson(req)) as { agents?: unknown };
      if (!Array.isArray(body.agents)) {
        throw new ProtocolError('invalid_request', 'Missing agents array.');
      }
      const replaced = agentRegistry.replaceAll(body.agents as Array<Partial<RegisteredAgent>>);
      writeJson(res, 200, { agents: replaced.map(publicizeAgent) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/agents/issue') {
      const body = (await readJson(req)) as { label?: string; tier?: string; notes?: string };
      if (!body.label || typeof body.label !== 'string' || !body.label.trim()) {
        throw new ProtocolError('invalid_request', 'Missing agent label.');
      }
      const tier = isAgentTier(body.tier) ? body.tier : 'capped';
      const issued = agentRegistry.issueAgent({
        label: body.label,
        tier,
        ...(typeof body.notes === 'string' && body.notes ? { notes: body.notes } : {}),
      });
      writeJson(res, 200, { agent: { ...publicizeAgent(issued), token: issued.token } });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/agents/delete') {
      const body = (await readJson(req)) as { agentId?: string };
      if (!body.agentId) {
        throw new ProtocolError('invalid_request', 'Missing agentId.');
      }
      const removed = agentRegistry.remove(body.agentId);
      writeJson(res, 200, { removed });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/config') {
      if (!isLocalBridgeBackend(backend)) {
        throw new ProtocolError('unsupported_method', 'Bridge config is only available for local browser bridge mode.');
      }
      writeJson(res, 200, backend.getConfig());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/prepared-actions') {
      writeJson(
        res,
        200,
        actionService ? await actionService.listPreparedActions() : { materialized: [], actions: [] },
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/prepared-actions/archive') {
      const body = (await readJson(req)) as { actionId?: string };
      if (!body.actionId) {
        throw new ProtocolError('invalid_request', 'Missing actionId.');
      }
      writeJson(res, 200, await requireActionService(actionService).archivePreparedAction(body.actionId));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/prepared-actions/delete') {
      const body = (await readJson(req)) as { actionId?: string };
      if (!body.actionId) {
        throw new ProtocolError('invalid_request', 'Missing actionId.');
      }
      writeJson(res, 200, await requireActionService(actionService).deletePreparedAction(body.actionId));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/prepared-actions/tx-status') {
      writeJson(res, 200, await requireActionService(actionService).refreshPreparedActionTxStatuses());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/recurring-payments') {
      writeJson(
        res,
        200,
        actionService ? await actionService.listRecurringPayments() : { materialized: [], recurringPayments: [] },
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/recurring-payments') {
      const body = (await readJson(req)) as {
        status?: 'active' | 'paused';
        actionKind?: 'transfer' | 'swap';
        token?: string;
        inputToken?: string;
        outputToken?: string;
        recipient?: string;
        amount?: string;
        slippageBps?: number;
        cadence?: 'weekly' | 'monthly' | 'interval_days' | 'interval_hours' | 'interval_minutes';
        dayOfWeek?: number;
        dayOfMonth?: number;
        intervalDays?: number;
        intervalHours?: number;
        intervalMinutes?: number;
        localTime?: string;
        startAt?: string;
        maxOccurrences?: number;
        note?: string;
        expiresAt?: string;
        notifications?: { inApp?: boolean; webhookUrl?: string };
        metadata?: Record<string, unknown>;
      };
      writeJson(res, 200, await requireActionService(actionService).createRecurringPayment(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/recurring-payments/update') {
      const body = (await readJson(req)) as {
        status?: 'active' | 'paused';
        recurringId?: string;
        actionKind?: 'transfer' | 'swap';
        token?: string;
        inputToken?: string;
        outputToken?: string;
        recipient?: string;
        amount?: string;
        slippageBps?: number;
        cadence?: 'weekly' | 'monthly' | 'interval_days' | 'interval_hours' | 'interval_minutes';
        dayOfWeek?: number;
        dayOfMonth?: number;
        intervalDays?: number;
        intervalHours?: number;
        intervalMinutes?: number;
        localTime?: string;
        startAt?: string;
        maxOccurrences?: number;
        note?: string;
        expiresAt?: string;
        notifications?: { inApp?: boolean; webhookUrl?: string };
        metadata?: Record<string, unknown>;
      };
      if (!body.recurringId) {
        throw new ProtocolError('invalid_request', 'Missing recurringId.');
      }
      writeJson(res, 200, await requireActionService(actionService).updateRecurringPayment({ ...body, recurringId: body.recurringId }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/recurring-payments/pause') {
      const body = (await readJson(req)) as { recurringId?: string };
      if (!body.recurringId) {
        throw new ProtocolError('invalid_request', 'Missing recurringId.');
      }
      writeJson(res, 200, await requireActionService(actionService).pauseRecurringPayment(body.recurringId));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/recurring-payments/resume') {
      const body = (await readJson(req)) as { recurringId?: string };
      if (!body.recurringId) {
        throw new ProtocolError('invalid_request', 'Missing recurringId.');
      }
      writeJson(res, 200, await requireActionService(actionService).resumeRecurringPayment(body.recurringId));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/recurring-payments/delete') {
      const body = (await readJson(req)) as { recurringId?: string };
      if (!body.recurringId) {
        throw new ProtocolError('invalid_request', 'Missing recurringId.');
      }
      writeJson(res, 200, await requireActionService(actionService).deleteRecurringPayment(body.recurringId));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/receipts') {
      writeJson(res, 200, actionService ? await actionService.receipts() : { receipts: [] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/lab-artifacts') {
      const walletAddress = await backend.getAddress();
      writeJson(res, 200, {
        artifacts: labArtifacts ? filterLabArtifactsForWallet(await labArtifacts.listArtifacts(), walletAddress) : [],
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/lab-artifacts') {
      const body = (await readJson(req)) as { artifact?: unknown };
      const artifact = requireLabArtifact(body.artifact);
      assertLabArtifactWalletOwner(artifact, await backend.getAddress());
      writeJson(res, 200, { artifact: await requireLabArtifactStore(labArtifacts).upsertArtifact(artifact) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/lab-artifacts/delete') {
      const body = (await readJson(req)) as { artifactId?: string };
      if (!body.artifactId) {
        throw new ProtocolError('invalid_request', 'Missing artifactId.');
      }
      const store = requireLabArtifactStore(labArtifacts);
      const walletAddress = await backend.getAddress();
      const artifact = (await store.listArtifacts()).find((candidate) => candidate.id === body.artifactId);
      if (!artifact) {
        throw new ProtocolError('invalid_request', `Unknown lab artifact: ${body.artifactId}`);
      }
      assertLabArtifactWalletOwner(artifact, walletAddress);
      writeJson(res, 200, { deleted: await store.deleteArtifact(body.artifactId) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/health') {
      const caps = await backend.capabilities().catch(() => null);
      const rpcWritable = actionConfig
        ? await checkRpcWritable(actionConfig.rpcUrl)
        : { ok: false, message: 'Action config unavailable.' };
      const birdeye = birdeyeConfigFromEnv();
      const helius = heliusConfigFromEnv();
      writeJson(res, 200, {
        walletConnected: Boolean(caps?.address),
        walletAddress: caps?.address ?? null,
        bridgeConnected: isLocalBridgeBackend(backend) ? Boolean(caps?.address) : true,
        mcpReady: Boolean(actionConfig),
        cluster: actionConfig?.cluster ?? null,
        rpcUrl: actionConfig?.rpcUrl ?? null,
        rpcWritable,
        marketDataReady: Boolean(birdeye.apiKey),
        birdeyeRestBase: birdeye.restBase,
        birdeyeWebSocketReady: birdeye.wsEnabled,
        heliusReady: Boolean(helius.apiKey || helius.rpcUrl),
        heliusEnhancedReady: Boolean(helius.parseTransactionHistoryUrl && helius.parseTransactionsUrl),
        mainnetEnabled: actionConfig?.mainnet.enabled ?? false,
        capsEnabled: Boolean(actionConfig?.mainnet.enabled),
        preparedActionStorePath: preparedActions?.getStoragePath?.() ?? null,
        labArtifactStorePath: labArtifacts?.getStoragePath?.() ?? null,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/solana/latest-blockhash') {
      const body = (await readJson(req)) as { cluster?: string };
      writeJson(res, 200, await bridgeLatestBlockhash(requireActionConfig(actionConfig), body.cluster));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/solana/send-transaction') {
      const body = (await readJson(req)) as { cluster?: string; signedTransaction?: string; signedTransactionBase64?: string };
      writeJson(
        res,
        200,
        await bridgeSendTransaction(
          requireActionConfig(actionConfig),
          body.cluster,
          body.signedTransactionBase64 ?? body.signedTransaction,
        ),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/solana/signature-status') {
      const body = (await readJson(req)) as { cluster?: string; txid?: string; signature?: string };
      writeJson(
        res,
        200,
        await bridgeSignatureStatus(requireActionConfig(actionConfig), body.cluster, body.txid ?? body.signature),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/price-multi') {
      const body = (await readJson(req)) as {
        addresses?: unknown;
        includeLiquidity?: boolean;
        checkLiquidity?: unknown;
        uiAmountMode?: 'raw' | 'scaled' | 'both';
      };
      writeJson(res, 200, await requestBirdeyePriceMulti(requireStringArray(body.addresses, 'addresses'), {
        includeLiquidity: body.includeLiquidity,
        checkLiquidity: typeof body.checkLiquidity === 'number' ? body.checkLiquidity : undefined,
        uiAmountMode: body.uiAmountMode,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/search') {
      const body = (await readJson(req)) as { keyword?: string; query?: string; limit?: number };
      writeJson(res, 200, await requestBirdeyeSearch(requireString(body.keyword ?? body.query, 'keyword'), {
        limit: body.limit,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/token-meta') {
      const body = (await readJson(req)) as { addresses?: unknown };
      writeJson(res, 200, await requestBirdeyeTokenMetadata(requireStringArray(body.addresses, 'addresses')));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/token-security') {
      const body = (await readJson(req)) as { address?: unknown };
      writeJson(res, 200, await requestBirdeyeTokenSecurity(requireString(body.address, 'address')));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/wallet-token-list') {
      const body = (await readJson(req)) as { wallet?: unknown; walletAddress?: unknown; uiAmountMode?: 'raw' | 'scaled' | 'both' };
      const wallet = await scopedBridgeWalletAddress(backend, body.wallet ?? body.walletAddress);
      writeJson(res, 200, await requestBirdeyeWalletTokenList(wallet, {
        uiAmountMode: body.uiAmountMode,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/token-holders') {
      const body = (await readJson(req)) as { address?: unknown; limit?: number; offset?: number };
      writeJson(res, 200, await requestBirdeyeTokenHolders(requireString(body.address, 'address'), {
        limit: body.limit,
        offset: body.offset,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/token-creation-info') {
      const body = (await readJson(req)) as { address?: unknown };
      writeJson(res, 200, await requestBirdeyeTokenCreationInfo(requireString(body.address, 'address')));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/exit-liquidity-multi') {
      const body = (await readJson(req)) as { addresses?: unknown };
      writeJson(res, 200, await requestBirdeyeExitLiquidityMulti(requireStringArray(body.addresses, 'addresses')));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/price-volume') {
      const body = (await readJson(req)) as {
        address?: unknown;
        addresses?: unknown;
        type?: BirdeyePriceVolumeType;
        uiAmountMode?: 'raw' | 'scaled' | 'both';
      };
      const addresses = optionalStringArray(body.addresses);
      writeJson(res, 200, addresses.length
        ? await requestBirdeyePriceVolumeMulti(addresses, { type: body.type, uiAmountMode: body.uiAmountMode })
        : await requestBirdeyePriceVolumeSingle(requireString(body.address, 'address'), { type: body.type }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/history-price') {
      const body = (await readJson(req)) as {
        address?: unknown;
        addressType?: 'token' | 'pair';
        type?: BirdeyeHistoryPriceType;
        timeFrom?: number;
        timeTo?: number;
      };
      writeJson(res, 200, await requestBirdeyeHistoryPrice(requireString(body.address, 'address'), {
        addressType: body.addressType,
        type: body.type,
        timeFrom: body.timeFrom,
        timeTo: body.timeTo,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/ohlcv') {
      const body = (await readJson(req)) as {
        address?: unknown;
        type?: BirdeyeOhlcvType;
        timeFrom?: number;
        timeTo?: number;
        currency?: 'usd' | 'native';
      };
      writeJson(res, 200, await requestBirdeyeOhlcv(requireString(body.address, 'address'), {
        type: body.type,
        timeFrom: body.timeFrom,
        timeTo: body.timeTo,
        currency: body.currency,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/trending') {
      const body = (await readJson(req)) as { limit?: number; offset?: number };
      writeJson(res, 200, await requestBirdeyeTrendingTokens({
        limit: body.limit,
        offset: body.offset,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/new-listings') {
      const body = (await readJson(req)) as { limit?: number; timeTo?: number; includeMeme?: boolean };
      writeJson(res, 200, await requestBirdeyeNewListings({
        limit: body.limit,
        timeTo: body.timeTo,
        includeMeme: body.includeMeme,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/token-list-v3') {
      const body = (await readJson(req)) as {
        limit?: number;
        offset?: number;
        sortBy?: BirdeyeTokenListSortBy;
        sortType?: 'asc' | 'desc';
        minLiquidity?: number;
        minVolume24hUsd?: number;
        includeMeme?: boolean;
      };
      writeJson(res, 200, await requestBirdeyeTokenListV3({
        limit: body.limit,
        offset: body.offset,
        sortBy: body.sortBy,
        sortType: body.sortType,
        minLiquidity: body.minLiquidity,
        minVolume24hUsd: body.minVolume24hUsd,
        includeMeme: body.includeMeme,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/birdeye/ws-snapshot') {
      const body = (await readJson(req)) as {
        start?: boolean;
        topics?: Array<'new_listings' | 'new_pairs' | 'large_trades'>;
        limit?: number;
        minVolumeUsd?: number;
        maxVolumeUsd?: number;
      };
      writeJson(res, 200, getBirdeyeWebSocketSnapshot({
        start: body.start,
        topics: body.topics,
        limit: body.limit,
        minVolumeUsd: body.minVolumeUsd,
        maxVolumeUsd: body.maxVolumeUsd,
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/coingecko/global') {
      writeJson(res, 200, await requestCoinGeckoGlobal());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/coingecko/endpoints') {
      writeJson(res, 200, listCoinGeckoEndpointCatalog());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/coingecko/read') {
      writeJson(res, 200, await requestCoinGeckoEndpoint((await readJson(req)) as {
        endpointId: string;
        pathParams?: Record<string, string | number>;
        query?: Record<string, string | number | boolean | undefined>;
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/coingecko/token-evidence') {
      writeJson(res, 200, await requestCoinGeckoSolanaTokenEvidence((await readJson(req)) as {
        mint?: string;
        mints?: string[];
        network?: string;
        includeOnchain?: boolean;
        maxTokenDetails?: number;
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/jupiter/endpoints') {
      writeJson(res, 200, requireActionService(actionService).marketEndpointCatalog({ provider: 'jupiter' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/jupiter/review-read') {
      writeJson(res, 200, await requireActionService(actionService).jupiterReviewRead((await readJson(req)) as {
        endpointId: string;
        pathParams?: Record<string, string | number>;
        query?: Record<string, string | number | boolean | undefined>;
        body?: Record<string, string | number | boolean | undefined>;
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/ai/status') {
      writeJson(res, 200, aiPlanner.status());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/ai/session-key') {
      const body = (await readJson(req)) as {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        provider?: string;
        apiFormat?: string;
        clear?: boolean;
        allowCustomBaseUrl?: boolean;
      };
      writeJson(res, 200, aiPlanner.setSessionKey(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/ai/generate-plan') {
      writeJson(res, 200, await aiPlanner.generatePlan((await readJson(req)) as AiPlanRequest));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/ai/review-plan') {
      writeJson(res, 200, await aiPlanner.reviewPlan(await bridgeReviewRequestWithWallet(backend, await readJson(req))));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/ai/ask-about-plan') {
      writeJson(res, 200, await aiPlanner.askAboutPlan(await bridgeAskRequestWithWallet(backend, await readJson(req))));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/ai/chat') {
      writeJson(res, 200, await aiPlanner.chat(await bridgeChatRequestWithOptionalWallet(backend, await readJson(req))));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/action/status') {
      writeJson(res, 200, await requireActionService(actionService).walletStatus());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/action/health') {
      writeJson(res, 200, await requireActionService(actionService).health());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/action/balances') {
      writeJson(res, 200, await requireActionService(actionService).balances());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/wallet-balance-summary') {
      const body = await readJson(req);
      const input = body && typeof body === 'object' && !Array.isArray(body) ? body as { mode?: unknown } : {};
      writeJson(res, 200, await requireActionService(actionService).walletBalanceSummary(input));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/action/portfolio') {
      writeJson(res, 200, await requireActionService(actionService).portfolioSummary());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/action/connector-capabilities') {
      const connectorId = url.searchParams.get('connectorId') ?? undefined;
      writeJson(res, 200, requireActionService(actionService).connectorCapabilities({
        ...(connectorId !== undefined && { connectorId }),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/connector-read-facts') {
      const body = (await readJson(req)) as {
        connectorId?: string;
        capability?: 'positions' | 'rewards' | 'markets' | 'blinks' | 'swap' | 'earn' | 'borrow' | 'withdraw' | 'repay' | 'add_liquidity' | 'close';
        connectorSecrets?: unknown;
        walletAddress?: string;
        token?: string;
        sourceMint?: string;
        reserveMint?: string;
        inputToken?: string;
        outputToken?: string;
        amount?: string;
        jitoOperation?: 'stake_sol' | 'deposit_stake_account' | 'unstake_jitosol' | 'withdraw_sol';
        solAmount?: string;
        jitoSolAmount?: string;
        stakeAccount?: string;
        receiptAddress?: string;
        withdrawMode?: 'stake_account' | 'reserve_sol';
        includeValidators?: boolean;
        includeStakeAccounts?: boolean;
        delegatedOnly?: boolean;
        eligibleForJitoDepositOnly?: boolean;
        claimableOnly?: boolean;
        slippageBps?: number;
        taker?: string;
        whirlpoolAddress?: string;
        positionMint?: string;
        poolAddress?: string;
        positionAddress?: string;
        poolId?: string;
        poolType?: string;
        bankAddress?: string;
        bankMint?: string;
        project0Account?: string;
        limit?: number;
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
      };
      const connectorSecrets = parseConnectorSecrets(body.connectorSecrets);
      try {
        writeJson(res, 200, await requireActionService(actionService).connectorReadFacts({
          connectorId: requireString(body.connectorId, 'connectorId'),
          ...(body.capability !== undefined && { capability: body.capability }),
          ...(connectorSecrets ? { connectorSecrets } : {}),
          ...(body.walletAddress !== undefined && { walletAddress: body.walletAddress }),
          ...(body.token !== undefined && { token: body.token }),
          ...(body.sourceMint !== undefined && { sourceMint: body.sourceMint }),
          ...(body.reserveMint !== undefined && { reserveMint: body.reserveMint }),
          ...(body.inputToken !== undefined && { inputToken: body.inputToken }),
          ...(body.outputToken !== undefined && { outputToken: body.outputToken }),
          ...(body.amount !== undefined && { amount: body.amount }),
          ...(body.jitoOperation !== undefined && { jitoOperation: body.jitoOperation }),
          ...(body.solAmount !== undefined && { solAmount: body.solAmount }),
          ...(body.jitoSolAmount !== undefined && { jitoSolAmount: body.jitoSolAmount }),
          ...(body.stakeAccount !== undefined && { stakeAccount: body.stakeAccount }),
          ...(body.receiptAddress !== undefined && { receiptAddress: body.receiptAddress }),
          ...(body.withdrawMode !== undefined && { withdrawMode: body.withdrawMode }),
          ...(body.includeValidators !== undefined && { includeValidators: body.includeValidators }),
          ...(body.includeStakeAccounts !== undefined && { includeStakeAccounts: body.includeStakeAccounts }),
          ...(body.delegatedOnly !== undefined && { delegatedOnly: body.delegatedOnly }),
          ...(body.eligibleForJitoDepositOnly !== undefined && { eligibleForJitoDepositOnly: body.eligibleForJitoDepositOnly }),
          ...(body.claimableOnly !== undefined && { claimableOnly: body.claimableOnly }),
          ...(body.slippageBps !== undefined && { slippageBps: body.slippageBps }),
          ...(body.taker !== undefined && { taker: body.taker }),
          ...(body.whirlpoolAddress !== undefined && { whirlpoolAddress: body.whirlpoolAddress }),
          ...(body.positionMint !== undefined && { positionMint: body.positionMint }),
          ...(body.poolAddress !== undefined && { poolAddress: body.poolAddress }),
          ...(body.positionAddress !== undefined && { positionAddress: body.positionAddress }),
          ...(body.poolId !== undefined && { poolId: body.poolId }),
          ...(body.poolType !== undefined && { poolType: body.poolType }),
          ...(body.bankAddress !== undefined && { bankAddress: body.bankAddress }),
          ...(body.bankMint !== undefined && { bankMint: body.bankMint }),
          ...(body.project0Account !== undefined && { project0Account: body.project0Account }),
          ...(body.limit !== undefined && { limit: body.limit }),
          ...(body.collectionId !== undefined && { collectionId: body.collectionId }),
          ...(body.collectionSymbol !== undefined && { collectionSymbol: body.collectionSymbol }),
          ...(body.mintAddress !== undefined && { mintAddress: body.mintAddress }),
          ...(body.assetId !== undefined && { assetId: body.assetId }),
          ...(body.includeListings !== undefined && { includeListings: body.includeListings }),
          ...(body.includeBids !== undefined && { includeBids: body.includeBids }),
          ...(body.includeCompressed !== undefined && { includeCompressed: body.includeCompressed }),
          ...(body.maxListings !== undefined && { maxListings: body.maxListings }),
          ...(body.maxBids !== undefined && { maxBids: body.maxBids }),
          ...(body.listedOnly !== undefined && { listedOnly: body.listedOnly }),
          ...(body.priceFeedId !== undefined && { priceFeedId: body.priceFeedId }),
          ...(body.priceFeedIds !== undefined && { priceFeedIds: body.priceFeedIds }),
          ...(body.symbol !== undefined && { symbol: body.symbol }),
          ...(body.query !== undefined && { query: body.query }),
          ...(body.assetType !== undefined && { assetType: body.assetType }),
          ...(body.maxAgeSeconds !== undefined && { maxAgeSeconds: body.maxAgeSeconds }),
          ...(body.maxConfidenceBps !== undefined && { maxConfidenceBps: body.maxConfidenceBps }),
          ...(body.consumerProtocol !== undefined && { consumerProtocol: body.consumerProtocol }),
          ...(body.includeEma !== undefined && { includeEma: body.includeEma }),
          ...(body.includeRawAccount !== undefined && { includeRawAccount: body.includeRawAccount }),
        }));
      } catch (err) {
        writePrepareTransactionError(res, err, connectorSecrets);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/market-data') {
      writeJson(res, 200, await requireActionService(actionService).solanaMarketData((await readJson(req)) as {
        mint?: string;
        mints?: string[];
        includePrice?: boolean;
        includeLiquidity?: boolean;
        includePriceVolume?: boolean;
        includeMetadata?: boolean;
        includeOhlcv?: boolean;
        priceVolumeType?: '1h' | '2h' | '4h' | '8h' | '24h';
        ohlcvType?: '1m' | '3m' | '5m' | '15m' | '30m' | '1H' | '2H' | '4H' | '6H' | '8H' | '12H' | '1D' | '1W';
        lookbackSeconds?: number;
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/token-lists') {
      writeJson(res, 200, await requireActionService(actionService).solanaTokenLists((await readJson(req)) as {
        list: 'trending' | 'new_listings' | 'token_list_v3' | 'ws_snapshot';
        limit?: number;
        offset?: number;
        includeMeme?: boolean;
        sortBy?: 'liquidity' | 'market_cap' | 'fdv' | 'v24hUSD' | 'v24hChangePercent' | 'price' | 'priceChange24h' | 'trade24h' | 'uniqueWallet24h' | 'last_trade_unix_time' | 'recent_listing_time';
        sortType?: 'asc' | 'desc';
        minLiquidity?: number;
        minVolume24hUsd?: number;
        timeTo?: number;
        startWebSocket?: boolean;
        wsTopics?: Array<'new_listings' | 'new_pairs' | 'large_trades'>;
        minVolumeUsd?: number;
        maxVolumeUsd?: number;
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/token-safety-evidence') {
      writeJson(res, 200, await requireActionService(actionService).solanaTokenSafetyEvidence((await readJson(req)) as {
        mint: string;
        minLiquidityUsd?: number;
        maxStalenessSec?: number | null;
        includeHolders?: boolean;
        includeHelius?: boolean;
        includeTimeline?: boolean;
        holderLimit?: number;
        top1MaxPct?: number;
        top5MaxPct?: number;
        top10MaxPct?: number;
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/helius-history') {
      writeJson(res, 200, await requireActionService(actionService).solanaHeliusHistory((await readJson(req)) as {
        operation: 'transaction_history' | 'parse_transactions' | 'recent_mint_txs' | 'transfers_by_address' | 'mint_creation' | 'has_history_before' | 'authority';
        address?: string;
        mint?: string;
        with?: string;
        direction?: 'in' | 'out' | 'any';
        solMode?: 'merged' | 'separate';
        filters?: {
          amount?: { gt?: number; gte?: number; lt?: number; lte?: number };
          blockTime?: { gt?: number; gte?: number; lt?: number; lte?: number };
          slot?: { gt?: number; gte?: number; lt?: number; lte?: number };
        };
        paginationToken?: string;
        sortOrder?: 'asc' | 'desc';
        signatures?: string[];
        before?: string;
        until?: string;
        commitment?: string;
        source?: string;
        type?: string;
        lookbackMinutes?: number;
        limit?: number;
        maxPages?: number;
        cutoffTs?: number;
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/prepare-transfer-sol') {
      const body = (await readJson(req)) as { recipient?: string; amountSol?: string; dueAt?: string; note?: string };
      writeJson(res, 200, await requireActionService(actionService).prepareTransferSol({
        recipient: requireString(body.recipient, 'recipient'),
        amountSol: requireString(body.amountSol, 'amountSol'),
        ...(body.dueAt !== undefined && { dueAt: body.dueAt }),
        ...(body.note !== undefined && { note: body.note }),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/prepare-transfer-spl') {
      const body = (await readJson(req)) as { token?: string; recipient?: string; amount?: string; dueAt?: string; note?: string };
      writeJson(res, 200, await requireActionService(actionService).prepareTransferSpl({
        token: requireString(body.token, 'token'),
        recipient: requireString(body.recipient, 'recipient'),
        amount: requireString(body.amount, 'amount'),
        ...(body.dueAt !== undefined && { dueAt: body.dueAt }),
        ...(body.note !== undefined && { note: body.note }),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/prepare-swap') {
      const body = (await readJson(req)) as { inputToken?: string; outputToken?: string; amount?: string; slippageBps?: number; dueAt?: string; note?: string };
      writeJson(res, 200, await requireActionService(actionService).prepareSwap({
        ...(body.inputToken !== undefined && { inputToken: body.inputToken }),
        ...(body.outputToken !== undefined && { outputToken: body.outputToken }),
        amount: requireString(body.amount, 'amount'),
        ...(body.slippageBps !== undefined && { slippageBps: body.slippageBps }),
        ...(body.dueAt !== undefined && { dueAt: body.dueAt }),
        ...(body.note !== undefined && { note: body.note }),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/prepare-blink') {
      const body = (await readJson(req)) as {
        connector?: unknown;
        protocol?: unknown;
        operation?: unknown;
        blinkUrl?: unknown;
        account?: unknown;
        parameters?: unknown;
        expectedAmount?: unknown;
        expectedToken?: unknown;
        expectedRecipient?: unknown;
        position?: unknown;
        dueAt?: unknown;
        note?: unknown;
      };
      writeJson(res, 200, await requireActionService(actionService).prepareBlinkAction({
        blinkUrl: requireString(body.blinkUrl, 'blinkUrl'),
        ...(body.connector !== undefined && { connector: requireString(body.connector, 'connector') }),
        ...(body.protocol !== undefined && { protocol: requireString(body.protocol, 'protocol') }),
        ...(body.operation !== undefined && { operation: requireString(body.operation, 'operation') }),
        ...(body.account !== undefined && { account: requireString(body.account, 'account') }),
        ...(body.parameters !== undefined && { parameters: requireStringRecord(body.parameters, 'parameters') }),
        ...(body.expectedAmount !== undefined && { expectedAmount: requireString(body.expectedAmount, 'expectedAmount') }),
        ...(body.expectedToken !== undefined && { expectedToken: requireString(body.expectedToken, 'expectedToken') }),
        ...(body.expectedRecipient !== undefined && { expectedRecipient: requireString(body.expectedRecipient, 'expectedRecipient') }),
        ...(body.position !== undefined && { position: requireString(body.position, 'position') }),
        ...(body.dueAt !== undefined && { dueAt: requireString(body.dueAt, 'dueAt') }),
        ...(body.note !== undefined && { note: requireString(body.note, 'note') }),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/transfer-sol') {
      const body = (await readJson(req)) as { recipient?: string; amountSol?: string };
      writeJson(res, 200, await requireActionService(actionService).transferSol({
        recipient: requireString(body.recipient, 'recipient'),
        amountSol: requireString(body.amountSol, 'amountSol'),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/transfer-spl') {
      const body = (await readJson(req)) as { token?: string; recipient?: string; amount?: string };
      writeJson(res, 200, await requireActionService(actionService).transferSpl({
        token: requireString(body.token, 'token'),
        recipient: requireString(body.recipient, 'recipient'),
        amount: requireString(body.amount, 'amount'),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/raydium-quote-add-liquidity') {
      const body = (await readJson(req)) as {
        poolId?: string;
        poolType?: string;
        positionMint?: string;
        amount?: string;
        amountSide?: string;
        tokenAAmount?: string;
        tokenBAmount?: string;
        maxTokenAAmount?: string;
        maxTokenBAmount?: string;
        lowerTick?: number;
        upperTick?: number;
        lowerPrice?: string;
        upperPrice?: string;
        rangePreset?: string;
        slippageBps?: number;
      };
      writeJson(res, 200, await requireActionService(actionService).quoteRaydiumAddLiquidity({
        poolId: requireString(body.poolId, 'poolId'),
        ...(body.poolType !== undefined && { poolType: body.poolType as 'cpmm' | 'clmm' }),
        ...(body.positionMint !== undefined && { positionMint: body.positionMint }),
        ...(body.amount !== undefined && { amount: body.amount }),
        ...(body.amountSide !== undefined && { amountSide: body.amountSide as 'tokenA' | 'tokenB' }),
        ...(body.tokenAAmount !== undefined && { tokenAAmount: body.tokenAAmount }),
        ...(body.tokenBAmount !== undefined && { tokenBAmount: body.tokenBAmount }),
        ...(body.maxTokenAAmount !== undefined && { maxTokenAAmount: body.maxTokenAAmount }),
        ...(body.maxTokenBAmount !== undefined && { maxTokenBAmount: body.maxTokenBAmount }),
        ...(body.lowerTick !== undefined && { lowerTick: body.lowerTick }),
        ...(body.upperTick !== undefined && { upperTick: body.upperTick }),
        ...(body.lowerPrice !== undefined && { lowerPrice: body.lowerPrice }),
        ...(body.upperPrice !== undefined && { upperPrice: body.upperPrice }),
        ...(body.rangePreset !== undefined && { rangePreset: body.rangePreset }),
        ...(body.slippageBps !== undefined && { slippageBps: body.slippageBps }),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/swap-quote') {
      const body = (await readJson(req)) as { inputToken?: string; outputToken?: string; amount?: string; slippageBps?: number };
      writeJson(res, 200, await requireActionService(actionService).getSwapQuote({
        ...(body.inputToken !== undefined && { inputToken: body.inputToken }),
        ...(body.outputToken !== undefined && { outputToken: body.outputToken }),
        amount: requireString(body.amount, 'amount'),
        ...(body.slippageBps !== undefined && { slippageBps: body.slippageBps }),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/swap-order') {
      const body = (await readJson(req)) as { inputToken?: string; outputToken?: string; amount?: string; slippageBps?: number; taker?: string };
      writeJson(res, 200, await requireActionService(actionService).getSwapOrder({
        ...(body.inputToken !== undefined && { inputToken: body.inputToken }),
        ...(body.outputToken !== undefined && { outputToken: body.outputToken }),
        amount: requireString(body.amount, 'amount'),
        ...(body.slippageBps !== undefined && { slippageBps: body.slippageBps }),
        ...(body.taker !== undefined && { taker: body.taker }),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/swap-execute') {
      const body = (await readJson(req)) as { signedTransaction?: string; requestId?: string; lastValidBlockHeight?: string | number };
      writeJson(res, 200, await requireActionService(actionService).executeSignedSwap({
        signedTransaction: requireString(body.signedTransaction, 'signedTransaction'),
        requestId: requireString(body.requestId, 'requestId'),
        ...(body.lastValidBlockHeight !== undefined && { lastValidBlockHeight: body.lastValidBlockHeight }),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/action/swap') {
      const body = (await readJson(req)) as { inputToken?: string; outputToken?: string; amount?: string; slippageBps?: number };
      writeJson(res, 200, await requireActionService(actionService).swap({
        ...(body.inputToken !== undefined && { inputToken: body.inputToken }),
        ...(body.outputToken !== undefined && { outputToken: body.outputToken }),
        amount: requireString(body.amount, 'amount'),
        ...(body.slippageBps !== undefined && { slippageBps: body.slippageBps }),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/prepared-actions/reject') {
      const body = (await readJson(req)) as { actionId?: string; reason?: string };
      if (!body.actionId) {
        throw new ProtocolError('invalid_request', 'Missing actionId.');
      }
      writeJson(res, 200, await requireActionService(actionService).rejectPreparedAction(body.actionId, body.reason));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/prepared-actions/execute') {
      const body = (await readJson(req)) as { actionId?: string };
      if (!body.actionId) {
        throw new ProtocolError('invalid_request', 'Missing actionId.');
      }
      writeJson(res, 200, await requireActionService(actionService).executePreparedAction(body.actionId));
      return;
    }
    if (req.method === 'POST') {
      const prepareTxMatch = url.pathname.match(
        /^\/bridge\/prepared-actions\/([^/]+)\/prepare-transaction$/,
      );
      if (prepareTxMatch) {
        const actionId = decodeURIComponent(prepareTxMatch[1]!);
        const service = requireActionService(actionService);
        try {
          const payload = await service.prepareTransactionForActionApproval(actionId);
          writeJson(res, 200, payload);
        } catch (err) {
          writePrepareTransactionError(res, err);
        }
        return;
      }
    }
    if (req.method === 'POST' && url.pathname === '/bridge/connector/prepare-action') {
      const body = (await readJson(req)) as {
        kind?: string;
        params?: unknown;
        walletAddress?: string;
        cluster?: string;
        summary?: string;
        connectorSecrets?: unknown;
      };
      const kind = requireString(body.kind, 'kind');
      const walletAddress = requireString(body.walletAddress, 'walletAddress');
      const cluster = requireString(body.cluster, 'cluster') as 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
      if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
        throw new ProtocolError('invalid_request', 'params must be an object.');
      }
      const service = requireActionService(actionService);
      const connectorSecrets = parseConnectorSecrets(body.connectorSecrets);
      try {
        const payload = await service.prepareConnectorAction({
          kind,
          params: body.params as Record<string, unknown>,
          walletAddress,
          cluster,
          ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
          ...(connectorSecrets ? { connectorSecrets } : {}),
        });
        writeJson(res, 200, payload);
      } catch (err) {
        writePrepareTransactionError(res, err, connectorSecrets);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/connector/prepare-transaction') {
      const body = (await readJson(req)) as {
        kind?: string;
        params?: unknown;
        walletAddress?: string;
        cluster?: string;
        summary?: string;
        connectorSecrets?: unknown;
      };
      const kind = requireString(body.kind, 'kind');
      const walletAddress = requireString(body.walletAddress, 'walletAddress');
      const cluster = requireString(body.cluster, 'cluster') as 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
      if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
        throw new ProtocolError('invalid_request', 'params must be an object.');
      }
      const service = requireActionService(actionService);
      const connectorSecrets = parseConnectorSecrets(body.connectorSecrets);
      try {
        const payload = await service.prepareConnectorTransactionStateless({
          kind,
          params: body.params as Record<string, unknown>,
          walletAddress,
          cluster,
          ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
          ...(connectorSecrets ? { connectorSecrets } : {}),
        });
        writeJson(res, 200, payload);
      } catch (err) {
        writePrepareTransactionError(res, err, connectorSecrets);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/prepared-actions/record-transaction') {
      const body = (await readJson(req)) as { actionId?: string; txid?: string; txids?: string[]; txStatus?: string; error?: string };
      if (!body.actionId) {
        throw new ProtocolError('invalid_request', 'Missing actionId.');
      }
      if (
        body.txStatus !== undefined &&
        body.txStatus !== 'pending' &&
        body.txStatus !== 'confirmed' &&
        body.txStatus !== 'failed'
      ) {
        throw new ProtocolError('invalid_request', 'txStatus must be pending, confirmed, or failed.');
      }
      writeJson(res, 200, await requireActionService(actionService).recordPreparedActionTransaction({
        actionId: body.actionId,
        ...(body.txid !== undefined && { txid: body.txid }),
        ...(Array.isArray(body.txids) && { txids: body.txids }),
        ...(body.txStatus !== undefined && { txStatus: body.txStatus }),
        ...(body.error !== undefined && { error: body.error }),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/submit') {
      const body = (await readJson(req)) as { request?: SigningRequest };
      if (!body.request) {
        throw new ProtocolError('invalid_request', 'Missing signing request.');
      }
      writeJson(res, 200, await backend.submit(body.request));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/connect-wallet') {
      if (!isIosBackend(backend)) {
        writeJson(res, 200, {
          requestId: 'already-connected',
          status: 'approved',
          result: { signature: await backend.getAddress() },
        });
        return;
      }
      writeJson(res, 200, await backend.connectWallet());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/poll') {
      const requestId = url.searchParams.get('requestId');
      if (!requestId) {
        throw new ProtocolError('invalid_request', 'Missing requestId.');
      }
      writeJson(res, 200, await backend.poll(requestId));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/cancel') {
      const body = (await readJson(req)) as { requestId?: string };
      if (!body.requestId) {
        throw new ProtocolError('invalid_request', 'Missing requestId.');
      }
      await backend.cancel(body.requestId);
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/connect') {
      if (!isLocalBridgeBackend(backend)) {
        throw new ProtocolError('unsupported_method', 'Browser bridge host connect is not available in iOS link mode.');
      }
      const body = (await readJson(req)) as { address?: string; capabilities?: AdapterCapabilities };
      if (!body.address || !body.capabilities) {
        throw new ProtocolError('invalid_request', 'Missing address or capabilities.');
      }
      backend.connectHost(body.address, body.capabilities);
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/disconnect') {
      if (!isLocalBridgeBackend(backend)) {
        throw new ProtocolError('unsupported_method', 'Browser bridge host disconnect is not available in iOS link mode.');
      }
      backend.disconnectHost();
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/trace') {
      const body = (await readJson(req)) as { event?: string; payload?: Record<string, unknown> };
      if (typeof body.event !== 'string' || !body.event) {
        throw new ProtocolError('invalid_request', 'Missing trace event.');
      }
      trace(body.event, body.payload ?? {});
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/next') {
      if (!isLocalBridgeBackend(backend)) {
        throw new ProtocolError('unsupported_method', 'Browser bridge request claiming is not available in iOS link mode.');
      }
      const requestId = url.searchParams.get('requestId')?.trim() || undefined;
      writeJson(res, 200, { request: backend.nextPendingRequest(requestId) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/resolve') {
      if (!isLocalBridgeBackend(backend)) {
        throw new ProtocolError('unsupported_method', 'Browser bridge request resolution is not available in iOS link mode.');
      }
      const body = (await readJson(req)) as { requestId?: string; signature?: string; txid?: string };
      if (!body.requestId || !body.signature) {
        throw new ProtocolError('invalid_request', 'Missing requestId or signature.');
      }
      writeJson(
        res,
        200,
        backend.resolveRequest(body.requestId, {
          signature: body.signature,
          ...(body.txid !== undefined && { txid: body.txid }),
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/reject') {
      if (!isLocalBridgeBackend(backend)) {
        throw new ProtocolError('unsupported_method', 'Browser bridge request rejection is not available in iOS link mode.');
      }
      const body = (await readJson(req)) as { requestId?: string; error?: ProtocolErrorPayload };
      if (!body.requestId || !body.error) {
        throw new ProtocolError('invalid_request', 'Missing requestId or error.');
      }
      writeJson(res, 200, backend.rejectRequest(body.requestId, body.error));
      return;
    }
    writeJson(res, 404, { error: 'not_found' });
  } catch (err) {
    const protocolErr =
      err instanceof ProtocolError
        ? err
        : new ProtocolError('wallet_unreachable', err instanceof Error ? err.message : 'Bridge error.');
    writeJson(res, 400, { error: protocolErr.toPayload() });
  }
}

function authorize(
  req: IncomingMessage,
  url: URL,
  backend: LocalBridgeBackend | IosLinkBackend,
  registry: AgentRegistry,
): RegisteredAgent | null {
  const headerToken = Array.isArray(req.headers['x-agent-wallet-token'])
    ? req.headers['x-agent-wallet-token'][0]
    : req.headers['x-agent-wallet-token'];
  const token = url.searchParams.get('token') ?? headerToken ?? '';
  if (!token) return null;
  const agent = registry.lookupByToken(token);
  if (agent) return agent;
  if (token === backend.token) {
    return registry.buildFallbackAgent();
  }
  return null;
}

function usesHostBridgeToken(req: IncomingMessage, url: URL, backend: LocalBridgeBackend | IosLinkBackend): boolean {
  return requestToken(req, url) === backend.token;
}

function requestToken(req: IncomingMessage, url: URL): string {
  const headerToken = headerValue(req.headers['x-agent-wallet-token']);
  return url.searchParams.get('token') ?? headerToken ?? '';
}

function requiresHostBridgeToken(method: string | undefined, pathname: string): boolean {
  if (method !== 'POST') return false;
  return pathname === '/bridge/connect' ||
    pathname === '/bridge/disconnect' ||
    pathname === '/bridge/resolve' ||
    pathname === '/bridge/reject';
}

function requiredTier(method: string, pathname: string): AgentTier | null {
  if (method === 'GET') {
    if (pathname.startsWith('/bridge/agents')) return 'full';
    return null;
  }
  if (method === 'POST') {
    if (pathname === '/bridge/agents') return 'full';
    if (pathname === '/bridge/agents/issue') return 'full';
    if (pathname === '/bridge/agents/delete') return 'full';
    if (pathname.startsWith('/bridge/action/prepare-')) return 'capped';
    if (pathname === '/bridge/recurring-payments') return 'capped';
    if (pathname === '/bridge/prepared-actions/reject') return 'capped';
    if (pathname === '/bridge/prepared-actions/archive') return 'capped';
    if (pathname === '/bridge/prepared-actions/delete') return 'capped';
    if (pathname === '/bridge/prepared-actions/record-transaction') return 'capped';
    if (
      pathname.startsWith('/bridge/prepared-actions/') &&
      pathname.endsWith('/prepare-transaction')
    ) {
      return 'capped';
    }
    if (pathname === '/bridge/connector/prepare-transaction') return 'capped';
    if (pathname === '/bridge/ai/generate-plan') return 'capped';
    if (pathname === '/bridge/ai/review-plan') return 'capped';
    if (pathname === '/bridge/ai/ask-about-plan') return 'capped';
    if (pathname === '/bridge/ai/chat') return 'capped';
    if (pathname === '/bridge/ai/session-key') return 'full';
    if (pathname === '/bridge/recurring-payments/update') return 'full';
    if (pathname === '/bridge/recurring-payments/pause') return 'full';
    if (pathname === '/bridge/recurring-payments/resume') return 'full';
    if (pathname === '/bridge/recurring-payments/delete') return 'full';
    if (pathname === '/bridge/prepared-actions/execute') return 'full';
    if (pathname === '/bridge/prepared-actions/tx-status') return 'full';
    if (pathname === '/bridge/action/transfer-sol') return 'full';
    if (pathname === '/bridge/action/transfer-spl') return 'full';
    if (pathname === '/bridge/action/swap') return 'full';
    if (pathname === '/bridge/action/swap-order') return 'capped';
    if (pathname === '/bridge/action/swap-execute') return 'full';
    if (pathname === '/bridge/action/swap-quote') return 'capped';
    if (pathname === '/bridge/action/connector-read-facts') return 'capped';
    if (pathname === '/bridge/action/market-data') return 'capped';
    if (pathname === '/bridge/action/token-lists') return 'capped';
    if (pathname === '/bridge/action/token-safety-evidence') return 'capped';
    if (pathname === '/bridge/action/helius-history') return 'capped';
    if (pathname.startsWith('/bridge/coingecko/')) return 'capped';
    if (pathname.startsWith('/bridge/jupiter/')) return 'capped';
    if (pathname === '/bridge/solana/latest-blockhash') return 'full';
    if (pathname === '/bridge/solana/send-transaction') return 'full';
    if (pathname === '/bridge/solana/signature-status') return null;
    if (pathname.startsWith('/bridge/birdeye/')) return 'capped';
    if (pathname === '/bridge/submit') return 'full';
    if (pathname === '/bridge/connect-wallet') return null;
    if (pathname === '/bridge/cancel') return 'capped';
    if (pathname === '/bridge/connect') return null;
    if (pathname === '/bridge/disconnect') return null;
    if (pathname === '/bridge/trace') return null;
    if (pathname === '/bridge/resolve') return null;
    if (pathname === '/bridge/reject') return null;
    if (pathname === '/bridge/lab-artifacts') return 'capped';
    if (pathname === '/bridge/lab-artifacts/delete') return 'capped';
    return 'full';
  }
  return null;
}

function requireActionService(actionService: AgentWalletActionService | undefined): AgentWalletActionService {
  if (!actionService) {
    throw new ProtocolError('unsupported_method', 'Bridge action service is not configured.');
  }
  return actionService;
}

const CONNECTOR_SECRET_IDS = new Set(['magiceden', 'tensor', 'sanctum', 'lulo', 'phoenix']);

function parseConnectorSecrets(value: unknown): ConnectorSecretsMap | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_request', 'connectorSecrets must be an object.');
  }
  const out: ConnectorSecretsMap = {};
  for (const [id, rawSecret] of Object.entries(value as Record<string, unknown>)) {
    if (!CONNECTOR_SECRET_IDS.has(id)) {
      throw new ProtocolError('invalid_request', `connectorSecrets contains unsupported connector "${id}".`);
    }
    if (!rawSecret || typeof rawSecret !== 'object' || Array.isArray(rawSecret)) {
      throw new ProtocolError('invalid_request', `connectorSecrets.${id} must be an object.`);
    }
    const secret = rawSecret as Record<string, unknown>;
    const apiKey = typeof secret.apiKey === 'string' ? secret.apiKey.trim() : '';
    if (!apiKey) {
      throw new ProtocolError('invalid_request', `connectorSecrets.${id}.apiKey is required.`);
    }
    if (apiKey.length > 1024) {
      throw new ProtocolError('invalid_request', `connectorSecrets.${id}.apiKey is too long.`);
    }
    const baseUrl = typeof secret.baseUrl === 'string' && secret.baseUrl.trim()
      ? secret.baseUrl.trim()
      : undefined;
    out[id as keyof ConnectorSecretsMap] = {
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function redactConnectorSecrets(message: string, connectorSecrets: ConnectorSecretsMap | undefined): string {
  if (!connectorSecrets) return message;
  let redacted = message;
  for (const secret of Object.values(connectorSecrets)) {
    const apiKey = secret?.apiKey;
    if (!apiKey) continue;
    redacted = redacted.split(apiKey).join('[REDACTED]');
  }
  return redacted;
}

function protocolPayloadWithMessage(err: ProtocolError, message: string): ProtocolErrorPayload {
  return {
    ...err.toPayload(),
    message,
  };
}

function writePrepareTransactionError(
  res: ServerResponse,
  err: unknown,
  connectorSecrets?: ConnectorSecretsMap,
): void {
  if (err instanceof AdapterError) {
    const message = redactConnectorSecrets(err.message, connectorSecrets);
    if (err.code === 'unknown_kind' || err.code === 'not_executable') {
      writeJson(res, 422, {
        error: { code: err.code, message, recoverable: false },
      });
      return;
    }
    writeJson(res, 502, {
      error: { code: err.code, message, recoverable: false },
    });
    return;
  }
  if (err instanceof ProtocolError) {
    const payload = protocolPayloadWithMessage(err, redactConnectorSecrets(err.message, connectorSecrets));
    if (err.code === 'invalid_request' && /Unknown prepared action/.test(err.message)) {
      writeJson(res, 404, { error: payload });
      return;
    }
    if (err.code === 'unauthorized') {
      writeJson(res, 404, { error: payload });
      return;
    }
    if (err.code === 'invalid_request' && /is already /.test(err.message)) {
      writeJson(res, 409, { error: payload });
      return;
    }
    writeJson(res, 400, { error: payload });
    return;
  }
  const wrapped = new ProtocolError(
    'wallet_unreachable',
    redactConnectorSecrets(err instanceof Error ? err.message : 'Bridge error.', connectorSecrets),
  );
  writeJson(res, 502, { error: wrapped.toPayload() });
}

function requireLabArtifactStore(labArtifacts: LabArtifactStore | undefined): LabArtifactStore {
  if (!labArtifacts) {
    throw new ProtocolError('unsupported_method', 'Bridge lab artifact archive is not configured.');
  }
  return labArtifacts;
}

function requireLabArtifact(value: unknown): LabArtifact {
  if (!value || typeof value !== 'object') {
    throw new ProtocolError('invalid_request', 'Missing lab artifact.');
  }
  const artifact = value as Partial<LabArtifact>;
  if (
    typeof artifact.id !== 'string' ||
    typeof artifact.labId !== 'string' ||
    typeof artifact.title !== 'string' ||
    typeof artifact.kind !== 'string' ||
    typeof artifact.createdAt !== 'string' ||
    typeof artifact.walletAddress !== 'string' ||
    typeof artifact.cluster !== 'string' ||
    typeof artifact.input !== 'string' ||
    typeof artifact.preSignatureHash !== 'string' ||
    typeof artifact.signingMessage !== 'string' ||
    typeof artifact.signature !== 'string' ||
    typeof artifact.verified !== 'boolean' ||
    typeof artifact.artifactHash !== 'string' ||
    !artifact.payload
  ) {
    throw new ProtocolError('invalid_request', 'Invalid lab artifact.');
  }
  return artifact as LabArtifact;
}

function filterLabArtifactsForWallet(artifacts: LabArtifact[], walletAddress: string): LabArtifact[] {
  return artifacts.filter((artifact) => sameWalletAddress(artifact.walletAddress, walletAddress));
}

function assertLabArtifactWalletOwner(artifact: LabArtifact, walletAddress: string): void {
  if (!sameWalletAddress(artifact.walletAddress, walletAddress)) {
    throw new ProtocolError('unauthorized', 'Lab artifact belongs to a different wallet.');
  }
}

function sameWalletAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

async function scopedBridgeWalletAddress(
  backend: WalletBackend,
  requestedWallet: unknown,
): Promise<string> {
  const walletAddress = await backend.getAddress();
  if (requestedWallet !== undefined && requestedWallet !== null && String(requestedWallet).trim()) {
    const requested = requireString(requestedWallet, 'walletAddress');
    if (!sameWalletAddress(requested, walletAddress)) {
      throw new ProtocolError('unauthorized', 'Requested wallet does not match the connected bridge wallet.');
    }
  }
  return walletAddress;
}

async function bridgeReviewRequestWithWallet(
  backend: WalletBackend,
  input: unknown,
): Promise<AiReviewRequest> {
  const request = requireJsonObject(input, 'AI review request') as unknown as AiReviewRequest;
  const walletAddress = await scopedBridgeWalletAddress(backend, request.walletAddress);
  return withTrustedAiWalletContext(request, walletAddress);
}

async function bridgeAskRequestWithWallet(
  backend: WalletBackend,
  input: unknown,
): Promise<AiAskRequest> {
  const request = requireJsonObject(input, 'AI ask request') as unknown as AiAskRequest;
  const walletAddress = await scopedBridgeWalletAddress(backend, request.walletAddress);
  return withTrustedAiWalletContext(request, walletAddress);
}

async function bridgeChatRequestWithOptionalWallet(
  backend: WalletBackend,
  input: unknown,
): Promise<AiChatRequest> {
  const request = requireJsonObject(input, 'AI chat request') as unknown as AiChatRequest;
  const requestedWallet = typeof request.walletAddress === 'string' && request.walletAddress.trim().length > 0;
  try {
    const walletAddress = await scopedBridgeWalletAddress(backend, request.walletAddress);
    return withTrustedAiWalletContext(request, walletAddress);
  } catch (err) {
    if (requestedWallet) throw err;
    return request;
  }
}

function withTrustedAiWalletContext<T extends { walletAddress?: string; context?: Record<string, unknown>; cluster?: string }>(
  request: T,
  walletAddress: string,
): T {
  return {
    ...request,
    walletAddress,
    context: {
      ...(request.context ?? {}),
      connectedWallet: walletAddress,
      wallet: {
        address: walletAddress,
        publicKey: walletAddress,
        source: 'connected_bridge_wallet',
        ...(request.cluster ? { cluster: request.cluster } : {}),
      },
    },
  };
}

function isLocalBridgeBackend(backend: WalletBackend): backend is LocalBridgeBackend {
  return backend instanceof LocalBridgeBackend;
}

function isIosBackend(backend: WalletBackend): backend is IosLinkBackend {
  return backend instanceof IosLinkBackend;
}

function requireActionConfig(config: AgentWalletConfig | undefined): AgentWalletConfig {
  if (!config) {
    throw new ProtocolError('unsupported_method', 'Bridge action config is not available.');
  }
  return config;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    totalBytes += buffer.length;
    if (totalBytes > MAX_BRIDGE_JSON_BYTES) {
      throw new ProtocolError('invalid_request', 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = headerValue(req.headers.origin);
  const allowedOrigin = allowedBridgeOrigin(origin);
  if (allowedOrigin) {
    res.setHeader('access-control-allow-origin', allowedOrigin);
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,x-agent-wallet-token');
  res.setHeader('access-control-allow-private-network', 'true');
  res.setHeader('vary', 'Origin, Access-Control-Request-Private-Network');
}

function allowedBridgeOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (isLoopbackHost(host)) return origin;
  if (process.env.BRIDGE_ALLOW_PRIVATE_ORIGINS === '1' && isLocalOrPrivateHost(host)) {
    return origin;
  }
  const allowed = bridgeAllowedOrigins();
  return allowed.has(origin) ? origin : undefined;
}

function bridgeAllowedOrigins(): Set<string> {
  const configured = (process.env.BRIDGE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return new Set([
    'https://agentic.local',
    'https://agentic-seeker.com',
    'https://www.agentic-seeker.com',
    'https://agentic-signer.com',
    'https://www.agentic-signer.com',
    'https://agenticwalletadapter.com',
    'https://www.agenticwalletadapter.com',
    ...configured,
  ]);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1';
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  if (isLoopbackHost(normalized) || normalized.endsWith('.local')) return true;
  const parts = normalized.split('.');
  if (parts.length === 4) {
    const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
    if (octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
      const [first, second] = octets as [number, number, number, number];
      return first === 10 ||
        first === 127 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 169 && second === 254);
    }
  }
  return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  const trimmed = header?.trim();
  return trimmed || undefined;
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function writeHtml(res: ServerResponse, body: string): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(body);
}

async function bridgeLatestBlockhash(
  config: AgentWalletConfig,
  cluster: string | undefined,
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  assertBridgeCluster(config, cluster);
  return new Connection(config.rpcUrl, 'confirmed').getLatestBlockhash('confirmed');
}

async function bridgeSendTransaction(
  config: AgentWalletConfig,
  cluster: string | undefined,
  signedTransaction: string | undefined,
): Promise<{ txid: string; signature: string }> {
  assertBridgeCluster(config, cluster);
  const encoded = requireString(signedTransaction, 'signedTransaction');
  const bytes = Buffer.from(encoded, 'base64');
  const sendOptions = { preflightCommitment: 'confirmed' as const, maxRetries: 5 };
  try {
    const txid = await new Connection(config.rpcUrl, 'confirmed').sendRawTransaction(bytes, sendOptions);
    return { txid, signature: txid };
  } catch (err) {
    if (!isRpcAuthRejectedError(err)) throw err;
    const fallbackUrl = defaultRpcUrl(config.cluster);
    if (fallbackUrl === config.rpcUrl) throw err;
    try {
      const txid = await new Connection(fallbackUrl, 'confirmed').sendRawTransaction(bytes, sendOptions);
      console.warn(
        `[bridge:send-fallback] Configured RPC refused sendTransaction (${rpcAuthErrorSummary(err)}). ` +
        `Sent via public RPC ${fallbackUrl}.`,
      );
      return { txid, signature: txid };
    } catch (fallbackErr) {
      // Public RPC also refused — propagate the original auth error so the
      // operator fixes the configured endpoint, not the public fallback.
      if (isRpcAuthRejectedError(fallbackErr)) throw err;
      throw fallbackErr;
    }
  }
}

function isRpcAuthRejectedError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (!message) return false;
  if (/\b(401|403|451)\b/.test(message)) return true;
  if (/"code"\s*:\s*(?:401|403|451)/.test(message)) return true;
  if (/access\s+(?:forbidden|denied)|^forbidden|\bforbidden\b/.test(message)) return true;
  return false;
}

function rpcAuthErrorSummary(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

async function bridgeSignatureStatus(
  config: AgentWalletConfig,
  cluster: string | undefined,
  signature: string | undefined,
): Promise<{ txStatus: PreparedActionTxStatus; found?: boolean; confirmationStatus?: string; error?: string }> {
  assertBridgeCluster(config, cluster);
  const txid = requireString(signature, 'txid');
  const status = (await new Connection(config.rpcUrl, 'confirmed').getSignatureStatuses([txid], {
    searchTransactionHistory: true,
  })).value[0];
  if (!status) return { txStatus: 'pending', found: false };
  if (status.err) {
    return { txStatus: 'failed', found: true, confirmationStatus: status.confirmationStatus ?? undefined, error: JSON.stringify(status.err) };
  }
  if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
    return { txStatus: 'confirmed', found: true, confirmationStatus: status.confirmationStatus };
  }
  return { txStatus: 'pending', found: true, confirmationStatus: status.confirmationStatus ?? undefined };
}

function assertBridgeCluster(config: AgentWalletConfig, cluster: string | undefined): void {
  if (cluster && cluster !== config.cluster) {
    throw new ProtocolError('cluster_mismatch', `Bridge is configured for ${config.cluster}; request targets ${cluster}.`);
  }
}

function bridgeOrigin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function bridgeHtml(token: string, bridgeUrl: string): string {
  const walletHostUrl = new URL('http://127.0.0.1:5174/');
  walletHostUrl.searchParams.set('bridgeUrl', bridgeUrl);
  walletHostUrl.searchParams.set('token', token);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Solana Agent Wallet Bridge</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #10231c; }
      code { background: #eef5f1; padding: 0.15rem 0.35rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Solana Agent Wallet Bridge</h1>
    <p>The local bridge API is running. Wallet connection happens in the browser wallet host, not on this API page.</p>
    <p>Open the wallet host:</p>
    <p><a href="${escapeHtml(walletHostUrl.toString())}">${escapeHtml(walletHostUrl.toString())}</a></p>
    <p>Bridge token:</p>
    <p><code>${token}</code></p>
    <p>Terminal flow: run <code>solana-agent-wallet connect</code> or <code>solana-agent-wallet app</code>.</p>
  </body>
</html>`;
}

async function iosApprovalHtml(backend: IosLinkBackend, requestId: string): Promise<string> {
  const approval = await backend.getWalletApprovalView(requestId);
  const walletUrl = approval.walletUrl;
  const isWalletConnect = Boolean(approval.walletConnectUri);
  const title = isWalletConnect ? `Scan with ${approval.wallet}` : 'Approve Solana Agent Request';
  const actionText = approval.kind === 'signing' && isWalletConnect
    ? `Open ${approval.wallet} on your phone to approve the request.`
    : `Request <code>${escapeHtml(requestId)}</code> is waiting for your ${escapeHtml(approval.wallet)} wallet.`;
  const qr = approval.qrDataUrl
    ? `<img src="${escapeHtml(approval.qrDataUrl)}" alt="WalletConnect QR code" />`
    : '';
  const wcUri = approval.walletConnectUri
    ? `<textarea readonly>${escapeHtml(approval.walletConnectUri)}</textarea>`
    : '';
  const openLink = isWalletConnect
    ? ''
    : `<a href="${escapeHtml(walletUrl)}">Open Wallet Approval</a>`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>iOS Wallet Approval</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #10231c; line-height: 1.5; }
      a { display: inline-block; margin-top: 1rem; background: #143d2b; color: #fff; padding: 0.8rem 1rem; border-radius: 8px; text-decoration: none; font-weight: 700; }
      code { background: #eef5f1; padding: 0.15rem 0.35rem; border-radius: 4px; }
      img { display: block; width: min(320px, 100%); height: auto; margin: 1rem 0; }
      textarea { width: min(760px, 100%); min-height: 7rem; box-sizing: border-box; font: 0.8rem ui-monospace, SFMono-Regular, Menlo, monospace; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <p>${actionText}</p>
    ${qr}
    ${wcUri}
    ${openLink}
  </body>
</html>`;
}

function iosCallbackHtml(status: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wallet Approval Returned</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #10231c; line-height: 1.5; }
    </style>
  </head>
  <body>
    <h1>Wallet response received</h1>
    <p>Status: <strong>${escapeHtml(status)}</strong></p>
    <p>You can return to your agent and continue polling the approval.</p>
  </body>
</html>`;
}

async function refreshPreparedActionTxStatuses(
  preparedActions: PreparedActionStore,
  config: AgentWalletConfig,
): Promise<Array<{ actionId: string; txid: string; txStatus: PreparedActionTxStatus }>> {
  const actions = await preparedActions.listActions();
  const pending = actions.filter((action) => txidsForAction(action).length > 0 && action.txStatus !== 'confirmed' && action.txStatus !== 'failed');
  if (pending.length === 0) return [];
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const updates: Array<{ actionId: string; txid: string; txStatus: PreparedActionTxStatus }> = [];
  for (const action of pending) {
    const txids = txidsForAction(action);
    const statuses = await connection.getSignatureStatuses(txids);
    const failedIndex = statuses.value.findIndex((status) => Boolean(status?.err));
    if (failedIndex >= 0) {
      const txid = txids[failedIndex]!;
      await preparedActions.updateAction(action.id, {
        txStatus: 'failed',
        txError: JSON.stringify(statuses.value[failedIndex]?.err),
      });
      updates.push({ actionId: action.id, txid, txStatus: 'failed' });
      continue;
    }
    const allConfirmed = statuses.value.length === txids.length &&
      statuses.value.every((status) => status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized');
    if (allConfirmed) {
      await preparedActions.updateAction(action.id, {
        txStatus: 'confirmed',
        confirmedAt: new Date().toISOString(),
        txError: undefined,
      });
      updates.push({ actionId: action.id, txid: txids[0]!, txStatus: 'confirmed' });
      continue;
    }
    if (action.txStatus !== 'pending') {
      await preparedActions.updateAction(action.id, { txStatus: 'pending' });
      updates.push({ actionId: action.id, txid: txids[0]!, txStatus: 'pending' });
    }
  }
  return updates;
}

function txidsForAction(action: PreparedAction): string[] {
  const txids = Array.isArray(action.txids)
    ? action.txids.filter((txid): txid is string => typeof txid === 'string' && txid.trim() !== '').map((txid) => txid.trim())
    : [];
  if (txids.length > 0) return [...new Set(txids)];
  return action.txid ? [action.txid] : [];
}

async function checkRpcWritable(rpcUrl: string): Promise<{ ok: boolean; message: string }> {
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

async function createRecurringPaymentFromBridge(
  body: {
    token?: string;
    recipient?: string;
    amount?: string;
    cadence?: 'weekly' | 'monthly' | 'interval_days' | 'interval_hours' | 'interval_minutes';
    dayOfWeek?: number;
    dayOfMonth?: number;
    intervalDays?: number;
    intervalHours?: number;
    intervalMinutes?: number;
    localTime?: string;
    startAt?: string;
    maxOccurrences?: number;
    note?: string;
  },
  backend: WalletBackend,
  config: AgentWalletConfig,
  preparedActions: PreparedActionStore,
) {
  const input = buildRecurringPaymentInput(body, await backend.getAddress(), config);
  return preparedActions.addRecurringPayment(input);
}

async function updateRecurringPaymentFromBridge(
  body: {
    recurringId?: string;
    token?: string;
    recipient?: string;
    amount?: string;
    cadence?: 'weekly' | 'monthly' | 'interval_days' | 'interval_hours' | 'interval_minutes';
    dayOfWeek?: number;
    dayOfMonth?: number;
    intervalDays?: number;
    intervalHours?: number;
    intervalMinutes?: number;
    localTime?: string;
    startAt?: string;
    maxOccurrences?: number;
    note?: string;
  },
  config: AgentWalletConfig,
  preparedActions: PreparedActionStore,
) {
  const current = (await preparedActions.listRecurringPayments()).find((payment) => payment.id === body.recurringId);
  if (!current || !body.recurringId) {
    throw new ProtocolError('invalid_request', `Unknown recurring payment: ${body.recurringId ?? ''}`);
  }
  const input = buildRecurringPaymentInput(body, current.walletAddress, config);
  return preparedActions.updateRecurringPayment(body.recurringId, input);
}

function buildRecurringPaymentInput(
  body: {
    token?: string;
    recipient?: string;
    amount?: string;
    cadence?: 'weekly' | 'monthly' | 'interval_days' | 'interval_hours' | 'interval_minutes';
    dayOfWeek?: number;
    dayOfMonth?: number;
    intervalDays?: number;
    intervalHours?: number;
    intervalMinutes?: number;
    localTime?: string;
    startAt?: string;
    maxOccurrences?: number;
    note?: string;
    actionKind?: 'transfer' | 'swap' | 'connector' | 'blink';
    connectorActionTemplate?: {
      connectorId: string;
      actionType: string;
      subActionId?: string;
      params: Record<string, string>;
      blinkUrl?: string;
    };
  },
  walletAddress: string,
  config: AgentWalletConfig,
): Omit<Awaited<ReturnType<PreparedActionStore['listRecurringPayments']>>[number], 'id' | 'status' | 'createdAt' | 'updatedAt' | 'occurrencesCreated'> {
  const actionKind: 'transfer' | 'swap' | 'connector' | 'blink' = body.actionKind ?? 'transfer';
  const isConnector = actionKind === 'connector' || actionKind === 'blink';
  if (isConnector) {
    const template = body.connectorActionTemplate;
    if (!template?.connectorId?.trim() || !template?.actionType?.trim()) {
      throw new ProtocolError(
        'invalid_request',
        `connectorActionTemplate.connectorId and actionType are required when actionKind is "${actionKind}".`,
      );
    }
    if (actionKind === 'blink' && !template.blinkUrl?.trim()) {
      throw new ProtocolError(
        'invalid_request',
        'connectorActionTemplate.blinkUrl is required when actionKind is "blink".',
      );
    }
  }
  const tokenSeed = body.token ?? (isConnector ? body.connectorActionTemplate?.params?.token ?? 'SOL' : undefined);
  const token = normalizeTokenIdentifier(requireString(tokenSeed, 'token'));
  const amountSeed = body.amount ?? (isConnector ? body.connectorActionTemplate?.params?.amount ?? '0' : undefined);
  const amount = requireString(amountSeed, 'amount');
  let recipient = '';
  if (actionKind === 'transfer') {
    recipient = new PublicKey(requireString(body.recipient, 'recipient')).toBase58();
  } else if (body.recipient) {
    try {
      recipient = new PublicKey(body.recipient).toBase58();
    } catch {
      recipient = '';
    }
  }
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : undefined;
  const localTime = typeof body.localTime === 'string' && body.localTime.trim() ? body.localTime.trim() : undefined;
  if (localTime !== undefined && !/^\d{2}:\d{2}$/.test(localTime)) {
    throw new ProtocolError('invalid_request', 'localTime must be HH:MM in 24-hour local time.');
  }
  const schedule = normalizeRecurringSchedule({
    cadence: body.cadence ?? 'weekly',
    dayOfWeek: body.dayOfWeek,
    dayOfMonth: body.dayOfMonth,
    intervalDays: body.intervalDays,
    intervalHours: body.intervalHours,
    intervalMinutes: body.intervalMinutes,
    localTime,
    startAt: body.startAt,
    maxOccurrences: body.maxOccurrences,
  });
  if (actionKind === 'transfer') {
    if (token === 'SOL') {
      parseDecimalAmount(amount, 9, 'SOL recurring payment amount');
    } else {
      parseDecimalAmount(amount, 9, `${tokenDisplayLabel(token)} recurring payment amount`);
    }
  }
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
  return {
    walletAddress,
    cluster: config.cluster,
    ...(actionKind !== 'transfer' ? { actionKind } : {}),
    ...(isConnector && body.connectorActionTemplate ? { connectorActionTemplate: body.connectorActionTemplate } : {}),
    token,
    recipient,
    amount,
    ...schedule,
    ...(note !== undefined && { note }),
  };
}

function normalizeRecurringSchedule(input: {
  cadence: 'weekly' | 'monthly' | 'interval_days' | 'interval_hours' | 'interval_minutes';
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
}): {
  cadence: 'weekly' | 'monthly' | 'interval_days' | 'interval_hours' | 'interval_minutes';
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

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `${label} is required.`);
  }
  return value.trim();
}

function requireJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_request', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireStringRecord(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_request', `${label} must be an object.`);
  }
  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new ProtocolError('invalid_request', `${label}.${key} must be a string.`);
    }
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new ProtocolError('invalid_request', `${label} must be an array.`);
  }
  const entries = value
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean);
  if (!entries.length) {
    throw new ProtocolError('invalid_request', `${label} must include at least one value.`);
  }
  return entries;
}

function optionalStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return requireStringArray(value, 'addresses');
}

function normalizeTokenIdentifier(token: string): string {
  const trimmed = token.trim();
  return looksLikeMintAddress(trimmed) ? trimmed : trimmed.toUpperCase();
}

function tokenDisplayLabel(token: string): string {
  const trimmed = token.trim();
  return looksLikeMintAddress(trimmed) ? `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}` : trimmed;
}

function looksLikeMintAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
