// Reads skill_executions + their linked evidence_receipts to compute per-skill
// SkillStatsSnapshot and per-wallet WalletStatsSnapshot records, and persists
// them to aggregator_snapshots. The aggregator never trusts a skill's
// self-reported metrics: numeric fields (gas, P&L, APY) come from the
// signed/verified EvidenceReceiptRecord.metadata, not from the execution row.
// See plan: /Users/devlegacy/.claude/plans/ok-please-plan-out-purrfect-squirrel.md
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';
import type { JsonObject } from '@solana-agent-wallet-adapter/workflow';

import type { EvidenceReceiptRecord, EvidenceStore } from './evidenceService.js';
import {
  isAggregatorStore,
  isSkillsStore,
  type AggregatorStore,
  type Clock,
  type SkillExecutionStoreRecord,
  type SkillInstallStoreRecord,
  type SkillsStore,
} from './store.js';
import type { WorkflowStore } from './workflowService.js';

type SkillStatsSnapshot = DevLayer1.aggregator.SkillStatsSnapshot;
type WalletStatsSnapshot = DevLayer1.aggregator.WalletStatsSnapshot;

export interface AggregatorRollInput {
  store: WorkflowStore;
  clock: Clock;
}

export interface AggregatorRollResult {
  skillSnapshots: number;
  walletSnapshots: number;
}

export async function runAggregatorRoll(input: AggregatorRollInput): Promise<AggregatorRollResult> {
  const { store, clock } = input;

  if (!isSkillsStore(store) || !isAggregatorStore(store) || !hasEvidenceStore(store)) {
    console.warn(
      'Aggregator roll skipped: store does not implement SkillsStore + AggregatorStore + EvidenceStore.',
    );
    return { skillSnapshots: 0, walletSnapshots: 0 };
  }

  const skillsStore = store as unknown as SkillsStore;
  const aggregatorStore = store as unknown as AggregatorStore;
  const evidenceStore = store as unknown as EvidenceStore;

  const computedAt = clock.now().toISOString();
  const receiptCache = new Map<string, EvidenceReceiptRecord | null>();
  const walletExecutions = new Map<string, SkillExecutionStoreRecord[]>();

  const manifests = await skillsStore.listSkillManifests();
  const activeInstalls = await skillsStore.listActiveSkillInstalls();

  let skillSnapshots = 0;
  for (const manifest of manifests) {
    const executions = await skillsStore.listSkillExecutionsForSkill(manifest.id);
    for (const execution of executions) {
      const list = walletExecutions.get(execution.walletAddress) ?? [];
      list.push(execution);
      walletExecutions.set(execution.walletAddress, list);
    }
    const installCount = activeInstalls.filter((install) => install.skillId === manifest.id).length;
    const snapshot = await computeSkillSnapshot({
      skillId: manifest.id,
      installs: installCount,
      executions,
      evidenceStore,
      receiptCache,
      computedAt,
    });
    await aggregatorStore.saveAggregatorSnapshot({
      key: `skill:${manifest.id}`,
      kind: 'skill',
      computedAt,
      snapshot,
    });
    skillSnapshots += 1;
  }

  const walletSet = new Set<string>();
  for (const install of activeInstalls) walletSet.add(install.walletAddress);
  for (const wallet of walletExecutions.keys()) walletSet.add(wallet);

  let walletSnapshots = 0;
  for (const walletAddress of walletSet) {
    const installsForWallet = await skillsStore.listSkillInstallsForWallet(walletAddress);
    const executions = walletExecutions.get(walletAddress) ?? [];
    const snapshot = await computeWalletSnapshot({
      walletAddress,
      installs: installsForWallet,
      executions,
      evidenceStore,
      receiptCache,
      computedAt,
    });
    await aggregatorStore.saveAggregatorSnapshot({
      key: `wallet:${walletAddress}`,
      kind: 'wallet',
      computedAt,
      snapshot,
    });
    walletSnapshots += 1;
  }

  return { skillSnapshots, walletSnapshots };
}

function hasEvidenceStore(value: unknown): value is EvidenceStore {
  return Boolean(value) && typeof (value as EvidenceStore).getEvidence === 'function';
}

interface SkillSnapshotInput {
  skillId: string;
  installs: number;
  executions: SkillExecutionStoreRecord[];
  evidenceStore: EvidenceStore;
  receiptCache: Map<string, EvidenceReceiptRecord | null>;
  computedAt: string;
}

async function computeSkillSnapshot(input: SkillSnapshotInput): Promise<SkillStatsSnapshot> {
  const { skillId, installs, executions, evidenceStore, receiptCache, computedAt } = input;
  const totalExecutions = executions.length;
  const { successCount, failedCount } = countResults(executions);
  const denominator = successCount + failedCount;
  const successRate = denominator === 0 ? 0 : successCount / denominator;
  const lastExecutionAt = pickLastExecutionAt(executions);

  const { gasSeries, apySeries, drawdownSeries } = await collectReceiptSeries(
    executions,
    evidenceStore,
    receiptCache,
  );

  const snapshot: SkillStatsSnapshot = {
    skillId,
    installs,
    totalExecutions,
    successRate,
    computedAt,
  };
  if (lastExecutionAt !== undefined) snapshot.lastExecutionAt = lastExecutionAt;
  if (gasSeries.length > 0) snapshot.medianGasUsd = formatNumber(median(gasSeries));
  if (apySeries.length > 0) snapshot.medianApyPercent = formatNumber(median(apySeries));
  if (drawdownSeries.length > 0) snapshot.maxDrawdownPercent = formatNumber(Math.max(...drawdownSeries));
  return snapshot;
}

interface WalletSnapshotInput {
  walletAddress: string;
  installs: SkillInstallStoreRecord[];
  executions: SkillExecutionStoreRecord[];
  evidenceStore: EvidenceStore;
  receiptCache: Map<string, EvidenceReceiptRecord | null>;
  computedAt: string;
}

async function computeWalletSnapshot(input: WalletSnapshotInput): Promise<WalletStatsSnapshot> {
  const { walletAddress, installs, executions, evidenceStore, receiptCache, computedAt } = input;
  const activeInstalls = installs.filter((install) => install.status === 'active');
  const installedSkillIds = Array.from(new Set(activeInstalls.map((install) => install.skillId))).sort();
  const totalExecutions = executions.length;
  const { successCount, failedCount } = countResults(executions);
  const denominator = successCount + failedCount;
  const successRate = denominator === 0 ? 0 : successCount / denominator;
  const { gasSeries, pnlSeries } = await collectReceiptSeries(
    executions,
    evidenceStore,
    receiptCache,
  );

  const snapshot: WalletStatsSnapshot = {
    walletAddress,
    totalSkillsInstalled: activeInstalls.length,
    totalExecutions,
    successRate,
    installedSkillIds,
    computedAt,
  };
  if (gasSeries.length > 0) snapshot.totalGasUsd = formatNumber(sum(gasSeries));
  if (pnlSeries.length > 0) snapshot.totalProfitUsd = formatNumber(sum(pnlSeries));
  return snapshot;
}

function countResults(executions: readonly SkillExecutionStoreRecord[]): {
  successCount: number;
  failedCount: number;
} {
  let successCount = 0;
  let failedCount = 0;
  for (const execution of executions) {
    if (execution.result === 'success') successCount += 1;
    else if (execution.result === 'failed') failedCount += 1;
  }
  return { successCount, failedCount };
}

function pickLastExecutionAt(executions: readonly SkillExecutionStoreRecord[]): string | undefined {
  let latest: string | undefined;
  let latestMs = -Infinity;
  for (const execution of executions) {
    const ms = Date.parse(execution.proposedAt);
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = execution.proposedAt;
    }
  }
  return latest;
}

interface ReceiptSeries {
  gasSeries: number[];
  apySeries: number[];
  pnlSeries: number[];
  drawdownSeries: number[];
}

async function collectReceiptSeries(
  executions: readonly SkillExecutionStoreRecord[],
  evidenceStore: EvidenceStore,
  receiptCache: Map<string, EvidenceReceiptRecord | null>,
): Promise<ReceiptSeries> {
  const gasSeries: number[] = [];
  const apySeries: number[] = [];
  const pnlSeries: number[] = [];
  const drawdownSeries: number[] = [];
  for (const execution of executions) {
    if (execution.result !== 'success') continue;
    if (!execution.evidenceReceiptId) continue;
    const cacheKey = `${execution.walletAddress}::${execution.evidenceReceiptId}`;
    let cached = receiptCache.get(cacheKey);
    if (cached === undefined) {
      cached = (await evidenceStore.getEvidence(execution.walletAddress, execution.evidenceReceiptId)) ?? null;
      receiptCache.set(cacheKey, cached);
    }
    if (!cached || cached.verified !== true) continue;
    const meta = (cached.metadata ?? {}) as JsonObject;
    const gas = extractNumber(meta, 'gasUsed');
    if (gas !== undefined) gasSeries.push(gas);
    const apy = extractNumber(meta, 'apyPercent');
    if (apy !== undefined) apySeries.push(apy);
    const pnl = extractNumber(meta, 'pnl');
    if (pnl !== undefined) pnlSeries.push(pnl);
    const drawdown = extractNumber(meta, 'maxDrawdownPercent') ?? extractNumber(meta, 'drawdownPercent');
    if (drawdown !== undefined) drawdownSeries.push(drawdown);
  }
  return { gasSeries, apySeries, pnlSeries, drawdownSeries };
}

function extractNumber(meta: JsonObject, key: string): number | undefined {
  const raw = meta[key];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[mid - 1] ?? 0;
    const right = sorted[mid] ?? 0;
    return (left + right) / 2;
  }
  return sorted[mid] ?? 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

// USDC has 6 decimals; toFixed(6) bounds float precision without scientific
// notation. Trailing zeros stripped so 46.5 emits as '46.5', not '46.500000'.
function formatNumber(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, '');
}
