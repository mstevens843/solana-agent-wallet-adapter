import type { EvidenceReceiptRecord, JsonObject } from '@solana-agent-wallet-adapter/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runAggregatorRoll } from '../cloud/aggregatorJob.js';
import { MemoryEvidenceStore } from '../cloud/evidenceService.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import type {
  AggregatorSnapshotStoreRecord,
  Clock,
  SkillExecutionStoreRecord,
  SkillInstallStoreRecord,
  SkillManifestStoreRecord,
} from '../cloud/store.js';
import type { WorkflowStore } from '../cloud/workflowService.js';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const OTHER_DEV_WALLET = '7VdH9KZsd4n4cZcUMthxq5J3PoF7nqLwT9C3W6PYTKfA';
const FIXED_NOW = new Date('2026-05-14T12:00:00.000Z');

interface TestRig {
  store: WorkflowStore;
  raw: MemoryWorkflowStore;
  evidence: MemoryEvidenceStore;
}

function buildRig(): TestRig {
  const raw = new MemoryWorkflowStore();
  const evidence = new MemoryEvidenceStore();
  // PostgresWorkflowStore implements EvidenceStore directly; mirror that here
  // by grafting MemoryEvidenceStore methods onto MemoryWorkflowStore so the
  // aggregator's runtime guards see a single combined store.
  Object.assign(raw, {
    listEvidence: evidence.listEvidence.bind(evidence),
    getEvidence: evidence.getEvidence.bind(evidence),
    saveEvidence: evidence.saveEvidence.bind(evidence),
    deleteEvidence: evidence.deleteEvidence.bind(evidence),
    deleteAllEvidence: evidence.deleteAllEvidence.bind(evidence),
    appendEvidenceAuditEvent: evidence.appendEvidenceAuditEvent.bind(evidence),
  });
  return { store: raw as unknown as WorkflowStore, raw, evidence };
}

function fixedClock(now: Date = FIXED_NOW): Clock {
  return { now: () => now };
}

async function seedManifest(
  raw: MemoryWorkflowStore,
  id: string,
  opts: { authorWallet?: string; version?: string } = {},
): Promise<void> {
  const version = opts.version ?? '1.0.0';
  const authorWallet = opts.authorWallet ?? DEV_WALLET;
  const record: SkillManifestStoreRecord = {
    id,
    version,
    authorWallet,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    manifest: {
      id,
      name: id,
      version,
      authorWallet,
      description: '',
      category: 'dca',
      schedule: { kind: 'cron', spec: '0 0 * * 5' },
      action: { connectorAction: 'noop', paramsTemplate: {} },
      caps: { perRunMaxAmount: '1', lifetimeMaxAmount: '1', allowlistedTokens: ['USDC'] },
    },
  };
  await raw.saveSkillManifest(record);
}

async function seedInstall(
  raw: MemoryWorkflowStore,
  opts: {
    id: string;
    walletAddress: string;
    skillId: string;
    status?: SkillInstallStoreRecord['status'];
  },
): Promise<void> {
  const record: SkillInstallStoreRecord = {
    id: opts.id,
    walletAddress: opts.walletAddress,
    skillId: opts.skillId,
    status: opts.status ?? 'active',
    installedAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    install: {},
  };
  await raw.saveSkillInstall(record);
}

async function seedExecution(
  raw: MemoryWorkflowStore,
  opts: {
    id: string;
    installId: string;
    walletAddress: string;
    skillId: string;
    result?: SkillExecutionStoreRecord['result'];
    proposedAt?: string;
    evidenceReceiptId?: string;
  },
): Promise<void> {
  const record: SkillExecutionStoreRecord = {
    id: opts.id,
    installId: opts.installId,
    walletAddress: opts.walletAddress,
    skillId: opts.skillId,
    proposedAt: opts.proposedAt ?? '2026-05-10T00:00:00.000Z',
    result: opts.result ?? 'success',
    approvalRequestId: `apr-${opts.id}`,
    execution: {},
    ...(opts.evidenceReceiptId ? { evidenceReceiptId: opts.evidenceReceiptId } : {}),
  };
  await raw.saveSkillExecution(record);
}

async function seedReceipt(
  evidence: MemoryEvidenceStore,
  opts: {
    id: string;
    walletAddress: string;
    metadata: JsonObject;
    verified?: boolean;
  },
): Promise<void> {
  const record: EvidenceReceiptRecord = {
    id: opts.id,
    walletAddress: opts.walletAddress,
    title: 'test receipt',
    kind: 'review_proof',
    status: 'approved',
    payload: {},
    preSignatureHash: `pre-${opts.id}`,
    signingMessage: `msg-${opts.id}`,
    signature: `sig-${opts.id}`,
    verified: opts.verified ?? true,
    artifactHash: `pre-${opts.id}`,
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    metadata: opts.metadata,
  };
  await evidence.saveEvidence(opts.walletAddress, record);
}

async function getSkillSnapshot(
  raw: MemoryWorkflowStore,
  skillId: string,
): Promise<AggregatorSnapshotStoreRecord | undefined> {
  return raw.getAggregatorSnapshot(`skill:${skillId}`);
}

async function getWalletSnapshot(
  raw: MemoryWorkflowStore,
  walletAddress: string,
): Promise<AggregatorSnapshotStoreRecord | undefined> {
  return raw.getAggregatorSnapshot(`wallet:${walletAddress}`);
}

describe('runAggregatorRoll', () => {
  describe('empty / degenerate inputs', () => {
    it('returns zero counts and writes nothing when no manifests or installs exist', async () => {
      const rig = buildRig();
      const result = await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      expect(result).toEqual({ skillSnapshots: 0, walletSnapshots: 0 });
      expect(await rig.raw.listAggregatorSnapshotsByKind('skill')).toHaveLength(0);
      expect(await rig.raw.listAggregatorSnapshotsByKind('wallet')).toHaveLength(0);
    });

    it('warns and returns zero counts when the store lacks SkillsStore / AggregatorStore / EvidenceStore', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const minimal: WorkflowStore = {
          listPlans: async () => [],
          getPlan: async () => undefined,
          savePlan: async () => undefined,
          deletePlan: async () => false,
          listApprovals: async () => [],
          getApproval: async () => undefined,
          saveApproval: async () => undefined,
          listCompleted: async () => [],
          getCompleted: async () => undefined,
          saveCompleted: async () => undefined,
          deleteCompleted: async () => false,
          listFinalizations: async () => [],
          getFinalization: async () => undefined,
          saveFinalization: async () => undefined,
          appendAuditEvent: async () => undefined,
        };
        const result = await runAggregatorRoll({ store: minimal, clock: fixedClock() });
        expect(result).toEqual({ skillSnapshots: 0, walletSnapshots: 0 });
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('per-skill snapshot math', () => {
    it('computes success rate as success / (success + failed), excluding pending and rejected', async () => {
      const rig = buildRig();
      await seedManifest(rig.raw, 'friday-dca');
      await seedInstall(rig.raw, { id: 'install-1', walletAddress: DEV_WALLET, skillId: 'friday-dca' });
      for (let i = 0; i < 10; i += 1) {
        await seedExecution(rig.raw, {
          id: `exec-success-${i}`,
          installId: 'install-1',
          walletAddress: DEV_WALLET,
          skillId: 'friday-dca',
          result: 'success',
          proposedAt: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        });
      }
      await seedExecution(rig.raw, {
        id: 'exec-failed',
        installId: 'install-1',
        walletAddress: DEV_WALLET,
        skillId: 'friday-dca',
        result: 'failed',
        proposedAt: '2026-05-11T00:00:00.000Z',
      });
      await seedExecution(rig.raw, {
        id: 'exec-pending',
        installId: 'install-1',
        walletAddress: DEV_WALLET,
        skillId: 'friday-dca',
        result: 'pending',
        proposedAt: '2026-05-12T00:00:00.000Z',
      });
      await seedExecution(rig.raw, {
        id: 'exec-rejected',
        installId: 'install-1',
        walletAddress: DEV_WALLET,
        skillId: 'friday-dca',
        result: 'rejected',
        proposedAt: '2026-05-13T00:00:00.000Z',
      });

      const result = await runAggregatorRoll({ store: rig.store, clock: fixedClock() });

      expect(result.skillSnapshots).toBe(1);
      const record = await getSkillSnapshot(rig.raw, 'friday-dca');
      expect(record).toBeDefined();
      const snapshot = record!.snapshot as Record<string, unknown>;
      expect(snapshot.skillId).toBe('friday-dca');
      expect(snapshot.installs).toBe(1);
      expect(snapshot.totalExecutions).toBe(13);
      expect(Math.abs((snapshot.successRate as number) - 10 / 11)).toBeLessThan(1e-9);
      expect(snapshot.lastExecutionAt).toBe('2026-05-13T00:00:00.000Z');
      expect(snapshot.medianGasUsd).toBeUndefined();
      expect(snapshot.medianApyPercent).toBeUndefined();
    });

    it('reports successRate = 0 (not NaN) when no resolved executions exist', async () => {
      const rig = buildRig();
      await seedManifest(rig.raw, 'friday-dca');
      await seedInstall(rig.raw, { id: 'install-1', walletAddress: DEV_WALLET, skillId: 'friday-dca' });
      await seedExecution(rig.raw, {
        id: 'exec-pending',
        installId: 'install-1',
        walletAddress: DEV_WALLET,
        skillId: 'friday-dca',
        result: 'pending',
      });

      await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      const record = await getSkillSnapshot(rig.raw, 'friday-dca');
      const snapshot = record!.snapshot as Record<string, unknown>;
      expect(snapshot.successRate).toBe(0);
      expect(snapshot.totalExecutions).toBe(1);
    });

    it('writes a snapshot for a manifest with zero executions and zero installs', async () => {
      const rig = buildRig();
      await seedManifest(rig.raw, 'unused-skill');

      const result = await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      expect(result.skillSnapshots).toBe(1);
      const record = await getSkillSnapshot(rig.raw, 'unused-skill');
      const snapshot = record!.snapshot as Record<string, unknown>;
      expect(snapshot.installs).toBe(0);
      expect(snapshot.totalExecutions).toBe(0);
      expect(snapshot.successRate).toBe(0);
      expect(snapshot.lastExecutionAt).toBeUndefined();
      expect(snapshot.medianGasUsd).toBeUndefined();
    });

    it('derives medianGasUsd from verified receipts only', async () => {
      const rig = buildRig();
      await seedManifest(rig.raw, 'friday-dca');
      await seedInstall(rig.raw, { id: 'install-1', walletAddress: DEV_WALLET, skillId: 'friday-dca' });
      await seedReceipt(rig.evidence, {
        id: 'evi-1',
        walletAddress: DEV_WALLET,
        metadata: { gasUsed: '0.0010', pnl: '5.00' },
      });
      await seedReceipt(rig.evidence, {
        id: 'evi-2',
        walletAddress: DEV_WALLET,
        metadata: { gasUsed: '0.0021', pnl: '15.50' },
      });
      await seedReceipt(rig.evidence, {
        id: 'evi-3',
        walletAddress: DEV_WALLET,
        metadata: { gasUsed: '0.0030', pnl: '15.50' },
      });
      for (const id of ['evi-1', 'evi-2', 'evi-3']) {
        await seedExecution(rig.raw, {
          id: `exec-${id}`,
          installId: 'install-1',
          walletAddress: DEV_WALLET,
          skillId: 'friday-dca',
          result: 'success',
          evidenceReceiptId: id,
        });
      }

      await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      const record = await getSkillSnapshot(rig.raw, 'friday-dca');
      const snapshot = record!.snapshot as Record<string, unknown>;
      expect(snapshot.medianGasUsd).toBe('0.0021');
    });

    it('derives maxDrawdownPercent from verified receipt metadata', async () => {
      const rig = buildRig();
      await seedManifest(rig.raw, 'yield-rotate');
      await seedInstall(rig.raw, { id: 'install-1', walletAddress: DEV_WALLET, skillId: 'yield-rotate' });
      await seedReceipt(rig.evidence, {
        id: 'evi-1',
        walletAddress: DEV_WALLET,
        metadata: { drawdownPercent: '2.5' },
      });
      await seedReceipt(rig.evidence, {
        id: 'evi-2',
        walletAddress: DEV_WALLET,
        metadata: { maxDrawdownPercent: '4.75' },
      });
      for (const id of ['evi-1', 'evi-2']) {
        await seedExecution(rig.raw, {
          id: `exec-${id}`,
          installId: 'install-1',
          walletAddress: DEV_WALLET,
          skillId: 'yield-rotate',
          result: 'success',
          evidenceReceiptId: id,
        });
      }

      await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      const snapshot = (await getSkillSnapshot(rig.raw, 'yield-rotate'))!.snapshot as Record<string, unknown>;
      expect(snapshot.maxDrawdownPercent).toBe('4.75');
    });

    it('excludes receipts with verified === false from gas / pnl series', async () => {
      const rig = buildRig();
      await seedManifest(rig.raw, 'friday-dca');
      await seedInstall(rig.raw, { id: 'install-1', walletAddress: DEV_WALLET, skillId: 'friday-dca' });
      await seedReceipt(rig.evidence, {
        id: 'evi-verified',
        walletAddress: DEV_WALLET,
        metadata: { gasUsed: '0.0021', pnl: '15.50' },
        verified: true,
      });
      await seedReceipt(rig.evidence, {
        id: 'evi-tampered',
        walletAddress: DEV_WALLET,
        metadata: { gasUsed: '999', pnl: '999' },
        verified: false,
      });
      await seedExecution(rig.raw, {
        id: 'exec-1',
        installId: 'install-1',
        walletAddress: DEV_WALLET,
        skillId: 'friday-dca',
        result: 'success',
        evidenceReceiptId: 'evi-verified',
      });
      await seedExecution(rig.raw, {
        id: 'exec-2',
        installId: 'install-1',
        walletAddress: DEV_WALLET,
        skillId: 'friday-dca',
        result: 'success',
        evidenceReceiptId: 'evi-tampered',
      });

      await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      const snapshot = (await getSkillSnapshot(rig.raw, 'friday-dca'))!.snapshot as Record<string, unknown>;
      expect(snapshot.medianGasUsd).toBe('0.0021');
    });

    it('counts executions toward totals even when their evidence receipt is missing', async () => {
      const rig = buildRig();
      await seedManifest(rig.raw, 'friday-dca');
      await seedInstall(rig.raw, { id: 'install-1', walletAddress: DEV_WALLET, skillId: 'friday-dca' });
      await seedExecution(rig.raw, {
        id: 'exec-orphan',
        installId: 'install-1',
        walletAddress: DEV_WALLET,
        skillId: 'friday-dca',
        result: 'success',
        evidenceReceiptId: 'evi-missing',
      });

      const result = await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      expect(result.skillSnapshots).toBe(1);
      const snapshot = (await getSkillSnapshot(rig.raw, 'friday-dca'))!.snapshot as Record<string, unknown>;
      expect(snapshot.totalExecutions).toBe(1);
      expect(snapshot.successRate).toBe(1);
      expect(snapshot.medianGasUsd).toBeUndefined();
    });
  });

  describe('per-wallet snapshot math', () => {
    it('aggregates totals from verified receipts and lists active install skill ids', async () => {
      const rig = buildRig();
      await seedManifest(rig.raw, 'friday-dca');
      await seedManifest(rig.raw, 'yield-rotate');
      await seedInstall(rig.raw, { id: 'install-1', walletAddress: DEV_WALLET, skillId: 'friday-dca' });
      await seedInstall(rig.raw, { id: 'install-2', walletAddress: DEV_WALLET, skillId: 'yield-rotate' });
      await seedReceipt(rig.evidence, {
        id: 'evi-1',
        walletAddress: DEV_WALLET,
        metadata: { gasUsed: '0.001', pnl: '10.5' },
      });
      await seedReceipt(rig.evidence, {
        id: 'evi-2',
        walletAddress: DEV_WALLET,
        metadata: { gasUsed: '0.002', pnl: '4.5' },
      });
      await seedExecution(rig.raw, {
        id: 'exec-1',
        installId: 'install-1',
        walletAddress: DEV_WALLET,
        skillId: 'friday-dca',
        result: 'success',
        evidenceReceiptId: 'evi-1',
      });
      await seedExecution(rig.raw, {
        id: 'exec-2',
        installId: 'install-2',
        walletAddress: DEV_WALLET,
        skillId: 'yield-rotate',
        result: 'success',
        evidenceReceiptId: 'evi-2',
      });

      const result = await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      expect(result.walletSnapshots).toBe(1);
      const snapshot = (await getWalletSnapshot(rig.raw, DEV_WALLET))!.snapshot as Record<string, unknown>;
      expect(snapshot.walletAddress).toBe(DEV_WALLET);
      expect(snapshot.totalSkillsInstalled).toBe(2);
      expect(snapshot.installedSkillIds).toEqual(['friday-dca', 'yield-rotate']);
      expect(snapshot.totalExecutions).toBe(2);
      expect(snapshot.successRate).toBe(1);
      expect(snapshot.totalGasUsd).toBe('0.003');
      expect(snapshot.totalProfitUsd).toBe('15');
    });

    it('excludes paused / revoked / expired installs from totalSkillsInstalled and installedSkillIds', async () => {
      const rig = buildRig();
      await seedManifest(rig.raw, 'friday-dca');
      await seedManifest(rig.raw, 'yield-rotate');
      await seedManifest(rig.raw, 'stop-loss');
      await seedInstall(rig.raw, { id: 'i-active', walletAddress: DEV_WALLET, skillId: 'friday-dca', status: 'active' });
      await seedInstall(rig.raw, { id: 'i-paused', walletAddress: DEV_WALLET, skillId: 'yield-rotate', status: 'paused' });
      await seedInstall(rig.raw, { id: 'i-revoked', walletAddress: DEV_WALLET, skillId: 'stop-loss', status: 'revoked' });
      await seedExecution(rig.raw, {
        id: 'exec-1',
        installId: 'i-paused',
        walletAddress: DEV_WALLET,
        skillId: 'yield-rotate',
        result: 'success',
      });

      await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      const snapshot = (await getWalletSnapshot(rig.raw, DEV_WALLET))!.snapshot as Record<string, unknown>;
      expect(snapshot.totalSkillsInstalled).toBe(1);
      expect(snapshot.installedSkillIds).toEqual(['friday-dca']);
      expect(snapshot.totalExecutions).toBe(1);
    });

    it('produces one snapshot per wallet when two wallets install the same skill', async () => {
      const rig = buildRig();
      await seedManifest(rig.raw, 'friday-dca');
      await seedInstall(rig.raw, { id: 'i-a', walletAddress: DEV_WALLET, skillId: 'friday-dca' });
      await seedInstall(rig.raw, { id: 'i-b', walletAddress: OTHER_DEV_WALLET, skillId: 'friday-dca' });
      await seedExecution(rig.raw, {
        id: 'exec-a',
        installId: 'i-a',
        walletAddress: DEV_WALLET,
        skillId: 'friday-dca',
        result: 'success',
      });
      await seedExecution(rig.raw, {
        id: 'exec-b',
        installId: 'i-b',
        walletAddress: OTHER_DEV_WALLET,
        skillId: 'friday-dca',
        result: 'success',
      });

      const result = await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      expect(result.skillSnapshots).toBe(1);
      expect(result.walletSnapshots).toBe(2);

      const skillSnapshot = (await getSkillSnapshot(rig.raw, 'friday-dca'))!.snapshot as Record<string, unknown>;
      expect(skillSnapshot.installs).toBe(2);
      expect(skillSnapshot.totalExecutions).toBe(2);

      const walletA = (await getWalletSnapshot(rig.raw, DEV_WALLET))!.snapshot as Record<string, unknown>;
      const walletB = (await getWalletSnapshot(rig.raw, OTHER_DEV_WALLET))!.snapshot as Record<string, unknown>;
      expect(walletA.totalExecutions).toBe(1);
      expect(walletB.totalExecutions).toBe(1);
    });
  });

  describe('idempotence', () => {
    let rig: TestRig;

    beforeEach(async () => {
      rig = buildRig();
      await seedManifest(rig.raw, 'friday-dca');
      await seedInstall(rig.raw, { id: 'install-1', walletAddress: DEV_WALLET, skillId: 'friday-dca' });
      await seedReceipt(rig.evidence, {
        id: 'evi-1',
        walletAddress: DEV_WALLET,
        metadata: { gasUsed: '0.0021', pnl: '15.50' },
      });
      await seedExecution(rig.raw, {
        id: 'exec-1',
        installId: 'install-1',
        walletAddress: DEV_WALLET,
        skillId: 'friday-dca',
        result: 'success',
        evidenceReceiptId: 'evi-1',
      });
    });

    it('produces identical snapshot bodies on consecutive rolls (computedAt aside)', async () => {
      const firstNow = new Date('2026-05-14T12:00:00.000Z');
      const secondNow = new Date('2026-05-14T12:15:00.000Z');

      await runAggregatorRoll({ store: rig.store, clock: fixedClock(firstNow) });
      const first = await getSkillSnapshot(rig.raw, 'friday-dca');
      const firstSnapshot = { ...(first!.snapshot as Record<string, unknown>) };

      await runAggregatorRoll({ store: rig.store, clock: fixedClock(secondNow) });
      const second = await getSkillSnapshot(rig.raw, 'friday-dca');
      const secondSnapshot = { ...(second!.snapshot as Record<string, unknown>) };

      expect(second!.computedAt).toBe(secondNow.toISOString());
      expect(first!.computedAt).toBe(firstNow.toISOString());

      delete firstSnapshot.computedAt;
      delete secondSnapshot.computedAt;
      expect(secondSnapshot).toEqual(firstSnapshot);
    });

    it('upserts in place — listAggregatorSnapshotsByKind size stays at 1 after re-roll', async () => {
      await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      await runAggregatorRoll({ store: rig.store, clock: fixedClock() });
      expect(await rig.raw.listAggregatorSnapshotsByKind('skill')).toHaveLength(1);
      expect(await rig.raw.listAggregatorSnapshotsByKind('wallet')).toHaveLength(1);
    });
  });
});
