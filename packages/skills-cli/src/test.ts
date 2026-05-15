import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  bindManifestParams,
  buildApprovalRequest,
  compareDecimalStrings,
  evaluateCaps,
  type BuildApprovalResult,
  type SkillInstallRecord,
} from '@solana-agent-wallet-adapter/skills-runtime';
import type { WorkflowCluster } from '@solana-agent-wallet-adapter/workflow';
import { skills } from '@solana-agent-wallet-adapter/workflow/dev';

import type { ParsedArgs } from './parseArgs.js';
import { isSubMinuteSchedule, previewNextRuns } from './schedule.js';

type SkillManifest = skills.SkillManifest;

const DRY_RUN_CLUSTER: WorkflowCluster = 'mainnet-beta';
const FORBIDDEN_AUTHORITY_KEYS = new Set(['delegatedSigner', 'privateKey', 'seedPhrase']);

export interface DryRunResult {
  installId: string;
  cluster: WorkflowCluster;
  approval: BuildApprovalResult;
}

export interface TestResult {
  ok: true;
  manifestId: string;
  manifestPath: string;
  nextRuns: string[];
  warnings: string[];
  dryRun: DryRunResult;
}

export interface ValidatedManifest {
  manifest: SkillManifest;
  manifestPath: string;
  dryRun: DryRunResult;
}

export async function runTest(parsed: ParsedArgs): Promise<TestResult> {
  const { manifest, manifestPath, dryRun } = await validateManifestForCli(parsed);
  const warnings: string[] = [];

  const now = new Date().toISOString();
  let nextRuns: string[] = [];
  try {
    nextRuns = previewNextRuns(manifest.schedule, now, 3);
    if (nextRuns.length === 0 && manifest.schedule.kind === 'cron') {
      warnings.push(
        `schedule.spec "${manifest.schedule.spec}" is a cron pattern this preview does not understand; runtime will still honor it.`,
      );
    }
    if (nextRuns.length === 0 && manifest.schedule.kind === 'price-trigger') {
      warnings.push('schedule.kind "price-trigger" fires on price events; no time preview.');
    }
  } catch (err: unknown) {
    throw new Error(`Schedule preview failed: ${(err as Error).message}`);
  }

  return {
    ok: true,
    manifestId: manifest.id,
    manifestPath,
    nextRuns,
    warnings,
    dryRun,
  };
}

export async function loadAndValidateManifest(parsed: ParsedArgs): Promise<SkillManifest> {
  return (await validateManifestForCli(parsed)).manifest;
}

export async function validateManifestForCli(parsed: ParsedArgs): Promise<ValidatedManifest> {
  const manifestPath = resolveManifestPath(parsed);
  const raw = await readManifest(manifestPath);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`Manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`);
  }

  assertNoForbiddenAuthority(parsedJson);
  const manifest = skills.validateSkillManifest(parsedJson);
  enforceCoherence(manifest);
  const dryRun = runDryRunExecutor(manifest);
  return { manifest, manifestPath, dryRun };
}

export function resolveManifestPath(parsed: ParsedArgs): string {
  return resolve(parsed.options.manifestPath ?? parsed.positionals[1] ?? 'manifest.json');
}

async function readManifest(manifestPath: string): Promise<string> {
  try {
    return await readFile(manifestPath, 'utf8');
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      throw new Error(
        `Manifest not found at ${manifestPath}. Run agentic-skill init <id> first, or pass --manifest <path>.`,
      );
    }
    throw err;
  }
}

function enforceCoherence(manifest: SkillManifest): void {
  const caps = manifest.caps;

  if (compareDecimalStrings(caps.perRunMaxAmount, caps.lifetimeMaxAmount) > 0) {
    throw new Error(
      `caps.perRunMaxAmount (${caps.perRunMaxAmount}) must be <= caps.lifetimeMaxAmount (${caps.lifetimeMaxAmount}).`,
    );
  }

  if (!Array.isArray(caps.allowlistedTokens) || caps.allowlistedTokens.length === 0) {
    throw new Error(
      'caps.allowlistedTokens must contain at least one entry. Add the token mint(s) this skill may transact in.',
    );
  }

  if (caps.maxExecutions !== undefined && caps.maxExecutions <= 0) {
    throw new Error('caps.maxExecutions must be > 0 when set.');
  }

  if (caps.expiresAt !== undefined) {
    const expiresAtMs = Date.parse(caps.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      throw new Error(`caps.expiresAt "${caps.expiresAt}" is not a valid ISO-8601 timestamp.`);
    }
    if (expiresAtMs <= Date.now()) {
      throw new Error(`caps.expiresAt "${caps.expiresAt}" is in the past.`);
    }
  }

  if (manifest.monetization) {
    if (
      !manifest.monetization.payoutWallet ||
      manifest.monetization.payoutWallet.trim().length === 0
    ) {
      throw new Error('monetization.payoutWallet is required when monetization is set.');
    }
  }

  if (manifest.action.connectorAction.trim().toUpperCase().includes('TODO')) {
    throw new Error('action.connectorAction still contains a TODO placeholder.');
  }

  if (/\bTODO\b/i.test(manifest.description)) {
    throw new Error('description still contains a TODO placeholder.');
  }

  if (isSubMinuteSchedule(manifest.schedule)) {
    throw new Error(
      `schedule.spec "${manifest.schedule.spec}" runs faster than once per minute; this is not allowed.`,
    );
  }
}

function runDryRunExecutor(manifest: SkillManifest): DryRunResult {
  const nowIso = new Date().toISOString();
  const install: SkillInstallRecord = {
    id: `dry_run_${manifest.id}`,
    walletAddress: manifest.authorWallet,
    skillId: manifest.id,
    manifestVersion: manifest.version,
    caps: manifest.caps,
    installedAt: nowIso,
    updatedAt: nowIso,
    status: 'active',
  };

  const bound = bindManifestParams({
    install,
    manifest,
    executionCount: 0,
    nowIso,
  });

  const capDecision = evaluateCaps({
    install,
    manifest,
    executionCount: 0,
    totalExecutedAmount: '0',
    now: new Date(nowIso),
    params: bound.params,
  });
  if (!capDecision.allowed) {
    throw new Error(
      `Dry-run cap evaluation rejected this manifest: ${capDecision.reason}. ` +
        'Ensure action.paramsTemplate declares an allowlisted token/mint and recipient caps match.',
    );
  }

  const approval = buildApprovalRequest({
    install,
    manifest,
    boundParams: bound.params,
    cluster: DRY_RUN_CLUSTER,
    nowIso,
  });

  return {
    installId: install.id,
    cluster: DRY_RUN_CLUSTER,
    approval,
  };
}

function assertNoForbiddenAuthority(node: unknown, path = '$'): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoForbiddenAuthority(item, `${path}[${index}]`));
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(key)) {
      throw new Error(`Skill manifest contains forbidden field at ${path}.${key}: ${key}`);
    }
    if (
      key === 'approvalAuthority' &&
      typeof value === 'string' &&
      value.trim().toLowerCase() === 'unlimited'
    ) {
      throw new Error(
        `Skill manifest contains forbidden authority at ${path}.${key}: approvalAuthority cannot be unlimited.`,
      );
    }
    assertNoForbiddenAuthority(value, `${path}.${key}`);
  }
}
