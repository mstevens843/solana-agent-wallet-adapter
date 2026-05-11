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
import {
  AgentRegistry,
  isAgentTier,
  publicizeAgent,
  tierMeetsMinimum,
  type AgentTier,
  type RegisteredAgent,
} from './agentRegistry.js';
import { BridgeAiPlanner, type AiPlanRequest, type AiReviewRequest, type AiAskRequest } from './aiPlanner.js';
import {
  birdeyeConfigFromEnv,
  requestBirdeyePriceMulti,
  requestBirdeyeSearch,
  requestBirdeyeTokenMetadata,
} from './birdeye.js';
import { type AgentWalletConfig } from './config.js';
import { parseDecimalAmount } from './amounts.js';
import { LocalBridgeBackend } from './localBridgeBackend.js';
import type { LabArtifact, LabArtifactStore } from './labArtifacts.js';
import type { PreparedActionStore, PreparedActionTxStatus } from './preparedActions.js';
import { trace } from './trace.js';

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
  const port = options.port ?? 8787;
  const backend = options.backend;
  const actionConfig = options.actionConfig;
  const preparedActions = options.preparedActions;
  const labArtifacts = options.labArtifacts;
  const actionService = actionConfig
    ? new AgentWalletActionService({
        backend,
        config: actionConfig,
        ...(preparedActions !== undefined && { preparedActions }),
      })
    : undefined;
  const aiPlanner = new BridgeAiPlanner();
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
      await new Promise<void>((resolve, reject) => {
        server = createServer((req, res) => {
          void handleRequest(req, res, backend, actionConfig, preparedActions, labArtifacts, actionService, aiPlanner, agentRegistry);
        });
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    },
  };
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
      };
      writeJson(res, 200, await requireActionService(actionService).createRecurringPayment(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/recurring-payments/update') {
      const body = (await readJson(req)) as {
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
      writeJson(res, 200, { artifacts: labArtifacts ? await labArtifacts.listArtifacts() : [] });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/lab-artifacts') {
      const body = (await readJson(req)) as { artifact?: unknown };
      const artifact = requireLabArtifact(body.artifact);
      writeJson(res, 200, { artifact: await requireLabArtifactStore(labArtifacts).upsertArtifact(artifact) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/lab-artifacts/delete') {
      const body = (await readJson(req)) as { artifactId?: string };
      if (!body.artifactId) {
        throw new ProtocolError('invalid_request', 'Missing artifactId.');
      }
      writeJson(res, 200, { deleted: await requireLabArtifactStore(labArtifacts).deleteArtifact(body.artifactId) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/health') {
      const caps = await backend.capabilities().catch(() => null);
      const rpcWritable = actionConfig
        ? await checkRpcWritable(actionConfig.rpcUrl)
        : { ok: false, message: 'Action config unavailable.' };
      const birdeye = birdeyeConfigFromEnv();
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
      const body = (await readJson(req)) as { addresses?: unknown; includeLiquidity?: boolean };
      writeJson(res, 200, await requestBirdeyePriceMulti(requireStringArray(body.addresses, 'addresses'), {
        includeLiquidity: body.includeLiquidity,
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
      };
      writeJson(res, 200, aiPlanner.setSessionKey(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/ai/generate-plan') {
      writeJson(res, 200, await aiPlanner.generatePlan((await readJson(req)) as AiPlanRequest));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/ai/review-plan') {
      writeJson(res, 200, await aiPlanner.reviewPlan((await readJson(req)) as AiReviewRequest));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/ai/ask-about-plan') {
      writeJson(res, 200, await aiPlanner.askAboutPlan((await readJson(req)) as AiAskRequest));
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
    if (req.method === 'GET' && url.pathname === '/bridge/action/portfolio') {
      writeJson(res, 200, await requireActionService(actionService).portfolioSummary());
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
      writeJson(res, 200, { request: backend.nextPendingRequest() });
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
    if (pathname === '/bridge/ai/generate-plan') return 'capped';
    if (pathname === '/bridge/ai/review-plan') return 'capped';
    if (pathname === '/bridge/ai/ask-about-plan') return 'capped';
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
    if (pathname === '/bridge/action/swap-quote') return 'capped';
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
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
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
  const allowed = bridgeAllowedOrigins();
  return allowed.has(origin) ? origin : undefined;
}

function bridgeAllowedOrigins(): Set<string> {
  const configured = (process.env.BRIDGE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return new Set([
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
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]';
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
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const txid = await connection.sendRawTransaction(Buffer.from(encoded, 'base64'), {
    preflightCommitment: 'confirmed',
    maxRetries: 5,
  });
  return { txid, signature: txid };
}

async function bridgeSignatureStatus(
  config: AgentWalletConfig,
  cluster: string | undefined,
  signature: string | undefined,
): Promise<{ txStatus: PreparedActionTxStatus; confirmationStatus?: string; error?: string }> {
  assertBridgeCluster(config, cluster);
  const txid = requireString(signature, 'txid');
  const status = (await new Connection(config.rpcUrl, 'confirmed').getSignatureStatuses([txid], {
    searchTransactionHistory: true,
  })).value[0];
  if (!status) return { txStatus: 'pending' };
  if (status.err) {
    return { txStatus: 'failed', confirmationStatus: status.confirmationStatus ?? undefined, error: JSON.stringify(status.err) };
  }
  if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
    return { txStatus: 'confirmed', confirmationStatus: status.confirmationStatus };
  }
  return { txStatus: 'pending', confirmationStatus: status.confirmationStatus ?? undefined };
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
  const pending = actions.filter((action) => action.txid && action.txStatus !== 'confirmed' && action.txStatus !== 'failed');
  if (pending.length === 0) return [];
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const statuses = await connection.getSignatureStatuses(pending.map((action) => action.txid!));
  const updates: Array<{ actionId: string; txid: string; txStatus: PreparedActionTxStatus }> = [];
  for (let index = 0; index < pending.length; index += 1) {
    const action = pending[index]!;
    const txid = action.txid!;
    const status = statuses.value[index];
    if (!status) {
      if (action.txStatus !== 'pending') {
        await preparedActions.updateAction(action.id, { txStatus: 'pending' });
        updates.push({ actionId: action.id, txid, txStatus: 'pending' });
      }
      continue;
    }
    if (status.err) {
      await preparedActions.updateAction(action.id, {
        txStatus: 'failed',
        txError: JSON.stringify(status.err),
      });
      updates.push({ actionId: action.id, txid, txStatus: 'failed' });
      continue;
    }
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      await preparedActions.updateAction(action.id, {
        txStatus: 'confirmed',
        confirmedAt: new Date().toISOString(),
        txError: undefined,
      });
      updates.push({ actionId: action.id, txid, txStatus: 'confirmed' });
      continue;
    }
    if (action.txStatus !== 'pending') {
      await preparedActions.updateAction(action.id, { txStatus: 'pending' });
      updates.push({ actionId: action.id, txid, txStatus: 'pending' });
    }
  }
  return updates;
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
  },
  walletAddress: string,
  config: AgentWalletConfig,
): Omit<Awaited<ReturnType<PreparedActionStore['listRecurringPayments']>>[number], 'id' | 'status' | 'createdAt' | 'updatedAt' | 'occurrencesCreated'> {
  const token = normalizeTokenIdentifier(requireString(body.token, 'token'));
  const amount = requireString(body.amount, 'amount');
  const recipient = new PublicKey(requireString(body.recipient, 'recipient')).toBase58();
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
  if (token === 'SOL') {
    parseDecimalAmount(amount, 9, 'SOL recurring payment amount');
  } else {
    parseDecimalAmount(amount, 9, `${tokenDisplayLabel(token)} recurring payment amount`);
  }
  return {
    walletAddress,
    cluster: config.cluster,
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
