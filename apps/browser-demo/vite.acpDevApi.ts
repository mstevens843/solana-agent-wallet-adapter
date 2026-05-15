import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  buildAgenticAgentCard,
  defaultAgenticCapabilities,
  validateAgentCard,
  type AgentCard,
} from '@solana-agent-wallet-adapter/a2a-agent-card';
import {
  buildAcpOutboundReceipt,
  cartToTransferParams,
  hashCart,
  validateAcpCart,
  type AcpCart,
} from '@solana-agent-wallet-adapter/acp-adapter';
import { LAUNCH_SKILLS } from '@solana-agent-wallet-adapter/launch-skills';
import {
  finalizationRequirementForAction,
  type ApprovalRequestRecord,
  type FinalizationSupport,
  type JsonObject,
  type WorkflowCluster,
} from '@solana-agent-wallet-adapter/workflow';
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';
import type { Plugin } from 'vite';

type SkillManifest = DevLayer1.skills.SkillManifest;
type SkillInstallRecord = DevLayer1.skills.SkillInstallRecord;
type SkillInstallStatus = DevLayer1.skills.SkillInstallStatus;

const PREVIEW_PATH = '/api/acp/cart/preview';
const APPROVE_PATH = '/api/acp/cart/approve';
const RECEIPT_PATH_RE = /^\/api\/acp\/cart\/([A-Za-z0-9_-]+)\/receipt$/;
const ACP_OUTBOUND_SOURCE = 'acp_outbound';
const SKILLS_PREFIX = '/api/skills';
const SKILLS_CATALOG_PATH = '/api/skills';
const SKILLS_MANIFESTS_PATH = '/api/skills/manifests';
const SKILLS_INSTALLS_PATH = '/api/skills/installs';
const SKILLS_AUTHOR_EARNINGS_RE = /^\/api\/skills\/authors\/([1-9A-HJ-NP-Za-km-z]{32,44})\/earnings$/;
const SKILLS_DETAIL_RE = /^\/api\/skills\/([a-z0-9][a-z0-9-]{0,63})$/;
const SKILLS_INSTALL_ACTION_RE = /^\/api\/skills\/installs\/([A-Za-z0-9_-]+)\/(pause|resume|uninstall)$/;
const AGGREGATOR_SKILL_RE = /^\/api\/aggregator\/skills\/([a-z0-9-]+)\/?$/;
const AGGREGATOR_WALLET_RE = /^\/api\/aggregator\/wallets\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/;
const AGENT_CARD_PREVIEW_PATH = '/api/agents/card';
const AGENT_CARD_PUBLIC_PATH = '/.well-known/agent.json';
const DEV_WALLET_HEADER = 'x-agentic-wallet-address';
const LOCAL_WALLET_FALLBACK = 'local-browser-wallet';
const LOCAL_AGENT_CARD_WALLET_FALLBACK = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const DEFAULT_AGENT_CARD_TOKENS = ['USDC', 'USDT', 'SOL'];
const MAX_JSON_BYTES = 64 * 1024;
const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const devApprovals = new Map<string, ApprovalRequestRecord>();
const localSkillCatalog = new Map<string, LocalSkillManifestRecord>();
const localSkillInstalls = new Map<string, SkillInstallRecord>();

interface LocalSkillManifestRecord {
  id: string;
  version: string;
  authorWallet: string;
  createdAt: string;
  updatedAt: string;
  manifest: SkillManifest;
}

interface LocalSkillInstallRow {
  install: SkillInstallRecord;
  manifest?: SkillManifest;
  recentExecutionCount: number;
  lastExecutionAt?: string;
  nextRunAt?: string;
  recurringScheduleStatus?: string;
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large.');
    this.name = 'BodyTooLargeError';
  }
}

class InvalidJsonError extends Error {
  constructor() {
    super('Request body must be valid JSON.');
    this.name = 'InvalidJsonError';
  }
}

export function acpDevApiPlugin(): Plugin {
  seedLocalSkillsCatalog();
  return {
    name: 'browser-demo-local-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        try {
          if (handleLocalAgentCardApi(req, res, url)) {
            return;
          }
          if (url.pathname.startsWith('/api/acp/cart/')) {
            if (req.method !== 'POST') {
              writeJson(res, 405, { error: 'method_not_allowed', message: 'Use POST for ACP cart routes.' });
              return;
            }
            if (url.pathname === PREVIEW_PATH) {
              await handlePreview(req, res);
              return;
            }
            if (url.pathname === APPROVE_PATH) {
              await handleApprove(req, res);
              return;
            }
            const receiptMatch = RECEIPT_PATH_RE.exec(url.pathname);
            if (receiptMatch?.[1]) {
              await handleReceipt(req, res, receiptMatch[1]);
              return;
            }
            next();
            return;
          }
          if (url.pathname.startsWith(SKILLS_PREFIX) || url.pathname.startsWith('/api/aggregator/')) {
            const handled = await handleLocalSkillsApi(req, res, url);
            if (!handled) next();
            return;
          }
          next();
        } catch (err) {
          writeLocalDevError(res, err);
        }
      });
    },
  };
}

function handleLocalAgentCardApi(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const isPreview = url.pathname === AGENT_CARD_PREVIEW_PATH;
  const isPublic = url.pathname === AGENT_CARD_PUBLIC_PATH;
  if (!isPreview && !isPublic) return false;

  const method = req.method ?? 'GET';
  if (isPublic && method === 'OPTIONS') {
    res.statusCode = 204;
    setAgentCardCorsHeaders(res);
    res.setHeader('access-control-max-age', '600');
    res.end();
    return true;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    writeJson(res, 405, {
      error: 'method_not_allowed',
      message: 'Use GET for the local Agent Card route.',
    });
    return true;
  }

  const card = buildLocalAgentCard(req, url);
  const validation = validateAgentCard(card);
  if (!validation.valid) {
    writeJson(res, 500, {
      error: 'agent_card_invalid',
      message: validation.errors.join('; '),
    });
    return true;
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', isPublic ? 'public, max-age=60' : 'no-store');
  if (isPublic) setAgentCardCorsHeaders(res);
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  res.end(JSON.stringify(card));
  return true;
}

function buildLocalAgentCard(req: IncomingMessage, url: URL): AgentCard {
  return buildAgenticAgentCard({
    walletAddress: resolveLocalAgentCardWallet(req),
    baseUrl: resolveRequestOrigin(req, url),
    supportedTokens: DEFAULT_AGENT_CARD_TOKENS,
    capabilities: defaultAgenticCapabilities,
    version: process.env.AGENTIC_BUILD_ID ?? '0.0.1-dev',
  });
}

function resolveLocalAgentCardWallet(req: IncomingMessage): string {
  const rawHeader = req.headers[DEV_WALLET_HEADER];
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const candidates = [
    typeof header === 'string' ? header.trim() : '',
    process.env.AGENTIC_AGENT_CARD_WALLET?.trim() ?? '',
    LOCAL_AGENT_CARD_WALLET_FALLBACK,
  ];
  return candidates.find((candidate) => BASE58_PUBKEY_RE.test(candidate)) ?? LOCAL_AGENT_CARD_WALLET_FALLBACK;
}

function resolveRequestOrigin(req: IncomingMessage, url: URL): string {
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = protoHeader === 'https' || (Array.isArray(protoHeader) && protoHeader.includes('https'))
    ? 'https'
    : 'http';
  const host = req.headers.host ?? url.host ?? '127.0.0.1:5174';
  return `${proto}://${host}`;
}

function setAgentCardCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  res.setHeader('vary', 'Origin');
}

async function handlePreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const requested = DevLayer1.acp.validateCreateAcpCartRequest(body);
  const cart = requested.cart;
  const validated = validateAcpCart(cart);
  const transfer = cartToTransferParams(validated, {
    ...(requested.dueAt !== undefined ? { dueAt: requested.dueAt } : {}),
    ...(requested.note !== undefined ? { note: requested.note } : {}),
  });

  writeJson(res, 200, {
    preview: {
      cart,
      transfer,
      totalFiat: validated.totalFiat,
      resolvedTokenMint: validated.resolvedTokenMint,
    },
  });
}

async function handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const walletAddress = walletAddressFromBody(body);
  if (!walletAddress) {
    writeJson(res, 403, {
      error: 'dev_wallet_missing',
      message: 'Connect a wallet before creating a local Pay Out approval.',
    });
    return;
  }

  const requested = DevLayer1.acp.validateCreateAcpCartRequest(body);
  const cart = requested.cart;
  const validated = validateAcpCart(cart);
  const transfer = cartToTransferParams(validated, {
    ...(requested.dueAt !== undefined ? { dueAt: requested.dueAt } : {}),
    ...(requested.note !== undefined ? { note: requested.note } : {}),
  });
  const cluster: WorkflowCluster = requested.cluster ?? cart.cluster;
  const cartJson = jsonObject(cart);
  const cartHash = hashCart(cart);
  const now = new Date().toISOString();
  const isSolPayment = cart.paymentToken === 'SOL';
  const approvalKind = isSolPayment ? 'transfer_sol' : 'transfer_spl';
  const finalizationRequirement = finalizationRequirementForAction(approvalKind);
  const finalizationSupport: FinalizationSupport = { required: true, supported: true };

  const params: JsonObject = isSolPayment
    ? {
        recipient: transfer.recipient,
        amountSol: transfer.amount,
        ...(cart.memo !== undefined ? { memo: cart.memo } : {}),
      }
    : {
        recipient: transfer.recipient,
        token: cart.paymentToken,
        amount: transfer.amount,
        tokenMint: validated.resolvedTokenMint,
        ...(cart.memo !== undefined ? { memo: cart.memo } : {}),
      };

  const approval: ApprovalRequestRecord = {
    id: `browser-acp_${randomUUID()}`,
    walletAddress,
    kind: approvalKind,
    status: 'ready',
    summary: `ACP: ${cart.merchant.name} — ${transfer.amount} ${cart.paymentToken}`,
    params,
    cluster,
    dueAt: cart.expiresAt ?? requested.dueAt ?? now,
    createdAt: now,
    updatedAt: now,
    amount: transfer.amount,
    token: cart.paymentToken,
    recipient: transfer.recipient,
    ...(requested.note !== undefined ? { note: requested.note } : {}),
    finalizationRequirement,
    executionMode: 'wallet_execute',
    finalizationSupport,
    metadata: {
      source: ACP_OUTBOUND_SOURCE,
      actionSource: ACP_OUTBOUND_SOURCE,
      acpCartId: cart.id,
      acpCartHash: cartHash,
      acpCart: cartJson,
      merchant: cartJson.merchant as JsonObject,
      totalAmount: cart.totalAmount,
      paymentAmount: transfer.amount,
      paymentToken: cart.paymentToken,
      resolvedTokenMint: validated.resolvedTokenMint,
      acpCluster: cart.cluster,
      totalFiat: validated.totalFiat,
      receivedAt: requested.receivedAt,
      devLocal: true,
    },
  };

  devApprovals.set(approval.id, approval);
  writeJson(res, 201, {
    approval,
    approvalId: approval.id,
    cartId: cart.id,
    cartHash,
    localOnly: true,
  });
}

async function handleReceipt(req: IncomingMessage, res: ServerResponse, approvalId: string): Promise<void> {
  const approval = devApprovals.get(approvalId);
  if (!approval) {
    writeJson(res, 404, {
      error: 'approval_not_found',
      message: `No local dev ACP approval found for id ${approvalId}.`,
    });
    return;
  }
  const cart = cartFromApproval(approval);
  if (!cart) {
    writeJson(res, 409, {
      error: 'not_an_acp_approval',
      message: 'This approval does not carry an ACP outbound cart.',
    });
    return;
  }

  const body = await readJsonBody(req);
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const txid = typeof record.txid === 'string' && record.txid.trim()
    ? record.txid.trim()
    : undefined;
  if (!txid) {
    writeJson(res, 400, { error: 'missing_txid', message: 'txid is required.' });
    return;
  }
  const settledAt = typeof record.settledAt === 'string' && !Number.isNaN(Date.parse(record.settledAt))
    ? record.settledAt
    : new Date().toISOString();
  const receipt = buildAcpOutboundReceipt({
    cart,
    txid,
    walletAddress: approval.walletAddress,
    settledAt,
  });

  writeJson(res, 201, {
    approvalId: approval.id,
    acp: receipt,
    receipt: {
      id: `browser-evidence-acp_${randomUUID()}`,
      walletAddress: approval.walletAddress,
      cluster: approval.cluster,
      kind: 'acp_outbound',
      status: 'approved',
      title: `ACP Outbound: ${cart.merchant.name}`,
      summary: `Paid ${cart.totalAmount} ${cart.currency} to ${cart.merchant.name} via ${cart.paymentToken}.`,
      payload: receipt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    localOnly: true,
  });
}

async function handleLocalSkillsApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'GET') {
    if (path === SKILLS_CATALOG_PATH) {
      handleListSkills(res, url);
      return true;
    }
    if (path === SKILLS_INSTALLS_PATH) {
      handleListSkillInstalls(req, res);
      return true;
    }
    const authorMatch = SKILLS_AUTHOR_EARNINGS_RE.exec(path);
    if (authorMatch?.[1]) {
      handleAuthorEarnings(res, authorMatch[1]);
      return true;
    }
    const skillStatsMatch = AGGREGATOR_SKILL_RE.exec(path);
    if (skillStatsMatch?.[1]) {
      handleSkillStats(res, skillStatsMatch[1]);
      return true;
    }
    const walletStatsMatch = AGGREGATOR_WALLET_RE.exec(path);
    if (walletStatsMatch?.[1]) {
      handleWalletStats(res, walletStatsMatch[1]);
      return true;
    }
    const detailMatch = SKILLS_DETAIL_RE.exec(path);
    if (detailMatch?.[1]) {
      handleSkillDetail(res, detailMatch[1]);
      return true;
    }
    return false;
  }

  if (method === 'POST') {
    if (path === SKILLS_MANIFESTS_PATH) {
      await handlePublishSkillManifest(req, res);
      return true;
    }
    if (path === SKILLS_INSTALLS_PATH) {
      await handleInstallSkill(req, res);
      return true;
    }
    const actionMatch = SKILLS_INSTALL_ACTION_RE.exec(path);
    if (actionMatch?.[1] && actionMatch[2]) {
      handleSkillInstallAction(res, actionMatch[1], actionMatch[2] as 'pause' | 'resume' | 'uninstall');
      return true;
    }
    return false;
  }

  if (path.startsWith(SKILLS_PREFIX) || path.startsWith('/api/aggregator/')) {
    writeJson(res, 405, { error: 'method_not_allowed', message: 'Use GET or POST for local Skills routes.' });
    return true;
  }
  return false;
}

function seedLocalSkillsCatalog(): void {
  if (localSkillCatalog.size > 0) return;
  const now = new Date().toISOString();
  for (const raw of LAUNCH_SKILLS) {
    const manifest = cloneJson(DevLayer1.skills.validateSkillManifest(raw));
    localSkillCatalog.set(manifest.id, {
      id: manifest.id,
      version: manifest.version,
      authorWallet: manifest.authorWallet,
      createdAt: now,
      updatedAt: now,
      manifest,
    });
  }
}

function handleListSkills(res: ServerResponse, url: URL): void {
  seedLocalSkillsCatalog();
  const author = url.searchParams.get('author')?.trim();
  const skills = [...localSkillCatalog.values()]
    .filter((record) => !author || record.authorWallet === author)
    .map((record) => cloneJson(record.manifest));
  writeJson(res, 200, { skills, localOnly: true });
}

function handleSkillDetail(res: ServerResponse, skillId: string): void {
  seedLocalSkillsCatalog();
  const record = localSkillCatalog.get(skillId);
  if (!record) {
    writeJson(res, 404, { error: 'skill_not_found', message: `No local skill found for ${skillId}.` });
    return;
  }
  writeJson(res, 200, {
    skill: cloneJson(record.manifest),
    stats: skillStatsSnapshot(skillId),
    localOnly: true,
  });
}

function handleListSkillInstalls(req: IncomingMessage, res: ServerResponse): void {
  seedLocalSkillsCatalog();
  const wallet = walletAddressFromRequest(req);
  const records = [...localSkillInstalls.values()]
    .filter((install) => install.walletAddress === wallet && install.status !== 'revoked');
  const installRows = records.map((install) => localInstallRow(install));
  writeJson(res, 200, {
    installs: records.map((install) => cloneJson(install)),
    installRows,
    localOnly: true,
  });
}

async function handlePublishSkillManifest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  seedLocalSkillsCatalog();
  const body = await readJsonBody(req);
  const manifest = cloneJson(DevLayer1.skills.validateSkillManifest(body));
  const now = new Date().toISOString();
  const existing = localSkillCatalog.get(manifest.id);
  const record: LocalSkillManifestRecord = {
    id: manifest.id,
    version: manifest.version,
    authorWallet: manifest.authorWallet,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    manifest,
  };
  localSkillCatalog.set(manifest.id, record);
  writeJson(res, existing ? 200 : 201, { manifest, record, localOnly: true });
}

async function handleInstallSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  seedLocalSkillsCatalog();
  const body = await readJsonBody(req);
  const wallet = walletAddressFromRequest(req);
  const installRequest = DevLayer1.skills.validateInstallSkillRequest(body);
  const record = localSkillCatalog.get(installRequest.skillId);
  if (!record) {
    writeJson(res, 404, {
      error: 'skill_not_found',
      message: `No local skill manifest found for id ${installRequest.skillId}.`,
    });
    return;
  }
  if (record.manifest.version !== installRequest.manifestVersion) {
    writeJson(res, 400, {
      error: 'manifest_version_mismatch',
      message: `Requested version ${installRequest.manifestVersion} does not match ${record.manifest.version}.`,
    });
    return;
  }
  if (record.manifest.monetization && !installRequest.acceptMonetization) {
    writeJson(res, 400, {
      error: 'monetization_required',
      message: 'Accept the skill monetization terms before install.',
    });
    return;
  }
  const existing = [...localSkillInstalls.values()].find(
    (install) =>
      install.walletAddress === wallet &&
      install.skillId === installRequest.skillId &&
      install.status !== 'revoked',
  );
  if (existing) {
    writeJson(res, 409, {
      error: 'already_installed',
      message: 'This skill is already installed locally. Uninstall it first to reinstall.',
    });
    return;
  }
  const now = new Date().toISOString();
  const install: SkillInstallRecord = {
    id: `browser-skill_${randomUUID()}`,
    walletAddress: wallet,
    skillId: record.manifest.id,
    manifestVersion: record.manifest.version,
    caps: cloneJson(installRequest.caps),
    installedAt: now,
    updatedAt: now,
    status: 'active',
    metadata: {
      localOnly: true,
      manifestSnapshot: cloneJson(record.manifest) as unknown as JsonObject,
      ...(installRequest.installParams ? { installParams: cloneJson(installRequest.installParams) } : {}),
    },
  };
  localSkillInstalls.set(install.id, install);
  writeJson(res, 201, {
    install: cloneJson(install),
    installId: install.id,
    localOnly: true,
  });
}

function handleSkillInstallAction(
  res: ServerResponse,
  installId: string,
  action: 'pause' | 'resume' | 'uninstall',
): void {
  const install = localSkillInstalls.get(installId);
  if (!install || install.status === 'revoked') {
    writeJson(res, 404, { error: 'install_not_found', message: `No local skill install found for ${installId}.` });
    return;
  }
  const nextStatus: SkillInstallStatus =
    action === 'pause' ? 'paused'
      : action === 'resume' ? 'active'
        : 'revoked';
  install.status = nextStatus;
  install.updatedAt = new Date().toISOString();
  localSkillInstalls.set(install.id, install);
  writeJson(res, 200, { install: cloneJson(install), localOnly: true });
}

function handleSkillStats(res: ServerResponse, skillId: string): void {
  seedLocalSkillsCatalog();
  if (!localSkillCatalog.has(skillId)) {
    writeJson(res, 404, { error: 'snapshot_not_found' });
    return;
  }
  const snapshot = skillStatsSnapshot(skillId);
  writeJson(res, 200, {
    snapshot,
    computedAt: snapshot.computedAt,
    kind: 'skill',
    key: `skill:${skillId}`,
    localOnly: true,
  });
}

function handleWalletStats(res: ServerResponse, walletAddress: string): void {
  const installs = [...localSkillInstalls.values()]
    .filter((install) => install.walletAddress === walletAddress && install.status !== 'revoked');
  const active = installs.filter((install) => install.status === 'active');
  const totalExecutions = active.length;
  const snapshot: DevLayer1.aggregator.WalletStatsSnapshot = {
    walletAddress,
    totalSkillsInstalled: installs.length,
    totalExecutions,
    successRate: totalExecutions > 0 ? 1 : 0,
    totalProfitUsd: totalExecutions > 0 ? '0.00' : undefined,
    totalGasUsd: totalExecutions > 0 ? '0.00' : undefined,
    installedSkillIds: installs.map((install) => install.skillId),
    computedAt: new Date().toISOString(),
  };
  writeJson(res, 200, {
    snapshot,
    computedAt: snapshot.computedAt,
    kind: 'wallet',
    key: `wallet:${walletAddress}`,
    localOnly: true,
  });
}

function handleAuthorEarnings(res: ServerResponse, authorWallet: string): void {
  const authoredSkillIds = [...localSkillCatalog.values()]
    .filter((record) => record.authorWallet === authorWallet)
    .map((record) => record.id);
  writeJson(res, 200, {
    authorWallet,
    currency: 'USDC',
    totalMonthlyUsdc: '0',
    skills: authoredSkillIds.map((skillId) => ({
      skillId,
      monthlyUsdc: '0',
      activeSubscriptions: activeInstallCount(skillId),
    })),
    localOnly: true,
  });
}

function localInstallRow(install: SkillInstallRecord): LocalSkillInstallRow {
  const record = localSkillCatalog.get(install.skillId);
  const row: LocalSkillInstallRow = {
    install: cloneJson(install),
    recentExecutionCount: install.status === 'active' ? 0 : 0,
    recurringScheduleStatus: 'local-only',
  };
  if (record) row.manifest = cloneJson(record.manifest);
  if (install.status === 'active') row.nextRunAt = nextRunAtForLocalInstall(install);
  return row;
}

function skillStatsSnapshot(skillId: string): DevLayer1.aggregator.SkillStatsSnapshot {
  const installs = activeInstallCount(skillId);
  const launchIndex = Math.max(0, [...localSkillCatalog.keys()].indexOf(skillId));
  const baseInstalls = 8 + launchIndex * 3;
  const totalInstalls = baseInstalls + installs;
  return {
    skillId,
    installs: totalInstalls,
    totalExecutions: totalInstalls * 4,
    successRate: 0.88 + Math.min(0.09, launchIndex * 0.015),
    computedAt: new Date().toISOString(),
  };
}

function activeInstallCount(skillId: string): number {
  return [...localSkillInstalls.values()]
    .filter((install) => install.skillId === skillId && install.status !== 'revoked')
    .length;
}

function nextRunAtForLocalInstall(install: SkillInstallRecord): string {
  const installed = Date.parse(install.installedAt);
  const base = Number.isFinite(installed) ? installed : Date.now();
  const next = Math.max(Date.now() + 60 * 60 * 1000, base + 24 * 60 * 60 * 1000);
  return new Date(next).toISOString();
}

function walletAddressFromRequest(req: IncomingMessage): string {
  const raw = req.headers[DEV_WALLET_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : LOCAL_WALLET_FALLBACK;
}

function walletAddressFromBody(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const walletAddress = (body as Record<string, unknown>).walletAddress;
  return typeof walletAddress === 'string' ? walletAddress.trim() : '';
}

function cartFromApproval(approval: ApprovalRequestRecord): AcpCart | null {
  const metadata = approval.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const cart = (metadata as Record<string, unknown>).acpCart;
  if (!cart || typeof cart !== 'object' || Array.isArray(cart)) return null;
  try {
    return DevLayer1.acp.validateCreateAcpCartRequest({ cart }).cart;
  } catch {
    return null;
  }
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError();
  }
}

function writeLocalDevError(res: ServerResponse, err: unknown): void {
  if (err instanceof BodyTooLargeError) {
    writeJson(res, 413, { error: 'body_too_large', message: err.message });
    return;
  }
  if (err instanceof InvalidJsonError) {
    writeJson(res, 400, { error: 'invalid_json', message: err.message });
    return;
  }
  if (err instanceof Error) {
    writeJson(res, 400, { error: err.name || 'invalid_local_dev_request', message: err.message });
    return;
  }
  writeJson(res, 500, { error: 'internal_error', message: 'Unexpected local dev route error.' });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}
