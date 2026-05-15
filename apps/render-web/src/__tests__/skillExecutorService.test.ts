import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import {
  __resetSkillsExecutorWarnings,
  runSkillsExecuteTick,
} from '../cloud/skillExecutorService.js';
import {
  cloneSkillManifest,
  skillManifestHash,
} from '../cloud/skillManifestIntegrity.js';
import type { StatelessConnectorFactsReader } from '../cloud/connectorFactsReader.js';
import type {
  Clock,
  SkillInstallStoreRecord,
  SkillManifestStoreRecord,
  SkillExecutionStoreRecord,
} from '../cloud/store.js';
import type {
  JsonObject,
  SkillInstallRecord,
  SkillManifest,
  SkillExecutionRecord,
} from '@solana-agent-wallet-adapter/skills-runtime';
import type { ApprovalRequestRecord } from '@solana-agent-wallet-adapter/workflow';

const WALLET = 'Wallet1111111111111111111111111111111111111';
const AUTHOR = 'Author11111111111111111111111111111111111';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FRIDAY_9AM = '2026-05-15T09:00:00.000Z';
const FIXED_CLOCK: Clock = { now: () => new Date(FRIDAY_9AM) };

beforeEach(() => {
  __resetSkillsExecutorWarnings();
});

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: 'friday-dca',
    name: 'Friday DCA',
    version: '1.0.0',
    authorWallet: AUTHOR,
    description: 'DCA every Friday',
    category: 'dca',
    schedule: { kind: 'cron', spec: '0 9 * * FRI' },
    action: {
      connectorAction: 'swap',
      paramsTemplate: {
        inputToken: 'USDC',
        outputToken: 'SOL',
        amount: '50',
        slippageBps: '50',
      },
    },
    caps: {
      perRunMaxAmount: '50',
      lifetimeMaxAmount: '5000',
      allowlistedTokens: ['USDC', 'SOL'],
    },
    ...overrides,
  };
}

function install(overrides: Partial<SkillInstallRecord> = {}): SkillInstallRecord {
  return {
    id: 'install_friday_dca',
    walletAddress: WALLET,
    skillId: 'friday-dca',
    manifestVersion: '1.0.0',
    caps: {
      perRunMaxAmount: '50',
      lifetimeMaxAmount: '5000',
      allowlistedTokens: ['USDC', 'SOL'],
    },
    installedAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

function manifestStoreRecord(m: SkillManifest = manifest()): SkillManifestStoreRecord {
  return {
    id: m.id,
    version: m.version,
    authorWallet: m.authorWallet,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    manifest: m,
  };
}

function installStoreRecord(i: SkillInstallRecord = install()): SkillInstallStoreRecord {
  return {
    id: i.id,
    walletAddress: i.walletAddress,
    skillId: i.skillId,
    status: i.status,
    installedAt: i.installedAt,
    updatedAt: i.updatedAt,
    install: i,
  };
}

async function seed(
  store: MemoryWorkflowStore,
  m: SkillManifest = manifest(),
  i: SkillInstallRecord = install(),
): Promise<void> {
  await store.saveSkillManifest(manifestStoreRecord(m));
  await store.saveSkillInstall(installStoreRecord(i));
}

describe('runSkillsExecuteTick', () => {
  it('proposes an approval on the first Friday tick and records an execution row + audit event', async () => {
    const store = new MemoryWorkflowStore();
    await seed(store);

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(result).toEqual({ evaluated: 1, proposed: 1, skipped: 0 });
    const approvals = await store.listApprovals(WALLET);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.kind).toBe('swap');
    expect(approvals[0]?.params).toMatchObject({ inputToken: 'USDC', outputToken: 'SOL', amount: '50' });
    expect(approvals[0]?.metadata).toMatchObject({
      skillId: 'friday-dca',
      skillVersion: '1.0.0',
      manifestVersion: '1.0.0',
      manifestHash: expect.stringMatching(/^sha256:/),
      manifestSource: 'catalog',
      skillInstallId: 'install_friday_dca',
      capsSnapshot: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '5000',
        allowlistedTokens: ['USDC', 'SOL'],
      },
    });

    const executions = await store.listSkillExecutionsByInstall('install_friday_dca');
    expect(executions).toHaveLength(1);
    expect(executions[0]?.approvalRequestId).toBe(approvals[0]?.id);
    expect(executions[0]?.result).toBe('pending');
    expect(executions[0]?.execution).toMatchObject({
      metadata: {
        manifestVersion: '1.0.0',
        manifestHash: expect.stringMatching(/^sha256:/),
        manifestSource: 'catalog',
      },
    });

    const audit = await store.forWallet(WALLET).listAuditEvents();
    const skillAudits = audit.filter((e) => e.type.startsWith('skill.'));
    expect(skillAudits.some((e) => e.type === 'skill.execution.proposed')).toBe(true);
  });

  it('executes the install-time manifest snapshot even if the catalog record changes later', async () => {
    const store = new MemoryWorkflowStore();
    const installedManifest = manifest();
    const mutatedCatalogManifest = manifest({
      action: {
        connectorAction: 'swap',
        paramsTemplate: {
          inputToken: 'USDC',
          outputToken: 'SOL',
          amount: '500',
          slippageBps: '50',
        },
      },
      caps: {
        perRunMaxAmount: '500',
        lifetimeMaxAmount: '5000',
        allowlistedTokens: ['USDC', 'SOL'],
      },
    });
    await seed(
      store,
      mutatedCatalogManifest,
      install({
        metadata: {
          manifestSnapshot: cloneSkillManifest(installedManifest) as unknown as JsonObject,
          manifestHash: skillManifestHash(installedManifest),
        },
      }),
    );

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(result.proposed).toBe(1);
    const approvals = await store.listApprovals(WALLET);
    expect(approvals[0]?.params).toMatchObject({ amount: '50' });
    expect(approvals[0]?.metadata).toMatchObject({
      manifestHash: skillManifestHash(installedManifest),
      manifestSource: 'install-snapshot',
    });
  });

  it('rejects an invalid install-time manifest snapshot instead of falling back to the catalog', async () => {
    const store = new MemoryWorkflowStore();
    await seed(
      store,
      manifest(),
      install({
        metadata: {
          manifestSnapshot: 'not-a-manifest',
        },
      }),
    );

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(result).toEqual({ evaluated: 1, proposed: 0, skipped: 1 });
    expect(await store.listApprovals(WALLET)).toEqual([]);
    const audit = await store.forWallet(WALLET).listAuditEvents();
    expect(audit.find((e) => e.type === 'skill.execution.skipped')?.metadata)
      .toMatchObject({
        reason: 'manifest-snapshot-invalid',
        snapshotInvalidReason: 'manifest-snapshot-not-object',
      });
  });

  it('rejects an install-time manifest snapshot when the stored hash no longer matches', async () => {
    const store = new MemoryWorkflowStore();
    const installedManifest = manifest();
    const wrongHash = `sha256:${'0'.repeat(64)}`;
    await seed(
      store,
      installedManifest,
      install({
        metadata: {
          manifestSnapshot: cloneSkillManifest(installedManifest) as unknown as JsonObject,
          manifestHash: wrongHash,
        },
      }),
    );

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(result).toEqual({ evaluated: 1, proposed: 0, skipped: 1 });
    expect(await store.listApprovals(WALLET)).toEqual([]);
    const audit = await store.forWallet(WALLET).listAuditEvents();
    expect(audit.find((e) => e.type === 'skill.execution.skipped')?.metadata)
      .toMatchObject({
        reason: 'manifest-snapshot-hash-mismatch',
        storedManifestHash: wrongHash,
        computedManifestHash: skillManifestHash(installedManifest),
      });
  });

  it('skips legacy installs when the catalog head has moved to a different manifest version', async () => {
    const store = new MemoryWorkflowStore();
    await seed(
      store,
      manifest({ version: '2.0.0' }),
      install({ manifestVersion: '1.0.0' }),
    );

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(result).toEqual({ evaluated: 1, proposed: 0, skipped: 1 });
    expect(await store.listApprovals(WALLET)).toEqual([]);
    const audit = await store.forWallet(WALLET).listAuditEvents();
    expect(audit.find((e) => e.type === 'skill.execution.skipped')?.metadata)
      .toMatchObject({ reason: 'manifest-version-mismatch', manifestVersion: '1.0.0' });
  });

  it('uses connector facts for the default Pyth price-trigger lookup', async () => {
    const store = new MemoryWorkflowStore();
    const reads: Array<{ connectorId: string; symbol?: string; capability?: string }> = [];
    await seed(
      store,
      manifest({ schedule: { kind: 'price-trigger', spec: 'SOL/USD:lt:150' } }),
    );

    const result = await runSkillsExecuteTick({
      store,
      clock: FIXED_CLOCK,
      connectorFactsReader: async (input) => {
        reads.push({
          connectorId: input.connectorId,
          symbol: input.symbol,
          capability: input.capability,
        });
        return { snapshot: { status: 'fresh', priceUi: '120.25' } };
      },
    });

    expect(result).toEqual({ evaluated: 1, proposed: 1, skipped: 0 });
    expect(reads).toEqual([{ connectorId: 'pyth', symbol: 'SOL/USD', capability: 'markets' }]);
    const approvals = await store.listApprovals(WALLET);
    expect(approvals[0]?.kind).toBe('swap');
  });

  it('does not propose again on a second tick within the same firing window', async () => {
    const store = new MemoryWorkflowStore();
    await seed(store);

    await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });
    const second = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(second).toEqual({ evaluated: 1, proposed: 0, skipped: 1 });
    const approvals = await store.listApprovals(WALLET);
    expect(approvals).toHaveLength(1);
    const audit = await store.forWallet(WALLET).listAuditEvents();
    const skipped = audit.filter((e) => e.type === 'skill.execution.skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.at(-1)?.metadata).toMatchObject({ reason: 'cron-already-fired', stage: 'schedule' });
  });

  it('skips installs whose lifetime cap is already reached', async () => {
    const store = new MemoryWorkflowStore();
    const tightCaps = install({
      caps: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '0',
        allowlistedTokens: ['USDC'],
      },
    });
    await seed(store, manifest(), tightCaps);

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(result).toEqual({ evaluated: 1, proposed: 0, skipped: 1 });
    expect(await store.listApprovals(WALLET)).toEqual([]);
    const audit = await store.forWallet(WALLET).listAuditEvents();
    const skipped = audit.find((e) => e.type === 'skill.execution.skipped');
    expect(skipped?.metadata).toMatchObject({ reason: 'lifetime-cap-reached', stage: 'caps' });
  });

  it('skips expired installs', async () => {
    const store = new MemoryWorkflowStore();
    const expired = install({
      caps: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '5000',
        allowlistedTokens: ['USDC'],
        expiresAt: '2026-04-01T00:00:00.000Z',
      },
    });
    await seed(store, manifest(), expired);

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(result).toEqual({ evaluated: 1, proposed: 0, skipped: 1 });
    const audit = await store.forWallet(WALLET).listAuditEvents();
    expect(audit.find((e) => e.type === 'skill.execution.skipped')?.metadata)
      .toMatchObject({ reason: 'expired', stage: 'caps' });
  });

  it('writes a failure audit and skips when manifest contains forbidden authority fields', async () => {
    const store = new MemoryWorkflowStore();
    const malicious = manifest({
      action: {
        connectorAction: 'swap',
        paramsTemplate: { inputToken: 'USDC', amount: '50', delegatedSigner: WALLET },
      },
    });
    await seed(store, malicious);

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(result).toEqual({ evaluated: 1, proposed: 0, skipped: 1 });
    expect(await store.listApprovals(WALLET)).toEqual([]);
    const audit = await store.forWallet(WALLET).listAuditEvents();
    const failed = audit.find((e) => e.type === 'skill.execution.failed');
    expect(failed?.metadata).toMatchObject({ reason: 'forbidden-key', stage: 'sandbox' });
  });

  it('aggregates totalExecutedAmount from prior execution metadata for lifetime-cap checks', async () => {
    const store = new MemoryWorkflowStore();
    await seed(store, manifest());

    const priorExecution: SkillExecutionRecord = {
      id: 'prior_exec_1',
      installId: 'install_friday_dca',
      walletAddress: WALLET,
      skillId: 'friday-dca',
      proposedAt: '2026-05-08T09:00:00.000Z',
      approvalRequestId: 'approval_prior',
      result: 'success',
      metadata: { executedAmount: '4980' },
    };
    const priorStoreRecord: SkillExecutionStoreRecord = {
      id: priorExecution.id,
      installId: priorExecution.installId,
      walletAddress: priorExecution.walletAddress,
      skillId: priorExecution.skillId,
      proposedAt: priorExecution.proposedAt,
      result: priorExecution.result,
      approvalRequestId: priorExecution.approvalRequestId,
      execution: priorExecution,
    };
    await store.saveSkillExecution(priorStoreRecord);

    // 4980 + current run amount 50 would exceed the 5000 lifetime cap.
    const first = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });
    expect(first.proposed).toBe(0);
    expect(first.skipped).toBe(1);

    // Lower the prior execution enough for one more run to fit.
    priorExecution.metadata = { executedAmount: '4940' };
    await store.saveSkillExecution({
      ...priorStoreRecord,
      execution: priorExecution,
    });
    const nextFriday: Clock = { now: () => new Date('2026-05-22T09:00:00.000Z') };
    const second = await runSkillsExecuteTick({ store, clock: nextFriday });
    expect(second.proposed).toBe(1);

    // Now bump the prior execution to 5000 → a later tick should skip.
    priorExecution.metadata = { executedAmount: '5000' };
    await store.saveSkillExecution({
      ...priorStoreRecord,
      execution: priorExecution,
    });
    const thirdFriday: Clock = { now: () => new Date('2026-05-29T09:00:00.000Z') };
    const third = await runSkillsExecuteTick({ store, clock: thirdFriday });
    expect(third.skipped).toBe(1);
    expect(third.proposed).toBe(0);
  });

  it('binds install-time params before final cap evaluation', async () => {
    const store = new MemoryWorkflowStore();
    await seed(
      store,
      manifest({
        id: 'recurring-donation',
        action: {
          connectorAction: 'prepare_transfer_spl',
          paramsTemplate: {
            token: 'USDC',
            recipient: '{{install.recipient}}',
            amount: '10',
          },
        },
        caps: {
          perRunMaxAmount: '10',
          lifetimeMaxAmount: '120',
          allowlistedTokens: ['USDC'],
        },
      }),
      install({
        skillId: 'recurring-donation',
        caps: {
          perRunMaxAmount: '10',
          lifetimeMaxAmount: '120',
          allowlistedTokens: ['USDC'],
          allowlistedRecipients: ['Recipient111111111111111111111111111111111'],
        },
        metadata: {
          installParams: {
            recipient: 'Recipient111111111111111111111111111111111',
          },
        },
      }),
    );

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(result.proposed).toBe(1);
    const approvals = await store.listApprovals(WALLET);
    expect(approvals[0]?.kind).toBe('transfer_spl');
    expect(approvals[0]?.metadata).toMatchObject({
      skillConnectorAction: 'prepare_transfer_spl',
      normalizedApprovalKind: 'transfer_spl',
    });
    expect(approvals[0]?.params).toMatchObject({
      recipient: 'Recipient111111111111111111111111111111111',
    });
  });

  it('resolves yield.auto_rotate with the data-driven default resolver', async () => {
    const store = new MemoryWorkflowStore();
    const connectorFactsReader: StatelessConnectorFactsReader = async (input) => {
      if (input.connectorId === 'lulo') {
        return {
          snapshot: {
            rows: [
              {
                mintAddress: USDC_MINT,
                depositType: 'protected',
                apy: 6.4,
                liquidityAvailable: '1000',
              },
            ],
          },
        };
      }
      if (input.connectorId === 'kamino') {
        return {
          snapshot: {
            reserveMint: USDC_MINT,
            reserveSymbol: 'USDC',
            supplyApy: 5.2,
            depositLimitRemaining: '1000',
          },
        };
      }
      if (input.connectorId === 'save') {
        return {
          snapshot: {
            reserveMint: USDC_MINT,
            reserveSymbol: 'USDC',
            supplyApy: 4.1,
            depositLimitRemaining: '1000',
          },
        };
      }
      if (input.connectorId === 'jupiter') {
        return {
          token: {
            assetMint: USDC_MINT,
            tokenSymbol: 'USDC',
            apy: 5.7,
            availableLiquidity: '1000',
            active: true,
          },
        };
      }
      throw new Error(`unexpected connector ${input.connectorId}`);
    };
    await seed(
      store,
      manifest({
        id: 'yield-auto-rotate',
        action: {
          connectorAction: 'yield.auto_rotate',
          paramsTemplate: {
            token: 'USDC',
            amount: '50',
          },
        },
      }),
      install({ skillId: 'yield-auto-rotate' }),
    );

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK, connectorFactsReader });

    expect(result).toEqual({ evaluated: 1, proposed: 1, skipped: 0 });
    const approvals = await store.listApprovals(WALLET);
    expect(approvals[0]?.kind).toBe('lulo_deposit');
    expect(approvals[0]?.params).toMatchObject({
      mintAddress: USDC_MINT,
      amount: '50',
      depositType: 'protected',
    });
    expect(approvals[0]?.metadata).toMatchObject({
      yieldAutoRotate: {
        resolvedConnectorAction: 'prepare_lulo_deposit',
        apyPercent: 6.4,
        metadata: {
          source: 'connector-facts',
          provider: 'lulo',
        },
      },
    });
  });

  it('does not fall back to a blind yield.auto_rotate candidate when provider reads fail', async () => {
    const store = new MemoryWorkflowStore();
    await seed(
      store,
      manifest({
        id: 'yield-auto-rotate',
        action: {
          connectorAction: 'yield.auto_rotate',
          paramsTemplate: {
            token: 'USDC',
            amount: '50',
          },
        },
      }),
      install({ skillId: 'yield-auto-rotate' }),
    );

    const result = await runSkillsExecuteTick({
      store,
      clock: FIXED_CLOCK,
      connectorFactsReader: async () => {
        throw new Error('provider unavailable');
      },
    });

    expect(result).toEqual({ evaluated: 1, proposed: 0, skipped: 1 });
    expect(await store.listApprovals(WALLET)).toEqual([]);
    const audit = await store.forWallet(WALLET).listAuditEvents();
    expect(audit.find((e) => e.type === 'skill.execution.skipped')?.metadata)
      .toMatchObject({
        reason: 'yield-auto-rotate-no-candidates',
        stage: 'resolver',
      });
  });

  it('resolves yield.auto_rotate to the highest APY concrete action', async () => {
    const store = new MemoryWorkflowStore();
    await seed(
      store,
      manifest({
        id: 'yield-auto-rotate',
        action: {
          connectorAction: 'yield.auto_rotate',
          paramsTemplate: {
            token: 'USDC',
            amount: '50',
          },
        },
      }),
      install({ skillId: 'yield-auto-rotate' }),
    );

    const result = await runSkillsExecuteTick({
      store,
      clock: FIXED_CLOCK,
      yieldAutoRotateResolver: async ({ boundParams }) => [
        {
          connectorAction: 'prepare_kamino_deposit',
          params: { ...boundParams, reserveMint: 'USDC' },
          apyPercent: 5.1,
          label: 'Kamino USDC',
        },
        {
          connectorAction: 'prepare_lulo_deposit',
          params: { ...boundParams, depositType: 'protected' },
          apyPercent: 6.2,
          label: 'Lulo Protected USDC',
        },
      ],
    });

    expect(result.proposed).toBe(1);
    const approvals = await store.listApprovals(WALLET);
    expect(approvals[0]?.kind).toBe('lulo_deposit');
    expect(approvals[0]?.metadata).toMatchObject({
      yieldAutoRotate: {
        resolvedConnectorAction: 'prepare_lulo_deposit',
        apyPercent: 6.2,
      },
    });
  });

  it('writes a failed execution row when a due skill resolves to an unsupported approval kind', async () => {
    const store = new MemoryWorkflowStore();
    await seed(
      store,
      manifest({
        id: 'unsupported-skill',
        action: {
          connectorAction: 'prepare_totally_fake',
          paramsTemplate: { inputToken: 'USDC', amount: '50' },
        },
      }),
      install({ skillId: 'unsupported-skill' }),
    );

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(result).toEqual({ evaluated: 1, proposed: 0, skipped: 1 });
    expect(await store.listApprovals(WALLET)).toEqual([]);
    const executions = await store.listSkillExecutionsByInstall('install_friday_dca');
    expect(executions).toHaveLength(1);
    expect(executions[0]?.result).toBe('failed');
    expect(executions[0]?.execution).toMatchObject({
      metadata: {
        reason: 'unsupported-approval-kind:totally_fake',
        stage: 'approval-kind',
      },
    });
  });

  it('reconciles a terminal pending execution into a receipt before evaluating the next tick', async () => {
    const store = new MemoryWorkflowStore();
    await seed(store);
    const approval: ApprovalRequestRecord = {
      id: 'approval_terminal_skill',
      walletAddress: WALLET,
      kind: 'swap',
      status: 'approved',
      summary: 'Friday DCA',
      params: { inputToken: 'USDC', outputToken: 'SOL', amount: '50' },
      cluster: 'mainnet-beta',
      dueAt: '2026-05-15T09:00:00.000Z',
      createdAt: '2026-05-15T09:00:00.000Z',
      updatedAt: '2026-05-15T09:05:00.000Z',
      decidedAt: '2026-05-15T09:05:00.000Z',
      confirmedAt: '2026-05-15T09:05:00.000Z',
      amount: '50',
      txid: 'txid_terminal_skill',
      metadata: {
        skillId: 'friday-dca',
        skillInstallId: 'install_friday_dca',
      },
    };
    await store.saveApproval(WALLET, approval);
    await store.saveSkillExecution({
      id: 'skill-exec-pending',
      installId: 'install_friday_dca',
      walletAddress: WALLET,
      skillId: 'friday-dca',
      proposedAt: '2026-05-15T09:00:00.000Z',
      result: 'pending',
      approvalRequestId: approval.id,
      execution: {
        id: 'skill-exec-pending',
        installId: 'install_friday_dca',
        walletAddress: WALLET,
        skillId: 'friday-dca',
        proposedAt: '2026-05-15T09:00:00.000Z',
        approvalRequestId: approval.id,
        result: 'pending',
      },
    });

    const result = await runSkillsExecuteTick({ store, clock: FIXED_CLOCK });

    expect(result).toEqual({ evaluated: 1, proposed: 0, skipped: 1 });
    const execution = await store.getSkillExecutionByApprovalRequestId(WALLET, approval.id);
    expect(execution?.result).toBe('success');
    expect(execution?.evidenceReceiptId).toBeTruthy();
    expect(await store.listEvidence(WALLET)).toHaveLength(1);
  });
});
