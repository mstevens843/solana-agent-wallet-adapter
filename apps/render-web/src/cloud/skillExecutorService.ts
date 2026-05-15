import { randomUUID } from 'node:crypto';

import type {
  BuildApprovalResult,
  JsonObject,
  JsonValue,
  PriceLookup,
  SkillExecutionRecord,
  SkillInstallRecord,
  SkillManifest,
} from '@solana-agent-wallet-adapter/skills-runtime';
import {
  addDecimalStrings,
  bindManifestParams,
  buildApprovalRequest,
  evaluateCaps,
  evaluateSchedule,
  normalizeSkillApprovalKind,
  SandboxError,
} from '@solana-agent-wallet-adapter/skills-runtime';
import type { ApprovalRequestRecord, AuditEventRecord, WorkflowCluster } from '@solana-agent-wallet-adapter/workflow';

import type {
  Clock,
  SkillExecutionStoreRecord,
  SkillInstallStoreRecord,
  SkillManifestStoreRecord,
  SkillsStore,
} from './store.js';
import { isSkillsStore } from './store.js';
import {
  createStatelessConnectorFactsReader,
  type ConnectorReadFactsRequest,
  type StatelessConnectorFactsReader,
} from './connectorFactsReader.js';
import type { EvidenceStore } from './evidenceService.js';
import { CONNECTOR_APPROVAL_ACTION_TYPES } from './prepareConnectorTransaction.js';
import { recordSkillExecutionOutcomeForApproval } from './skillExecutionLifecycle.js';
import {
  manifestSnapshotFromInstall,
  skillManifestHash,
  skillManifestHashForRecord,
} from './skillManifestIntegrity.js';
import type { WorkflowStore } from './workflowService.js';
import { WorkflowService } from './workflowService.js';

let warnedNoSkillsStore = false;

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface SkillsExecuteTickInput {
  store: WorkflowStore;
  clock: Clock;
  /**
   * Override the WorkflowService used to create approval requests. Tests inject
   * a fake; production builds one internally from the same store.
   */
  workflowService?: WorkflowService;
  /**
   * Override the stateless connector reader used by default Pyth and APY reads.
   * Production builds an adapter-backed read-only service for the install wallet.
   */
  connectorFactsReader?: StatelessConnectorFactsReader;
  /**
   * Override the Pyth lookup used by `'price-trigger'` schedules. When omitted,
   * the executor reads Pyth price facts through the shared connector reader.
   */
  priceLookup?: PriceLookup;
  /**
   * Optional resolver for the launch catalog's `yield.auto_rotate` sentinel.
   * When omitted, the executor reads supported USDC APY facts through connector
   * facts and resolves to the highest valid concrete deposit action.
   */
  yieldAutoRotateResolver?: YieldAutoRotateResolver;
}

export interface SkillsExecuteTickResult {
  evaluated: number;
  proposed: number;
  skipped: number;
}

export interface YieldAutoRotateCandidate {
  connectorAction: string;
  params: JsonObject;
  apyPercent?: number;
  label?: string;
  metadata?: JsonObject;
}

export type YieldAutoRotateResolver = (input: {
  install: SkillInstallRecord;
  manifest: SkillManifest;
  boundParams: JsonObject;
  cluster: WorkflowCluster;
  nowIso: string;
}) => Promise<readonly YieldAutoRotateCandidate[]>;

export async function runSkillsExecuteTick(
  input: SkillsExecuteTickInput,
): Promise<SkillsExecuteTickResult> {
  const { store, clock } = input;
  if (!isSkillsStore(store)) {
    if (!warnedNoSkillsStore) {
      console.warn(
        'skills-execute: configured store does not implement SkillsStore; tick is a no-op.',
      );
      warnedNoSkillsStore = true;
    }
    return { evaluated: 0, proposed: 0, skipped: 0 };
  }

  const skillsStore = store as unknown as SkillsStore;
  const evidenceStore = hasEvidenceStore(store) ? store : undefined;
  const workflowService = input.workflowService ?? new WorkflowService(store);
  const connectorFactsReader = input.connectorFactsReader ?? createStatelessConnectorFactsReader();
  const yieldAutoRotateResolver: YieldAutoRotateResolver = input.yieldAutoRotateResolver
    ?? ((resolverInput) => defaultYieldAutoRotateResolver({
      ...resolverInput,
      connectorFactsReader,
    }));
  const now = clock.now();
  const nowIso = now.toISOString();

  const installs = await skillsStore.listActiveSkillInstalls();
  let evaluated = 0;
  let proposed = 0;
  let skipped = 0;

  const manifestCache = new Map<string, SkillManifestStoreRecord | undefined>();

  for (const installStoreRecord of installs) {
    evaluated += 1;
    try {
      const install = installStoreRecord.install as SkillInstallRecord;
      const manifestResolution = await resolveManifestForInstall(skillsStore, manifestCache, install);
      if ('error' in manifestResolution) {
        skipped += 1;
        await writeAudit(store, install.walletAddress, 'skill.execution.skipped', {
          installId: install.id,
          skillId: install.skillId,
          manifestVersion: install.manifestVersion,
          ...(manifestResolution.manifestHash ? { manifestHash: manifestResolution.manifestHash } : {}),
          ...(manifestResolution.details ? manifestResolution.details : {}),
          capsSnapshot: install.caps as unknown as JsonObject,
          reason: manifestResolution.error,
        });
        continue;
      }
      const {
        manifest,
        manifestHash,
        manifestSource,
      } = manifestResolution;
      const manifestAudit = {
        manifestVersion: manifest.version,
        manifestHash,
        manifestSource,
        capsSnapshot: install.caps as unknown as JsonObject,
      };

      let executionsForInstall = await skillsStore.listSkillExecutionsByInstall(install.id);
      const reconciled = await reconcilePendingExecutions({
        store,
        skillsStore,
        evidenceStore,
        clock,
        walletAddress: install.walletAddress,
        executions: executionsForInstall,
      });
      if (reconciled > 0) {
        executionsForInstall = await skillsStore.listSkillExecutionsByInstall(install.id);
      }
      const recordedExecutions = executionsForInstall
        .slice()
        .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
      const lastExecutionAtIso = recordedExecutions.at(-1)?.proposedAt;
      const executionCount = recordedExecutions.filter((e) => e.result !== 'rejected' && e.result !== 'failed').length;
      const totalExecutedAmount = recordedExecutions.reduce((sum, entry) => {
        const exec = (entry.execution ?? null) as SkillExecutionRecord | null;
        const raw = exec?.metadata?.['executedAmount'];
        const amountStr = typeof raw === 'string' ? raw : undefined;
        if (!amountStr) return sum;
        try {
          return addDecimalStrings(sum, amountStr);
        } catch {
          return sum;
        }
      }, '0');

      const cluster = resolveCluster(manifest);
      const priceLookup = input.priceLookup
        ?? ((feedSymbol, lookupCluster) => defaultPythPriceLookup(
          feedSymbol,
          lookupCluster,
          install.walletAddress,
          connectorFactsReader,
        ));

      const scheduleDecision = await evaluateSchedule({
        install,
        manifest,
        lastExecutionAtIso,
        executionCount,
        now,
        cluster,
        priceLookup,
      });
      if (!scheduleDecision.due) {
        skipped += 1;
        await writeAudit(store, install.walletAddress, 'skill.execution.skipped', {
          installId: install.id,
          skillId: install.skillId,
          ...manifestAudit,
          reason: scheduleDecision.reason,
          stage: 'schedule',
        });
        continue;
      }

      let boundParams;
      try {
        boundParams = bindManifestParams({ install, manifest, executionCount, nowIso }).params;
      } catch (err) {
        skipped += 1;
        const code = err instanceof SandboxError ? err.code : 'sandbox-error';
        await writeAudit(store, install.walletAddress, 'skill.execution.failed', {
          installId: install.id,
          skillId: install.skillId,
          ...manifestAudit,
          reason: code,
          stage: 'sandbox',
        });
        continue;
      }

      const capDecision = evaluateCaps({
        install,
        manifest,
        executionCount,
        totalExecutedAmount,
        now,
        params: boundParams,
      });
      if (!capDecision.allowed) {
        skipped += 1;
        await writeAudit(store, install.walletAddress, 'skill.execution.skipped', {
          installId: install.id,
          skillId: install.skillId,
          ...manifestAudit,
          reason: capDecision.reason,
          stage: 'caps',
        });
        continue;
      }

      const builtApprovalReq = buildApprovalRequest({
        install,
        manifest,
        boundParams,
        cluster,
        nowIso,
      });
      const approvalReq: BuildApprovalResult = {
        ...builtApprovalReq,
        metadata: {
          ...builtApprovalReq.metadata,
          manifestVersion: manifest.version,
          manifestHash,
          manifestSource,
          capsSnapshot: install.caps as unknown as JsonObject,
        },
      };

      const resolvedApproval = await resolveApprovalRequest({
        approvalReq,
        install,
        manifest,
        boundParams,
        cluster,
        nowIso,
        resolver: yieldAutoRotateResolver,
      });
      if (!resolvedApproval) {
        skipped += 1;
        await writeAudit(store, install.walletAddress, 'skill.execution.skipped', {
          installId: install.id,
          skillId: install.skillId,
          ...manifestAudit,
          reason: 'yield-auto-rotate-no-candidates',
          stage: 'resolver',
        });
        continue;
      }
      if (!isSupportedSkillApprovalKind(resolvedApproval.kind)) {
        skipped += 1;
        await saveFailedExecution(skillsStore, install, manifest, nowIso, {
          reason: `unsupported-approval-kind:${resolvedApproval.kind}`,
          stage: 'approval-kind',
          connectorAction: resolvedApproval.kind,
          manifestHash,
          capsSnapshot: install.caps as unknown as JsonObject,
        });
        await writeAudit(store, install.walletAddress, 'skill.execution.failed', {
          installId: install.id,
          skillId: install.skillId,
          ...manifestAudit,
          reason: 'unsupported-approval-kind',
          unsupportedKind: resolvedApproval.kind,
          stage: 'approval-kind',
        });
        continue;
      }

      const approval = await workflowService.createApproval(
        { walletAddress: install.walletAddress },
        {
          kind: resolvedApproval.kind,
          summary: resolvedApproval.summary,
          params: resolvedApproval.params,
          cluster: resolvedApproval.cluster,
          metadata: resolvedApproval.metadata,
        },
      );

      const executionId = `skill-exec-${randomUUID()}`;
      const executionRecord: SkillExecutionRecord = {
        id: executionId,
        installId: install.id,
        walletAddress: install.walletAddress,
        skillId: install.skillId,
        proposedAt: nowIso,
        approvalRequestId: approval.id,
        result: 'pending',
        metadata: {
          connectorAction: resolvedApproval.kind,
          ...(typeof resolvedApproval.metadata.skillConnectorAction === 'string'
            ? { originalConnectorAction: resolvedApproval.metadata.skillConnectorAction }
            : {}),
          manifestVersion: manifest.version,
          manifestHash,
          manifestSource,
          capsSnapshot: install.caps as unknown as JsonObject,
        },
      };
      const executionStoreRecord: SkillExecutionStoreRecord = {
        id: executionId,
        installId: install.id,
        walletAddress: install.walletAddress,
        skillId: install.skillId,
        proposedAt: nowIso,
        result: 'pending',
        approvalRequestId: approval.id,
        execution: executionRecord,
      };
      await skillsStore.saveSkillExecution(executionStoreRecord);

      await writeAudit(store, install.walletAddress, 'skill.execution.proposed', {
        installId: install.id,
        skillId: install.skillId,
        ...manifestAudit,
        approvalRequestId: approval.id,
        connectorAction: resolvedApproval.kind,
      });
      proposed += 1;
    } catch (err) {
      skipped += 1;
      const installRecord = installStoreRecord.install as SkillInstallRecord | undefined;
      const walletAddress = installRecord?.walletAddress ?? installStoreRecord.walletAddress;
      if (installRecord) {
        await saveFailedExecution(skillsStore, installRecord, undefined, nowIso, {
          reason: err instanceof Error ? err.message.slice(0, 240) : 'unknown-error',
          stage: 'tick',
          capsSnapshot: installRecord.caps as unknown as JsonObject,
        });
      }
      await writeAudit(store, walletAddress, 'skill.execution.failed', {
        installId: installStoreRecord.id,
        skillId: installStoreRecord.skillId,
        reason: err instanceof Error ? err.message.slice(0, 240) : 'unknown-error',
        stage: 'tick',
        ...(installRecord ? { capsSnapshot: installRecord.caps as unknown as JsonObject } : {}),
      });
    }
  }

  return { evaluated, proposed, skipped };
}

async function reconcilePendingExecutions(input: {
  store: WorkflowStore;
  skillsStore: SkillsStore;
  evidenceStore: EvidenceStore | undefined;
  clock: Clock;
  walletAddress: string;
  executions: SkillExecutionStoreRecord[];
}): Promise<number> {
  let reconciled = 0;
  for (const execution of input.executions) {
    if (execution.result !== 'pending' || !execution.approvalRequestId) continue;
    const approval = await input.store.getApproval(input.walletAddress, execution.approvalRequestId);
    if (!approval) continue;
    const terminalResult = skillExecutionResultForApproval(approval);
    if (!terminalResult) continue;
    if (input.evidenceStore) {
      await recordSkillExecutionOutcomeForApproval({
        store: input.store,
        evidenceStore: input.evidenceStore,
        clock: input.clock,
        session: { walletAddress: input.walletAddress },
        approval,
      });
    } else {
      const nowIso = input.clock.now().toISOString();
      const currentPayload = isJsonObject(execution.execution) ? execution.execution : {};
      await input.skillsStore.saveSkillExecution({
        ...execution,
        result: terminalResult,
        execution: {
          ...currentPayload,
          result: terminalResult,
          ...(terminalResult === 'success' ? { approvedAt: approval.decidedAt ?? approval.confirmedAt ?? nowIso } : {}),
          ...(terminalResult === 'rejected' ? { rejectedAt: approval.decidedAt ?? nowIso } : {}),
          ...(approval.txid ? { txid: approval.txid } : {}),
        },
      });
    }
    reconciled += 1;
  }
  return reconciled;
}

function skillExecutionResultForApproval(
  approval: ApprovalRequestRecord,
): NonNullable<SkillExecutionStoreRecord['result']> | undefined {
  if (approval.status === 'approved') return 'success';
  if (approval.status === 'rejected' || approval.status === 'cancelled') return 'rejected';
  if (approval.status === 'failed' || approval.status === 'blocked' || approval.status === 'expired') return 'failed';
  return undefined;
}

async function resolveApprovalRequest(input: {
  approvalReq: BuildApprovalResult;
  install: SkillInstallRecord;
  manifest: SkillManifest;
  boundParams: JsonObject;
  cluster: WorkflowCluster;
  nowIso: string;
  resolver: YieldAutoRotateResolver | undefined;
}): Promise<BuildApprovalResult | undefined> {
  if (input.approvalReq.kind !== 'yield.auto_rotate') {
    return input.approvalReq;
  }
  if (!input.resolver) return undefined;
  const candidates = await input.resolver({
    install: input.install,
    manifest: input.manifest,
    boundParams: input.boundParams,
    cluster: input.cluster,
    nowIso: input.nowIso,
  });
  const best = [...candidates]
    .filter((candidate) => (
      typeof candidate.connectorAction === 'string'
      && candidate.connectorAction.length > 0
      && !candidate.connectorAction.includes('.')
    ))
    .sort((a, b) => (b.apyPercent ?? Number.NEGATIVE_INFINITY) - (a.apyPercent ?? Number.NEGATIVE_INFINITY))[0];
  if (!best) return undefined;
  return {
    ...input.approvalReq,
    kind: normalizeSkillApprovalKind(best.connectorAction),
    params: best.params,
    metadata: {
      ...input.approvalReq.metadata,
      yieldAutoRotate: {
        resolvedConnectorAction: best.connectorAction,
        ...(best.label ? { label: best.label } : {}),
        ...(typeof best.apyPercent === 'number' ? { apyPercent: best.apyPercent } : {}),
        ...(best.metadata ? { metadata: best.metadata } : {}),
      },
    },
  };
}

async function defaultPythPriceLookup(
  feedSymbol: string,
  cluster: WorkflowCluster,
  walletAddress: string,
  connectorFactsReader: StatelessConnectorFactsReader,
): Promise<number> {
  if (cluster !== 'mainnet-beta') {
    throw new Error(`Pyth price lookup is only available on mainnet-beta; received ${cluster}.`);
  }
  const feed = feedSymbol.trim();
  const result = await connectorFactsReader({
    connectorId: 'pyth',
    capability: 'markets',
    cluster,
    walletAddress,
    ...(isPythFeedId(feed) ? { priceFeedId: feed } : { symbol: feed }),
    maxAgeSeconds: 300,
    includeEma: true,
  });
  const snapshot = isJsonObject(result.snapshot)
    ? result.snapshot
    : isJsonObject(result.evidence)
      ? result.evidence
      : undefined;
  if (!snapshot) {
    throw new Error(`Pyth price for ${feed} did not include a snapshot.`);
  }
  const status = typeof snapshot.status === 'string' ? snapshot.status : undefined;
  if (status && status !== 'fresh') {
    throw new Error(`Pyth price for ${feed} is ${status}.`);
  }
  const price = parseNumberLike(snapshot.priceUi ?? snapshot.price ?? snapshot.priceUsd);
  if (price === undefined || !Number.isFinite(price)) {
    throw new Error(`Pyth price for ${feed} is not finite.`);
  }
  return price;
}

interface DefaultYieldAutoRotateResolverInput {
  install: SkillInstallRecord;
  boundParams: JsonObject;
  cluster: WorkflowCluster;
  connectorFactsReader: StatelessConnectorFactsReader;
}

interface YieldFactProvider {
  provider: string;
  label: string;
  connectorAction: string;
  readInput: Omit<ConnectorReadFactsRequest, 'cluster' | 'walletAddress'>;
  params: (amount: string) => JsonObject;
  requiredDepositType?: string;
}

interface YieldObservation {
  apyPercent: number;
  liquidity?: number;
  sourceLabel?: string;
}

const YIELD_FACT_PROVIDERS: readonly YieldFactProvider[] = [
  {
    provider: 'lulo',
    label: 'Lulo Protected USDC',
    connectorAction: 'prepare_lulo_deposit',
    readInput: {
      connectorId: 'lulo',
      capability: 'markets',
      reserveMint: USDC_MINT,
    },
    params: (amount) => ({
      mintAddress: USDC_MINT,
      amount,
      depositType: 'protected',
    }),
    requiredDepositType: 'protected',
  },
  {
    provider: 'kamino',
    label: 'Kamino USDC',
    connectorAction: 'prepare_kamino_deposit',
    readInput: {
      connectorId: 'kamino',
      capability: 'markets',
      token: 'USDC',
      reserveMint: USDC_MINT,
    },
    params: (amount) => ({
      token: 'USDC',
      reserveMint: USDC_MINT,
      amount,
    }),
  },
  {
    provider: 'save',
    label: 'Save USDC',
    connectorAction: 'prepare_save_deposit',
    readInput: {
      connectorId: 'save',
      capability: 'markets',
      token: 'USDC',
      reserveMint: USDC_MINT,
    },
    params: (amount) => ({
      token: 'USDC',
      reserveMint: USDC_MINT,
      amount,
      depositCollateral: true,
    }),
  },
  {
    provider: 'jupiter',
    label: 'Jupiter Earn USDC',
    connectorAction: 'prepare_jupiter_lend_earn_deposit',
    readInput: {
      connectorId: 'jupiter',
      capability: 'earn',
      reserveMint: USDC_MINT,
    },
    params: (amount) => ({
      assetMint: USDC_MINT,
      amount,
    }),
  },
];

async function defaultYieldAutoRotateResolver(
  input: DefaultYieldAutoRotateResolverInput,
): Promise<readonly YieldAutoRotateCandidate[]> {
  const token = extractStringParam(input.boundParams, ['token', 'mint', 'mintAddress', 'inputToken']);
  const amount = extractStringParam(input.boundParams, ['amount', 'inputAmount', 'sourceAmount', 'totalAmount']);
  if (!amount || !/^\d+(\.\d+)?$/.test(amount)) return [];
  if (!token || !isUsdcToken(token)) return [];
  if (input.cluster !== 'mainnet-beta') return [];

  const reads = await Promise.allSettled(YIELD_FACT_PROVIDERS.map(async (provider) => {
    const facts = await input.connectorFactsReader({
      ...provider.readInput,
      cluster: input.cluster,
      walletAddress: input.install.walletAddress,
    });
    return candidateFromYieldFacts(provider, facts, amount);
  }));

  return reads.flatMap((read) => (
    read.status === 'fulfilled' && read.value ? [read.value] : []
  ));
}

function candidateFromYieldFacts(
  provider: YieldFactProvider,
  facts: Record<string, unknown>,
  amount: string,
): YieldAutoRotateCandidate | undefined {
  const observation = extractYieldObservation(provider, facts);
  if (!observation) return undefined;
  if (observation.liquidity !== undefined && observation.liquidity <= 0) return undefined;
  return {
    connectorAction: provider.connectorAction,
    params: provider.params(amount),
    apyPercent: observation.apyPercent,
    label: provider.label,
    metadata: {
      source: 'connector-facts',
      provider: provider.provider,
      token: USDC_MINT,
      ...(observation.liquidity !== undefined ? { liquidity: observation.liquidity } : {}),
      ...(observation.sourceLabel ? { sourceLabel: observation.sourceLabel } : {}),
    },
  };
}

function extractYieldObservation(
  provider: YieldFactProvider,
  facts: Record<string, unknown>,
): YieldObservation | undefined {
  let objects = collectJsonObjects(facts);
  const usdcObjects = objects.filter((entry) => objectMentionsUsdc(entry));
  if (usdcObjects.length > 0) objects = usdcObjects;
  if (provider.requiredDepositType) {
    const matchingType = objects.filter((entry) => objectMentionsDepositType(entry, provider.requiredDepositType as string));
    if (matchingType.length > 0) objects = matchingType;
  }

  const scored = objects.flatMap((entry) => {
    const apyPercent = extractApyPercent(entry);
    if (apyPercent === undefined) return [];
    return [{
      apyPercent,
      liquidity: extractLiquidity(entry),
      sourceLabel: typeof entry.label === 'string' ? entry.label : undefined,
      score: yieldObjectScore(provider, entry),
    }];
  });
  const best = scored
    .filter((entry) => Number.isFinite(entry.apyPercent) && entry.apyPercent >= 0)
    .sort((left, right) => (
      right.score - left.score
      || right.apyPercent - left.apyPercent
    ))[0];
  if (!best) return undefined;
  return {
    apyPercent: best.apyPercent,
    ...(best.liquidity !== undefined ? { liquidity: best.liquidity } : {}),
    ...(best.sourceLabel ? { sourceLabel: best.sourceLabel } : {}),
  };
}

function yieldObjectScore(provider: YieldFactProvider, value: JsonObject): number {
  let score = 0;
  if (objectMentionsUsdc(value)) score += 4;
  if (provider.requiredDepositType && objectMentionsDepositType(value, provider.requiredDepositType)) score += 4;
  if (typeof value.label === 'string' && /supply|deposit|earn|protected/i.test(value.label)) score += 2;
  if (typeof value.connectorId === 'string' && value.connectorId === provider.provider) score += 1;
  return score;
}

function collectJsonObjects(value: unknown, limit = 300): JsonObject[] {
  const objects: JsonObject[] = [];
  const seen = new Set<unknown>();
  const visit = (entry: unknown) => {
    if (objects.length >= limit || entry === null || entry === undefined) return;
    if (typeof entry !== 'object') return;
    if (seen.has(entry)) return;
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!isJsonObject(entry)) return;
    objects.push(entry);
    for (const item of Object.values(entry)) visit(item);
  };
  visit(value);
  return objects;
}

function extractApyPercent(value: JsonObject): number | undefined {
  for (const [key, entry] of Object.entries(value)) {
    if (!isApyField(key, value.label)) continue;
    const parsed = parseNumberLike(entry);
    if (parsed !== undefined) return parsed;
  }
  if (typeof value.label === 'string' && isApyField('value', value.label)) {
    const parsed = parseNumberLike(value.value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function isApyField(key: string, label: unknown): boolean {
  const text = `${key} ${typeof label === 'string' ? label : ''}`.toLowerCase();
  if (text.includes('borrow') || text.includes('reward')) return false;
  return /\b(apy|apr)\b/.test(text)
    || /supplyapy|depositapy|currentapy|netapy|baseapy|yieldapy/.test(text)
    || key.toLowerCase() === 'rate';
}

function extractLiquidity(value: JsonObject): number | undefined {
  for (const [key, entry] of Object.entries(value)) {
    if (!/liquidity|capacity|depositlimitremaining|available|tvl/i.test(key)) continue;
    const parsed = parseNumberLike(entry);
    if (parsed !== undefined) return parsed;
  }
  if (typeof value.label === 'string' && /liquidity|capacity|deposit/i.test(value.label)) {
    return parseNumberLike(value.value);
  }
  return undefined;
}

function objectMentionsUsdc(value: JsonObject): boolean {
  return Object.values(value).some((entry) => {
    if (typeof entry !== 'string') return false;
    const normalized = entry.trim().toUpperCase();
    return normalized === 'USDC' || entry.trim() === USDC_MINT;
  });
}

function objectMentionsDepositType(value: JsonObject, depositType: string): boolean {
  const expected = depositType.trim().toLowerCase();
  return Object.values(value).some((entry) => (
    typeof entry === 'string' && entry.trim().toLowerCase().includes(expected)
  ));
}

function isPythFeedId(value: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(value.trim());
}

function isUsdcToken(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized === 'USDC' || value.trim() === USDC_MINT;
}

function extractStringParam(params: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value: JsonValue | undefined = params[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function parseNumberLike(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSupportedSkillApprovalKind(kind: string): boolean {
  return kind === 'swap'
    || kind === 'transfer_sol'
    || kind === 'transfer_spl'
    || kind === 'blink_action'
    || CONNECTOR_APPROVAL_ACTION_TYPES.has(kind as never);
}

async function saveFailedExecution(
  skillsStore: SkillsStore,
  install: SkillInstallRecord,
  manifest: SkillManifest | undefined,
  nowIso: string,
  metadata: JsonObject,
): Promise<void> {
  const executionId = `skill-exec-${randomUUID()}`;
  const executionRecord: SkillExecutionRecord = {
    id: executionId,
    installId: install.id,
    walletAddress: install.walletAddress,
    skillId: install.skillId,
    proposedAt: nowIso,
    result: 'failed',
    metadata: {
      ...(manifest ? { manifestVersion: manifest.version } : {}),
      ...metadata,
    },
  };
  await skillsStore.saveSkillExecution({
    id: executionId,
    installId: install.id,
    walletAddress: install.walletAddress,
    skillId: install.skillId,
    proposedAt: nowIso,
    result: 'failed',
    execution: executionRecord,
  });
}

interface ResolvedManifest {
  manifest: SkillManifest;
  manifestHash: string;
  manifestSource: 'install-snapshot' | 'catalog';
}

type ManifestResolution =
  | ResolvedManifest
  | {
      error:
        | 'manifest-missing'
        | 'manifest-version-mismatch'
        | 'manifest-snapshot-invalid'
        | 'manifest-snapshot-hash-mismatch';
      manifestHash?: string;
      details?: JsonObject;
    };

async function resolveManifestForInstall(
  skillsStore: SkillsStore,
  cache: Map<string, SkillManifestStoreRecord | undefined>,
  install: SkillInstallRecord,
): Promise<ManifestResolution> {
  const snapshotRead = manifestSnapshotFromInstall(install);
  if (snapshotRead.status === 'valid') {
    const snapshot = snapshotRead.manifest;
    const computedManifestHash = skillManifestHash(snapshot);
    if (snapshot.id !== install.skillId || snapshot.version !== install.manifestVersion) {
      return {
        error: 'manifest-snapshot-invalid',
        manifestHash: computedManifestHash,
        details: {
          snapshotSkillId: snapshot.id,
          snapshotManifestVersion: snapshot.version,
        },
      };
    }
    if (snapshotRead.manifestHash && snapshotRead.manifestHash !== computedManifestHash) {
      return {
        error: 'manifest-snapshot-hash-mismatch',
        manifestHash: computedManifestHash,
        details: {
          storedManifestHash: snapshotRead.manifestHash,
          computedManifestHash,
        },
      };
    }
    return {
      manifest: snapshot,
      manifestHash: computedManifestHash,
      manifestSource: 'install-snapshot',
    };
  }
  if (snapshotRead.status === 'invalid') {
    return {
      error: 'manifest-snapshot-invalid',
      ...(snapshotRead.manifestHash ? { manifestHash: snapshotRead.manifestHash } : {}),
      details: { snapshotInvalidReason: snapshotRead.reason },
    };
  }

  const record = await getManifestRecord(skillsStore, cache, install.skillId);
  if (!record) return { error: 'manifest-missing' };
  const manifest = record.manifest as SkillManifest;
  const manifestHash = skillManifestHashForRecord(record);
  if (manifest.version !== install.manifestVersion) {
    return { error: 'manifest-version-mismatch', manifestHash };
  }
  return { manifest, manifestHash, manifestSource: 'catalog' };
}

async function getManifestRecord(
  skillsStore: SkillsStore,
  cache: Map<string, SkillManifestStoreRecord | undefined>,
  skillId: string,
): Promise<SkillManifestStoreRecord | undefined> {
  if (cache.has(skillId)) return cache.get(skillId);
  const record = await skillsStore.getSkillManifest(skillId);
  cache.set(skillId, record);
  return record;
}

function resolveCluster(manifest: SkillManifest): WorkflowCluster {
  const raw = manifest.action.paramsTemplate?.['cluster'];
  if (typeof raw === 'string' && isWorkflowCluster(raw)) return raw;
  return 'mainnet-beta';
}

function isWorkflowCluster(value: string): value is WorkflowCluster {
  return value === 'mainnet-beta' || value === 'testnet' || value === 'devnet' || value === 'localnet';
}

function hasEvidenceStore(value: unknown): value is EvidenceStore {
  return Boolean(value)
    && typeof (value as EvidenceStore).getEvidence === 'function'
    && typeof (value as EvidenceStore).saveEvidence === 'function'
    && typeof (value as EvidenceStore).appendEvidenceAuditEvent === 'function';
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function writeAudit(
  store: WorkflowStore,
  walletAddress: string,
  type: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const record: AuditEventRecord = {
    id: `skill-audit-${randomUUID()}`,
    walletAddress,
    type,
    createdAt: new Date().toISOString(),
    metadata: metadata as AuditEventRecord['metadata'],
  };
  await store.appendAuditEvent(walletAddress, record);
}

// Test-only: reset the warn-once gate so multiple tests can exercise the
// no-skills-store path without coordinated reordering.
export function __resetSkillsExecutorWarnings(): void {
  warnedNoSkillsStore = false;
}

// Re-export tracked types to keep cli.ts's dynamic import shape stable.
export type { SkillInstallStoreRecord };
