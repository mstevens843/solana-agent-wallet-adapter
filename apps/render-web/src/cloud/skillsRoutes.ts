import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  validateCreateRecurringRequest,
  WorkflowValidationError,
  type AuditActor,
  type AuditEventRecord,
  type CreateRecurringRequest,
  type JsonObject,
  type RecurringScheduleRecord,
  type WorkflowCluster,
} from '@solana-agent-wallet-adapter/workflow';
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';
import {
  nextCronFiringAfter,
  nextCronFiringBefore,
  parseCronSpec,
  parseIntervalSpec,
} from '@solana-agent-wallet-adapter/skills-runtime';

import {
  registerDevApiHandler,
  type DevApiHandler,
  type DevApiHandlerContext,
} from './devApiRegistry.js';
import { RecurringService, RecurringServiceError, type RecurringStore } from './recurringService.js';
import { recurringStoreAdapterForCloudStore } from './recurringRoutes.js';
import { WorkflowService } from './workflowService.js';
import {
  computeDecimalSplit,
  isPlatformFeeApplicable,
  loadTreasuryConfig,
  type SkillFeeSplitContext,
} from './treasuryConfig.js';
import {
  isSkrSkillBountyActive,
  readSkrDecimals,
  readSkrMint,
} from './skrConfig.js';
import {
  isAggregatorStore,
  isSkillsStore,
  type AggregatorStore,
  type SkillExecutionStoreRecord,
  type SkillsStore,
  type SkillInstallStoreRecord,
  type SkillManifestStoreRecord,
} from './store.js';
import { seedLaunchSkillsIfNeeded } from './launchSkillSeeder.js';
import {
  cloneSkillManifest,
  skillManifestHash,
  skillManifestHashForRecord,
} from './skillManifestIntegrity.js';
import { runSkillsExecuteTick } from './skillExecutorService.js';

type SkillManifest = DevLayer1.skills.SkillManifest;
type SkillCaps = DevLayer1.skills.SkillCaps;
type SkillInstallRecord = DevLayer1.skills.SkillInstallRecord;
type SkillInstallStatus = DevLayer1.skills.SkillInstallStatus;
type InstallRequest = {
  skillId: string;
  manifestVersion: string;
  caps: SkillCaps;
  acceptMonetization: boolean;
  installParams?: JsonObject;
};
interface SkillInstallListRow {
  install: SkillInstallRecord;
  manifest?: SkillManifest;
  recentExecutionCount: number;
  lastExecutionAt?: string;
  nextRunAt?: string;
  recurringScheduleStatus?: string;
}

const PREFIX = '/api/skills';
const MAX_JSON_BYTES = 64 * 1024;
const DEFAULT_MONETIZATION_TOKEN = 'USDC';
const USDC_DECIMALS = 6;

type MonetizationToken = 'USDC' | 'SKR';

function resolveMonetizationToken(monetization: { token?: string } | undefined): MonetizationToken {
  return (monetization?.token === 'SKR' ? 'SKR' : DEFAULT_MONETIZATION_TOKEN);
}

function resolveMonetizationDecimals(
  token: MonetizationToken,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (token === 'SKR') return readSkrDecimals(env) ?? 6;
  return USDC_DECIMALS;
}

/**
 * True when the platform fee should be waived for this install: author keeps
 * 100% on Android installs of $SKR-priced skills while the bootstrap window is
 * open. Gated on four conditions so any single signal can disable it without
 * code edits:
 *
 *   1. Caller is the Android-bundled client (`X-Agentic-Client` header).
 *   2. Skill is priced in $SKR (manifest monetization token).
 *   3. Deployment has $SKR support configured (`SKR_TOKEN_MINT`).
 *   4. Bounty window is open (`SKR_SKILL_BOUNTY_ACTIVE=true`).
 *
 * The same flags surface in `/api/android-config` so the Android UI can show
 * the bounty disclosure to authors and installers.
 */
function shouldApplyAndroidSkrBounty(
  req: IncomingMessage,
  monetizationToken: MonetizationToken,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (monetizationToken !== 'SKR') return false;
  const clientHeader = req.headers['x-agentic-client'];
  const client = (Array.isArray(clientHeader) ? clientHeader[0] : clientHeader)?.trim().toLowerCase();
  if (client !== 'android-bundled') return false;
  if (!readSkrMint(env)) return false;
  if (!isSkrSkillBountyActive(env)) return false;
  return true;
}
const DEFAULT_CLUSTER: WorkflowCluster = 'mainnet-beta';

const CATALOG_PATH = '/api/skills';
const MANIFESTS_PATH = '/api/skills/manifests';
const INSTALLS_PATH = '/api/skills/installs';
const PLATFORM_EARNINGS_PATH = '/api/skills/platform-earnings';
const AUTHOR_EARNINGS_RE = /^\/api\/skills\/authors\/([1-9A-HJ-NP-Za-km-z]{32,44})\/earnings$/;
const SKILL_DETAIL_RE = /^\/api\/skills\/([a-z0-9][a-z0-9-]{0,63})$/;
const INSTALL_PAUSE_RE = /^\/api\/skills\/installs\/([A-Za-z0-9_-]+)\/pause$/;
const INSTALL_RESUME_RE = /^\/api\/skills\/installs\/([A-Za-z0-9_-]+)\/resume$/;
const INSTALL_UNINSTALL_RE = /^\/api\/skills\/installs\/([A-Za-z0-9_-]+)\/uninstall$/;
const INSTALL_RUN_RE = /^\/api\/skills\/installs\/([A-Za-z0-9_-]+)\/run$/;

const FORBIDDEN_AUTHORITY_KEYS = new Set(['delegatedSigner', 'privateKey', 'seedPhrase']);
const INSTALL_PARAM_PLACEHOLDER_RE = /\{\{install\.([A-Za-z][A-Za-z0-9_]*)\}\}/g;
const INSTALL_PARAM_RECIPIENT_KEYS = new Set([
  'recipient',
  'to',
  'recipientAddress',
  'destinationAddress',
  'destinationRecipient',
]);

const RESERVED_PATHS = new Set<string>([CATALOG_PATH, MANIFESTS_PATH, INSTALLS_PATH, PLATFORM_EARNINGS_PATH]);

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

class SkillNotFoundError extends Error {
  readonly status = 404;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SkillNotFoundError';
  }
}

class SkillInvalidStateError extends Error {
  readonly status = 409;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SkillInvalidStateError';
  }
}

class SkillInternalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillInternalError';
  }
}

function requireSignedInWallet(
  res: ServerResponse,
  context: DevApiHandlerContext,
): context is DevApiHandlerContext & { walletAddress: string } {
  if (context.walletAddress) return true;
  writeJsonNoStore(res, 401, {
    error: 'auth_required',
    message: 'Sign in to Agentic Cloud with your wallet to use Skills.',
  });
  return false;
}

export async function handleSkillsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: DevApiHandlerContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'GET') {
    if (path === CATALOG_PATH) {
      await handleListCatalog(req, res, url, context);
      return true;
    }
    if (path === INSTALLS_PATH) {
      await handleListInstalls(req, res, context);
      return true;
    }
    if (path === PLATFORM_EARNINGS_PATH) {
      await handlePlatformEarnings(res, context);
      return true;
    }
    const earningsMatch = AUTHOR_EARNINGS_RE.exec(path);
    if (earningsMatch) {
      const authorWallet = earningsMatch[1];
      if (typeof authorWallet === 'string') {
        await handleAuthorEarnings(res, context, authorWallet);
        return true;
      }
    }
    const detailMatch = SKILL_DETAIL_RE.exec(path);
    if (detailMatch) {
      const skillId = detailMatch[1];
      if (typeof skillId === 'string' && !RESERVED_PATHS.has(path)) {
        await handleSkillDetail(req, res, context, skillId);
        return true;
      }
    }
    return false;
  }

  if (method === 'POST') {
    if (path === MANIFESTS_PATH) {
      await handlePublishManifest(req, res, context);
      return true;
    }
    if (path === INSTALLS_PATH) {
      await handleInstall(req, res, context);
      return true;
    }
    const pauseMatch = INSTALL_PAUSE_RE.exec(path);
    if (pauseMatch) {
      const installId = pauseMatch[1];
      if (typeof installId === 'string') {
        await handleInstallTransition(req, res, context, installId, 'pause');
        return true;
      }
    }
    const resumeMatch = INSTALL_RESUME_RE.exec(path);
    if (resumeMatch) {
      const installId = resumeMatch[1];
      if (typeof installId === 'string') {
        await handleInstallTransition(req, res, context, installId, 'resume');
        return true;
      }
    }
    const uninstallMatch = INSTALL_UNINSTALL_RE.exec(path);
    if (uninstallMatch) {
      const installId = uninstallMatch[1];
      if (typeof installId === 'string') {
        await handleInstallTransition(req, res, context, installId, 'uninstall');
        return true;
      }
    }
    const runMatch = INSTALL_RUN_RE.exec(path);
    if (runMatch) {
      const installId = runMatch[1];
      if (typeof installId === 'string') {
        await handleInstallRunNow(res, context, installId);
        return true;
      }
    }
    return false;
  }

  return false;
}

async function handleListCatalog(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: DevApiHandlerContext,
): Promise<void> {
  try {
    const store = requireSkillsStore(context);
    await seedLaunchSkillsIfNeeded(store, context.clock);
    const authorWallet = url.searchParams.get('author')?.trim();
    const records = (await store.listSkillManifests())
      .filter((record) => !authorWallet || record.authorWallet === authorWallet);
    const treasury = loadTreasuryConfig();
    writeJsonNoStore(res, 200, {
      skills: records.map((r) => r.manifest as SkillManifest),
      treasuryActive: Boolean(treasury.wallet),
      platformFeeBps: treasury.wallet ? treasury.feeBps : 0,
    });
  } catch (err) {
    writeSkillsError(res, err);
  }
}

async function handleSkillDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
  skillId: string,
): Promise<void> {
  try {
    const store = requireSkillsStore(context);
    await seedLaunchSkillsIfNeeded(store, context.clock);
    const record = await store.getSkillManifest(skillId);
    if (!record) {
      writeJsonNoStore(res, 404, {
        error: 'skill_not_found',
        message: `No skill manifest found for id ${skillId}.`,
      });
      return;
    }
    let stats: JsonObject | null = null;
    const aggregator = getAggregatorStore(context);
    if (aggregator) {
      const snapshot = await aggregator.getAggregatorSnapshot(`skill:${skillId}`);
      if (snapshot) stats = snapshot.snapshot as JsonObject;
    }
    writeJsonNoStore(res, 200, {
      skill: record.manifest as SkillManifest,
      stats,
    });
  } catch (err) {
    writeSkillsError(res, err);
  }
}

async function handlePublishManifest(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  if (!requireSignedInWallet(res, context)) return;
  try {
    const body = await readJsonBody(req);
    assertNoForbiddenAuthority(body);
    const manifest = DevLayer1.skills.validateSkillManifest(body);
    if (manifest.authorWallet !== context.walletAddress) {
      writeJsonNoStore(res, 403, {
        error: 'author_mismatch',
        message: 'authorWallet must match the connected wallet.',
      });
      return;
    }
    const store = requireSkillsStore(context);
    const manifestHash = skillManifestHash(manifest);
    const existing = await store.getSkillManifest(manifest.id);
    if (existing && existing.version === manifest.version) {
      const existingHash = skillManifestHashForRecord(existing);
      if (existingHash !== manifestHash) {
        throw new SkillInvalidStateError(
          'manifest_version_conflict',
          `Skill ${manifest.id}@${manifest.version} already exists with a different manifest body. Publish a new version.`,
        );
      }
    }
    const nowIso = context.clock.now().toISOString();
    const record: SkillManifestStoreRecord = {
      id: manifest.id,
      version: manifest.version,
      authorWallet: manifest.authorWallet,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      manifest: cloneSkillManifest(manifest),
      manifestHash,
    };
    await store.saveSkillManifest(record);
    await appendSkillsAuditEvent(context, 'user', 'skills.manifest.published', {
      skillId: manifest.id,
      version: manifest.version,
      authorWallet: manifest.authorWallet,
      category: manifest.category,
      manifestHash,
    }, 'skill_manifest', manifest.id);
    writeJsonNoStore(res, 201, { skill: manifest, manifestHash });
  } catch (err) {
    writeSkillsError(res, err);
  }
}

async function handleInstall(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  if (!requireSignedInWallet(res, context)) return;
  try {
    const body = await readJsonBody(req);
    assertNoForbiddenAuthority(body);
    const request = parseInstallRequest(body);
    const store = requireSkillsStore(context);
    await seedLaunchSkillsIfNeeded(store, context.clock);
    const manifestRecord = await store.getSkillManifest(request.skillId);
    if (!manifestRecord) {
      throw new SkillNotFoundError('skill_not_found', `No skill manifest found for id ${request.skillId}.`);
    }
    const manifest = manifestRecord.manifest as SkillManifest;
    const manifestHash = skillManifestHashForRecord(manifestRecord);
    if (request.manifestVersion !== manifest.version) {
      throw new WorkflowValidationError(
        'manifest_version_mismatch',
        `Requested manifest version ${request.manifestVersion} does not match current version ${manifest.version}.`,
        '$.manifestVersion',
      );
    }
    const installParams = validateInstallParamsForManifest(manifest, request.installParams);
    const tightenedCaps = addInstallParamRecipientCaps(
      tightenAndValidateCaps(manifest.caps, request.caps),
      installParams,
    );

    const existing = await store.listSkillInstallsForWallet(context.walletAddress);
    if (existing.some((r) => r.skillId === manifest.id && r.status !== 'revoked')) {
      throw new SkillInvalidStateError(
        'already_installed',
        'You already have an active install of this skill. Uninstall it first to re-install.',
      );
    }

    const installId = `skill_install_${randomUUID()}`;
    const installedAt = context.clock.now().toISOString();
    let monetizationScheduleId: string | undefined;
    let oneTimeApprovalId: string | undefined;
    let performanceFeeDeferred = false;
    let monetizationSplitSnapshot: JsonObject | undefined;
    let monetizationBounty: { program: string; token: MonetizationToken } | undefined;
    if (manifest.monetization) {
      if (!request.acceptMonetization) {
        throw new WorkflowValidationError(
          'monetization_required',
          'This skill requires accepting its creator monetization terms before install.',
          '$.acceptMonetization',
        );
      }
      const monetization = manifest.monetization;
      const treasury = loadTreasuryConfig();
      const splitContext = isPlatformFeeApplicable(treasury, monetization.payoutWallet);
      const monetizationToken = resolveMonetizationToken(monetization);
      // Fail-closed when a manifest is priced in $SKR but the deployment has no
      // SKR_TOKEN_MINT configured. Without this guard, the install would
      // succeed and create a recurring schedule that silently fails at
      // execution time (rejected by isSupportedCloudTransferToken). Surface
      // it now so the installer sees a clear, actionable error.
      if (monetizationToken === 'SKR' && !readSkrMint()) {
        throw new WorkflowValidationError(
          'skr_not_configured',
          'This skill is priced in $SKR but the server is not configured for SKR settlement on this deployment.',
          '$.monetization.token',
        );
      }
      const monetizationDecimals = resolveMonetizationDecimals(monetizationToken);
      const bountyApplies = shouldApplyAndroidSkrBounty(req, monetizationToken);
      // When the bounty waives the platform fee we skip the split entirely so
      // the author receives 100% of the user's payment; recorded on the install
      // metadata so settlement & audits can reconcile against the bounty window.
      const effectiveSplitContext = bountyApplies ? null : splitContext;
      if (bountyApplies) {
        monetizationBounty = { program: 'android_skr_v1', token: monetizationToken };
      }

      if (monetization.kind === 'monthly') {
        if (!monetization.amount) {
          throw new WorkflowValidationError(
            'invalid_monetization',
            'Monthly skill monetization requires an amount.',
            '$.monetization.amount',
          );
        }
        const split = effectiveSplitContext
          ? computeDecimalSplit(monetization.amount, effectiveSplitContext.feeBps, monetizationDecimals)
          : null;
        const authorAmount = split?.authorAmount ?? monetization.amount;
        const platformMetadata = split && effectiveSplitContext && split.treasuryAmount !== '0'
          ? {
              platformWallet: effectiveSplitContext.treasuryWallet,
              platformAmount: split.treasuryAmount,
              totalAmount: monetization.amount,
              platformFeeBps: effectiveSplitContext.feeBps,
            }
          : null;
        if (platformMetadata) monetizationSplitSnapshot = { ...platformMetadata };
        const recurring = makeRecurringService(context);
        const cadenceRequest = validateCreateRecurringRequest({
          cluster: DEFAULT_CLUSTER,
          token: monetizationToken,
          amount: authorAmount,
          cadence: 'monthly',
          dayOfMonth: new Date(installedAt).getUTCDate(),
          localTime: utcLocalTime(installedAt),
          recipient: monetization.payoutWallet,
          memo: `Author fee: ${manifest.name} v${manifest.version}`,
          note: `Skill install ${installId}`,
          metadata: {
            source: 'skill_install_monetization',
            skillInstallId: installId,
            skillId: manifest.id,
            monetizationKind: monetization.kind,
            monetizationToken,
            ...(bountyApplies ? { bountyApplied: true, bountyProgram: 'android_skr_v1' } : {}),
            ...(platformMetadata ?? {}),
          },
          ...(manifest.caps.expiresAt ? { expiresAt: manifest.caps.expiresAt } : {}),
        } satisfies CreateRecurringRequest);
        const schedule = await recurring.createSchedule(
          { walletAddress: context.walletAddress },
          cadenceRequest,
        );
        monetizationScheduleId = schedule.id;
      } else if (monetization.kind === 'one-time') {
        if (!monetization.amount) {
          throw new WorkflowValidationError(
            'invalid_monetization',
            'One-time skill monetization requires an amount.',
            '$.monetization.amount',
          );
        }
        const split = effectiveSplitContext
          ? computeDecimalSplit(monetization.amount, effectiveSplitContext.feeBps, monetizationDecimals)
          : null;
        const useSplit = Boolean(split && effectiveSplitContext && split.treasuryAmount !== '0');
        const authorAmount = useSplit ? (split as { authorAmount: string }).authorAmount : monetization.amount;
        const platformMetadata = useSplit && split && effectiveSplitContext
          ? {
              platformWallet: effectiveSplitContext.treasuryWallet,
              platformAmount: split.treasuryAmount,
              totalAmount: monetization.amount,
              platformFeeBps: effectiveSplitContext.feeBps,
            }
          : null;
        if (platformMetadata) monetizationSplitSnapshot = { ...platformMetadata };
        const workflowService = new WorkflowService(context.workflowStore);
        const session = { walletAddress: context.walletAddress };
        const memo = `One-time author fee: ${manifest.name} v${manifest.version}`;
        const approvalMetadata: JsonObject = {
          source: 'skill_install_monetization',
          skillInstallId: installId,
          skillId: manifest.id,
          monetizationKind: monetization.kind,
          monetizationToken,
          ...(bountyApplies ? { bountyApplied: true, bountyProgram: 'android_skr_v1' } : {}),
          ...(platformMetadata ?? {}),
        };
        const approval = useSplit && split && effectiveSplitContext
          ? await workflowService.createApproval(session, {
              kind: 'skill_fee_split',
              cluster: DEFAULT_CLUSTER,
              summary: `Pay ${manifest.name} v${manifest.version}: author + Agentic`,
              dueAt: installedAt,
              amount: monetization.amount,
              token: monetizationToken,
              recipient: monetization.payoutWallet,
              params: {
                token: monetizationToken,
                authorRecipient: monetization.payoutWallet,
                authorAmount,
                treasuryRecipient: effectiveSplitContext.treasuryWallet,
                treasuryAmount: split.treasuryAmount,
                memo,
              },
              metadata: approvalMetadata,
              note: `Skill install ${installId}`,
            })
          : await workflowService.createApproval(session, {
              kind: 'transfer_spl',
              cluster: DEFAULT_CLUSTER,
              summary: `One-time author fee: ${manifest.name} v${manifest.version}`,
              dueAt: installedAt,
              amount: monetization.amount,
              token: monetizationToken,
              recipient: monetization.payoutWallet,
              params: {
                token: monetizationToken,
                recipient: monetization.payoutWallet,
                amount: monetization.amount,
                memo,
              },
              metadata: approvalMetadata,
              note: `Skill install ${installId}`,
            });
        oneTimeApprovalId = approval.id;
      } else if (monetization.kind === 'performance-fee') {
        if (typeof monetization.feePercent !== 'number') {
          throw new WorkflowValidationError(
            'invalid_monetization',
            'Performance-fee skill monetization requires a feePercent.',
            '$.monetization.feePercent',
          );
        }
        // Schema accepted; settlement infrastructure (profit measurement,
        // periodic claim) is not yet implemented. The install record carries
        // performanceFeeDeferred=true so the UI can surface a banner and
        // future settlement work can pick these up.
        performanceFeeDeferred = true;
      }
    }

    const installMetadata: JsonObject = {
      manifestSnapshot: cloneSkillManifest(manifest) as unknown as JsonObject,
      manifestHash,
      manifestVersion: manifest.version,
      capsSnapshot: tightenedCaps as unknown as JsonObject,
      ...(installParams ? { installParams } : {}),
      ...(oneTimeApprovalId ? { oneTimeApprovalId } : {}),
      ...(performanceFeeDeferred ? { performanceFeeDeferred: true } : {}),
      ...(monetizationSplitSnapshot ? { monetizationSplit: monetizationSplitSnapshot } : {}),
      ...(monetizationBounty ? { monetizationBounty } : {}),
    };
    const installRecord: SkillInstallRecord = {
      id: installId,
      walletAddress: context.walletAddress,
      skillId: manifest.id,
      manifestVersion: request.manifestVersion,
      caps: tightenedCaps,
      installedAt,
      updatedAt: installedAt,
      status: 'active',
      ...(monetizationScheduleId ? { monetizationScheduleId } : {}),
      metadata: installMetadata,
    };
    const storeRecord: SkillInstallStoreRecord = {
      id: installRecord.id,
      walletAddress: installRecord.walletAddress,
      skillId: installRecord.skillId,
      status: installRecord.status,
      installedAt: installRecord.installedAt,
      updatedAt: installRecord.updatedAt,
      install: installRecord,
    };
    await store.saveSkillInstall(storeRecord);
    await appendSkillsAuditEvent(context, 'user', 'skills.install.created', {
      installId: installRecord.id,
      skillId: manifest.id,
      manifestVersion: request.manifestVersion,
      manifestHash,
      monetizationKind: manifest.monetization?.kind ?? 'none',
      ...(manifest.monetization ? { monetizationToken: resolveMonetizationToken(manifest.monetization) } : {}),
      acceptMonetization: request.acceptMonetization,
      installParamKeys: installParams ? Object.keys(installParams).sort() : [],
      ...(monetizationScheduleId ? { monetizationScheduleId } : {}),
      ...(oneTimeApprovalId ? { oneTimeApprovalId } : {}),
      ...(performanceFeeDeferred ? { performanceFeeDeferred: true } : {}),
      ...(monetizationSplitSnapshot ? { platformFeeActive: true } : {}),
      ...(monetizationBounty ? { bountyApplied: true, bountyProgram: monetizationBounty.program } : {}),
    }, 'skill_install', installRecord.id);
    writeJsonNoStore(res, 201, { install: installRecord });
  } catch (err) {
    writeSkillsError(res, err);
  }
}

async function handleListInstalls(
  _req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  if (!requireSignedInWallet(res, context)) return;
  try {
    const store = requireSkillsStore(context);
    const records = await store.listSkillInstallsForWallet(context.walletAddress);
    const installRows = await buildInstallRows(records, store, context);
    writeJsonNoStore(res, 200, {
      installs: records.map((r) => r.install as SkillInstallRecord),
      installRows,
    });
  } catch (err) {
    writeSkillsError(res, err);
  }
}

async function buildInstallRows(
  records: readonly SkillInstallStoreRecord[],
  store: SkillsStore,
  context: DevApiHandlerContext,
): Promise<SkillInstallListRow[]> {
  const now = context.clock.now();
  const recurringStore = resolveRecurringStore(context);
  return Promise.all(records
    .filter((record) => record.status !== 'revoked')
    .map(async (record) => {
      const install = record.install as SkillInstallRecord;
      const [manifestRecord, executions] = await Promise.all([
        store.getSkillManifest(record.skillId),
        store.listSkillExecutionsByInstall(record.id),
      ]);
      const manifest = manifestRecord?.manifest as SkillManifest | undefined;
      const lastExecutionAt = latestExecutionAt(executions);
      const row: SkillInstallListRow = {
        install,
        recentExecutionCount: recentExecutionCount(executions, now),
        ...(manifest ? { manifest } : {}),
        ...(lastExecutionAt ? { lastExecutionAt } : {}),
      };
      const nextRunAt = manifest ? nextRunAtForInstall(install, manifest, lastExecutionAt, now) : undefined;
      if (nextRunAt) row.nextRunAt = nextRunAt;
      if (install.monetizationScheduleId) {
        const schedule = await recurringStore.getSchedule(
          install.walletAddress,
          install.monetizationScheduleId,
        );
        if (schedule?.status) row.recurringScheduleStatus = schedule.status;
      }
      return row;
    }));
}

function recentExecutionCount(
  executions: readonly SkillExecutionStoreRecord[],
  now: Date,
): number {
  const sinceMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  return executions.filter((execution) => {
    const proposedMs = Date.parse(execution.proposedAt);
    return Number.isFinite(proposedMs) && proposedMs >= sinceMs && proposedMs <= now.getTime();
  }).length;
}

function latestExecutionAt(executions: readonly SkillExecutionStoreRecord[]): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const execution of executions) {
    const proposedMs = Date.parse(execution.proposedAt);
    if (Number.isFinite(proposedMs) && proposedMs > latestMs) {
      latestMs = proposedMs;
      latest = execution.proposedAt;
    }
  }
  return latest;
}

function nextRunAtForInstall(
  install: SkillInstallRecord,
  manifest: SkillManifest,
  lastExecutionAt: string | undefined,
  now: Date,
): string | undefined {
  if (install.status !== 'active') return undefined;
  if (install.caps.expiresAt && Date.parse(install.caps.expiresAt) <= now.getTime()) return undefined;
  if (manifest.schedule.kind === 'interval') {
    const intervalMs = parseIntervalSpec(manifest.schedule.spec);
    if (typeof intervalMs !== 'number') return undefined;
    const startMs = lastExecutionAt
      ? Date.parse(lastExecutionAt)
      : Date.parse(install.installedAt);
    if (!Number.isFinite(startMs)) return undefined;
    const nextMs = startMs + intervalMs;
    return new Date(Math.max(nextMs, now.getTime())).toISOString();
  }
  if (manifest.schedule.kind === 'cron') {
    const parsed = parseCronSpec(manifest.schedule.spec);
    if ('error' in parsed) return undefined;
    const previous = nextCronFiringBefore(parsed, now);
    const lastMs = lastExecutionAt ? Date.parse(lastExecutionAt) : undefined;
    const installedMs = Date.parse(install.installedAt);
    if (
      previous &&
      (
        (Number.isFinite(lastMs) && previous.getTime() > (lastMs as number)) ||
        (!lastExecutionAt && Number.isFinite(installedMs) && previous.getTime() >= installedMs)
      )
    ) {
      return now.toISOString();
    }
    return nextCronFiringAfter(parsed, now)?.toISOString();
  }
  return undefined;
}

function getAuthorEarningsSkillId(
  schedule: RecurringScheduleRecord,
  authorWallet: string,
): string | null {
  // Known limit (skr-earnings): The earnings response aggregates a single USDC
  // run-rate today, so $SKR-priced subscriptions are intentionally skipped
  // here rather than mis-summed across currencies. A follow-up should split
  // the response into per-token buckets (USDC monthly total + SKR monthly
  // total) and update this filter to accept both. See plan section P3.7.
  if (
    schedule.status !== 'active' ||
    schedule.cadence !== 'monthly' ||
    schedule.token !== DEFAULT_MONETIZATION_TOKEN ||
    schedule.recipient !== authorWallet ||
    !isDecimalAmount(schedule.amount)
  ) {
    return null;
  }
  const metadata = schedule.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  if (metadata.source !== 'skill_install_monetization') return null;
  const skillId = metadata.skillId;
  return typeof skillId === 'string' && skillId.trim() ? skillId.trim() : null;
}

function sumDecimalAmounts(a: string, b: string): string {
  if (!isDecimalAmount(a) || !isDecimalAmount(b)) return a;
  const decimals = Math.max(decimalScale(a), decimalScale(b));
  return unscaleDecimalAmount(scaleDecimalAmount(a, decimals) + scaleDecimalAmount(b, decimals), decimals);
}

function isDecimalAmount(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value);
}

function decimalScale(value: string): number {
  return value.includes('.') ? (value.split('.')[1] ?? '').length : 0;
}

function scaleDecimalAmount(value: string, decimals: number): bigint {
  const [intPart, fracPart = ''] = value.split('.');
  const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
  return BigInt((intPart ?? '0') + padded);
}

function unscaleDecimalAmount(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const raw = value.toString().padStart(decimals + 1, '0');
  const intPart = raw.slice(0, -decimals);
  const fracPart = raw.slice(-decimals).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/**
 * GET /api/skills/platform-earnings — treasury-only.
 *
 * Aggregates `metadata.platformAmount` across recurring schedules tagged
 * with `source = 'skill_install_monetization'` AND `platformWallet =
 * configured treasury wallet`. This is *only* the platform's 15% portion;
 * for the author's 85% take-home, see `handleAuthorEarnings`. The two
 * endpoints intentionally read different fields because the recurring
 * schedule stores the author portion in `schedule.amount` and the platform
 * portion in `metadata.platformAmount` — see the comment on
 * `recurringApprovalSink.ts` for the full semantic.
 */
async function handlePlatformEarnings(
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  if (!requireSignedInWallet(res, context)) return;
  const treasury = loadTreasuryConfig();
  if (!treasury.wallet) {
    writeJsonNoStore(res, 503, {
      error: 'treasury_not_configured',
      message: 'TREASURY_WALLET is not configured on this deployment; platform earnings are disabled.',
    });
    return;
  }
  if (context.walletAddress !== treasury.wallet) {
    writeJsonNoStore(res, 403, {
      error: 'treasury_mismatch',
      message: 'Platform earnings can only be read by the configured treasury wallet.',
    });
    return;
  }

  try {
    const recurringStore = resolveRecurringStore(context);
    if (!recurringStore.listKnownWallets) {
      throw new SkillInternalError('Recurring store cannot enumerate wallets for platform earnings.');
    }

    const bySkill = new Map<string, { monthlyUsdc: string; activeSubscriptions: number }>();
    for (const wallet of await recurringStore.listKnownWallets()) {
      const schedules = await recurringStore.listSchedules(wallet);
      for (const schedule of schedules) {
        const skillId = getPlatformEarningsSkillId(schedule, treasury.wallet);
        if (!skillId) continue;
        const platformAmount = stringValue(schedule.metadata?.platformAmount);
        if (!platformAmount || !isNonNegativeDecimalString(platformAmount)) continue;
        const current = bySkill.get(skillId) ?? { monthlyUsdc: '0', activeSubscriptions: 0 };
        bySkill.set(skillId, {
          monthlyUsdc: addDecimalStrings(current.monthlyUsdc, platformAmount),
          activeSubscriptions: current.activeSubscriptions + 1,
        });
      }
    }

    const skills = [...bySkill.entries()]
      .map(([skillId, row]) => ({ skillId, ...row }))
      .sort((a, b) => a.skillId.localeCompare(b.skillId));
    const totalMonthlyUsdc = skills.reduce(
      (total, row) => addDecimalStrings(total, row.monthlyUsdc),
      '0',
    );

    writeJsonNoStore(res, 200, {
      treasuryWallet: treasury.wallet,
      platformFeeBps: treasury.feeBps,
      currency: DEFAULT_MONETIZATION_TOKEN,
      totalMonthlyUsdc,
      skills,
    });
  } catch (err) {
    writeSkillsError(res, err);
  }
}

function getPlatformEarningsSkillId(
  schedule: RecurringScheduleRecord,
  treasuryWallet: string,
): string | null {
  // Known limit (skr-earnings): $SKR-priced installs in the bounty window route 100%
  // to the author (treasury wallet receives nothing), so this aggregator
  // would have nothing to count even if it accepted SKR — keep USDC-only
  // until per-token reporting is added. See plan section P3.7.
  if (
    schedule.status !== 'active' ||
    schedule.cadence !== 'monthly' ||
    schedule.token !== DEFAULT_MONETIZATION_TOKEN
  ) {
    return null;
  }
  const metadata = schedule.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  if (metadata.source !== 'skill_install_monetization') return null;
  if (stringValue(metadata.platformWallet) !== treasuryWallet) return null;
  const skillId = metadata.skillId;
  return typeof skillId === 'string' && skillId.trim() ? skillId.trim() : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * GET /api/skills/authors/:wallet/earnings — author-only.
 *
 * Aggregates `schedule.amount` across recurring schedules where
 * `recipient = author wallet` and `source = 'skill_install_monetization'`.
 * When TREASURY_WALLET is configured, `schedule.amount` is the *author
 * portion only* (e.g. $8.50 of a $10/mo subscription); platform's $1.50
 * cut lives in `metadata.platformAmount` and is reported by
 * `handlePlatformEarnings`. The asymmetry is intentional — each endpoint
 * reports take-home for its respective recipient.
 */
async function handleAuthorEarnings(
  res: ServerResponse,
  context: DevApiHandlerContext,
  authorWallet: string,
): Promise<void> {
  if (!requireSignedInWallet(res, context)) return;
  if (context.walletAddress !== authorWallet) {
    writeJsonNoStore(res, 403, {
      error: 'author_mismatch',
      message: 'Author earnings can only be read by the connected author wallet.',
    });
    return;
  }

  try {
    const recurringStore = resolveRecurringStore(context);
    if (!recurringStore.listKnownWallets) {
      throw new SkillInternalError('Recurring store cannot enumerate wallets for author earnings.');
    }

    const bySkill = new Map<string, { monthlyUsdc: string; activeSubscriptions: number }>();
    for (const wallet of await recurringStore.listKnownWallets()) {
      const schedules = await recurringStore.listSchedules(wallet);
      for (const schedule of schedules) {
        const skillId = getAuthorEarningsSkillId(schedule, authorWallet);
        if (!skillId) continue;
        const current = bySkill.get(skillId) ?? { monthlyUsdc: '0', activeSubscriptions: 0 };
        bySkill.set(skillId, {
          monthlyUsdc: sumDecimalAmounts(current.monthlyUsdc, schedule.amount),
          activeSubscriptions: current.activeSubscriptions + 1,
        });
      }
    }

    const skills = [...bySkill.entries()]
      .map(([skillId, row]) => ({ skillId, ...row }))
      .sort((a, b) => a.skillId.localeCompare(b.skillId));
    const totalMonthlyUsdc = skills.reduce(
      (total, row) => sumDecimalAmounts(total, row.monthlyUsdc),
      '0',
    );

    writeJsonNoStore(res, 200, {
      authorWallet,
      currency: DEFAULT_MONETIZATION_TOKEN,
      totalMonthlyUsdc,
      skills,
    });
  } catch (err) {
    writeSkillsError(res, err);
  }
}

type InstallAction = 'pause' | 'resume' | 'uninstall';

async function handleInstallTransition(
  _req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
  installId: string,
  action: InstallAction,
): Promise<void> {
  if (!requireSignedInWallet(res, context)) return;
  try {
    const store = requireSkillsStore(context);
    const existing = await store.getSkillInstall(installId);
    if (!existing || existing.walletAddress !== context.walletAddress) {
      writeJsonNoStore(res, 404, {
        error: 'install_not_found',
        message: `No install found for id ${installId}.`,
      });
      return;
    }
    const currentInstall = existing.install as SkillInstallRecord;
    const nextStatus = nextStatusForAction(action, currentInstall.status);

    if (currentInstall.monetizationScheduleId) {
      const recurring = makeRecurringService(context);
      if (action === 'pause' || action === 'uninstall') {
        await recurring.pauseSchedule(
          { walletAddress: context.walletAddress },
          currentInstall.monetizationScheduleId,
        );
      } else if (action === 'resume') {
        await recurring.resumeSchedule(
          { walletAddress: context.walletAddress },
          currentInstall.monetizationScheduleId,
        );
      }
    }

    const nowIso = context.clock.now().toISOString();
    const updatedInstall: SkillInstallRecord = {
      ...currentInstall,
      status: nextStatus,
      updatedAt: nowIso,
    };
    await store.saveSkillInstall({
      id: existing.id,
      walletAddress: existing.walletAddress,
      skillId: existing.skillId,
      status: nextStatus,
      installedAt: existing.installedAt,
      updatedAt: nowIso,
      install: updatedInstall,
    });
    const eventType =
      action === 'uninstall'
        ? 'skills.install.uninstalled'
        : action === 'pause'
          ? 'skills.install.paused'
          : 'skills.install.resumed';
    await appendSkillsAuditEvent(context, 'user', eventType, {
      installId,
      skillId: existing.skillId,
      previousStatus: currentInstall.status,
      newStatus: nextStatus,
      ...(currentInstall.monetizationScheduleId
        ? { monetizationScheduleId: currentInstall.monetizationScheduleId }
        : {}),
    }, 'skill_install', installId);
    writeJsonNoStore(res, 200, { install: updatedInstall });
  } catch (err) {
    writeSkillsError(res, err);
  }
}

async function handleInstallRunNow(
  res: ServerResponse,
  context: DevApiHandlerContext,
  installId: string,
): Promise<void> {
  if (!requireSignedInWallet(res, context)) return;
  try {
    const store = requireSkillsStore(context);
    const existing = await store.getSkillInstall(installId);
    if (!existing || existing.walletAddress !== context.walletAddress) {
      writeJsonNoStore(res, 404, {
        error: 'install_not_found',
        message: `No install found for id ${installId}.`,
      });
      return;
    }
    const install = existing.install as SkillInstallRecord;
    if (install.status !== 'active') {
      throw new SkillInvalidStateError(
        'invalid_state',
        `Install must be active to run now (current status: ${install.status}).`,
      );
    }

    const before = await store.listSkillExecutionsByInstall(installId);
    const pending = before.find((execution) => execution.result === 'pending' && execution.approvalRequestId);
    if (pending) {
      writeJsonNoStore(res, 409, {
        error: 'pending_execution',
        message: 'This skill already has a pending Needs Approval item. Approve or reject it before running again.',
        approvalRequestId: pending.approvalRequestId,
      });
      return;
    }

    const beforeIds = new Set(before.map((execution) => execution.id));
    const result = await runSkillsExecuteTick({
      store: context.workflowStore,
      clock: context.clock,
      workflowService: context.workflowService,
      installId,
      walletAddress: context.walletAddress,
      forceSchedule: true,
    });
    const after = await store.listSkillExecutionsByInstall(installId);
    const created = after
      .filter((execution) => !beforeIds.has(execution.id))
      .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt))[0];
    if (!created || result.proposed !== 1 || !created.approvalRequestId) {
      writeJsonNoStore(res, 409, {
        error: 'run_not_proposed',
        message: 'The skill could not create a Needs Approval item. Check caps, expiry, and manifest settings.',
        result,
      });
      return;
    }

    writeJsonNoStore(res, 201, {
      ok: true,
      result,
      approvalRequestId: created.approvalRequestId,
      execution: created.execution,
    });
  } catch (err) {
    writeSkillsError(res, err);
  }
}

function nextStatusForAction(action: InstallAction, current: SkillInstallStatus): SkillInstallStatus {
  switch (action) {
    case 'pause':
      if (current !== 'active') {
        throw new SkillInvalidStateError(
          'invalid_state',
          `Install must be active to pause (current status: ${current}).`,
        );
      }
      return 'paused';
    case 'resume':
      if (current !== 'paused') {
        throw new SkillInvalidStateError(
          'invalid_state',
          `Install must be paused to resume (current status: ${current}).`,
        );
      }
      return 'active';
    case 'uninstall':
      if (current === 'revoked') {
        throw new SkillInvalidStateError('invalid_state', 'Install is already revoked.');
      }
      return 'revoked';
  }
}

function requireSkillsStore(context: DevApiHandlerContext): SkillsStore {
  if (!isSkillsStore(context.workflowStore)) {
    throw new SkillInternalError('Skills store is not available on this workflow store.');
  }
  return context.workflowStore as unknown as SkillsStore;
}

function getAggregatorStore(context: DevApiHandlerContext): AggregatorStore | null {
  if (!isAggregatorStore(context.workflowStore)) return null;
  return context.workflowStore as unknown as AggregatorStore;
}

function makeRecurringService(context: DevApiHandlerContext): RecurringService {
  const recurringStore = resolveRecurringStore(context);
  return new RecurringService(recurringStore, {
    clock: () => context.clock.now(),
  });
}

function resolveRecurringStore(context: DevApiHandlerContext): RecurringStore {
  return isRecurringStore(context.workflowStore)
    ? context.workflowStore
    : recurringStoreAdapterForCloudStore(context.workflowStore);
}

function isRecurringStore(value: unknown): value is RecurringStore {
  return Boolean(value)
    && typeof (value as RecurringStore).listSchedules === 'function'
    && typeof (value as RecurringStore).getSchedule === 'function'
    && typeof (value as RecurringStore).saveSchedule === 'function';
}

function parseInstallRequest(input: unknown): InstallRequest {
  const request = DevLayer1.skills.validateInstallSkillRequest(input);
  const record = input as Record<string, unknown>;
  const installParams = parseInstallParams(record.installParams, '$.installParams');
  const baseRequest: InstallRequest = {
    skillId: request.skillId,
    manifestVersion: request.manifestVersion,
    caps: request.caps,
    acceptMonetization: request.acceptMonetization,
  };
  return installParams
    ? { ...baseRequest, installParams }
    : baseRequest;
}

function parseInstallParams(input: unknown, path: string): JsonObject | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkflowValidationError(
      'invalid_install_params',
      'installParams must be a JSON object of non-empty string values.',
      path,
    );
  }
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      throw new WorkflowValidationError(
        'invalid_install_params',
        `installParams key "${key}" must be an identifier.`,
        `${path}.${key}`,
      );
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new WorkflowValidationError(
        'invalid_install_params',
        `installParams.${key} must be a non-empty string.`,
        `${path}.${key}`,
      );
    }
    out[key] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function tightenAndValidateCaps(manifestCaps: SkillCaps, userCaps: SkillCaps): SkillCaps {
  if (decimalGreater(userCaps.perRunMaxAmount, manifestCaps.perRunMaxAmount)) {
    throw new WorkflowValidationError(
      'caps_too_loose',
      `caps.perRunMaxAmount (${userCaps.perRunMaxAmount}) exceeds manifest cap (${manifestCaps.perRunMaxAmount}).`,
      '$.caps.perRunMaxAmount',
    );
  }
  if (decimalGreater(userCaps.lifetimeMaxAmount, manifestCaps.lifetimeMaxAmount)) {
    throw new WorkflowValidationError(
      'caps_too_loose',
      `caps.lifetimeMaxAmount (${userCaps.lifetimeMaxAmount}) exceeds manifest cap (${manifestCaps.lifetimeMaxAmount}).`,
      '$.caps.lifetimeMaxAmount',
    );
  }
  for (const token of userCaps.allowlistedTokens) {
    if (!manifestCaps.allowlistedTokens.includes(token)) {
      throw new WorkflowValidationError(
        'caps_token_not_allowed',
        `caps.allowlistedTokens contains "${token}" which is not in the manifest allowlist.`,
        '$.caps.allowlistedTokens',
      );
    }
  }
  if (userCaps.allowlistedRecipients && manifestCaps.allowlistedRecipients?.length) {
    for (const recipient of userCaps.allowlistedRecipients) {
      if (!manifestCaps.allowlistedRecipients.includes(recipient)) {
        throw new WorkflowValidationError(
          'caps_recipient_not_allowed',
          `caps.allowlistedRecipients contains "${recipient}" which is not in the manifest recipient allowlist.`,
          '$.caps.allowlistedRecipients',
        );
      }
    }
  }
  const tightened: SkillCaps = {
    perRunMaxAmount: userCaps.perRunMaxAmount,
    lifetimeMaxAmount: userCaps.lifetimeMaxAmount,
    allowlistedTokens: [...userCaps.allowlistedTokens],
  };
  if (manifestCaps.expiresAt && userCaps.expiresAt) {
    if (Date.parse(userCaps.expiresAt) > Date.parse(manifestCaps.expiresAt)) {
      throw new WorkflowValidationError(
        'caps_too_loose',
        `caps.expiresAt (${userCaps.expiresAt}) is later than manifest expiry (${manifestCaps.expiresAt}).`,
        '$.caps.expiresAt',
      );
    }
    tightened.expiresAt = userCaps.expiresAt;
  } else if (manifestCaps.expiresAt) {
    tightened.expiresAt = manifestCaps.expiresAt;
  } else if (userCaps.expiresAt) {
    tightened.expiresAt = userCaps.expiresAt;
  }
  if (manifestCaps.maxExecutions !== undefined) {
    const userMax = userCaps.maxExecutions;
    tightened.maxExecutions =
      userMax !== undefined && userMax < manifestCaps.maxExecutions
        ? userMax
        : manifestCaps.maxExecutions;
  } else if (userCaps.maxExecutions !== undefined) {
    tightened.maxExecutions = userCaps.maxExecutions;
  }
  if (userCaps.allowlistedRecipients) {
    tightened.allowlistedRecipients = [...userCaps.allowlistedRecipients];
  } else if (manifestCaps.allowlistedRecipients) {
    tightened.allowlistedRecipients = [...manifestCaps.allowlistedRecipients];
  }
  return tightened;
}

function validateInstallParamsForManifest(
  manifest: SkillManifest,
  installParams: JsonObject | undefined,
): JsonObject | undefined {
  const required = requiredInstallParamKeys(manifest);
  if (required.length === 0) return installParams;
  const params = installParams ?? {};
  const sanitized: JsonObject = { ...params };
  for (const key of required) {
    const value = sanitized[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new WorkflowValidationError(
        'install_param_required',
        `installParams.${key} is required by this skill manifest.`,
        `$.installParams.${key}`,
      );
    }
    sanitized[key] = value.trim();
  }
  return sanitized;
}

function requiredInstallParamKeys(manifest: SkillManifest): string[] {
  const keys = new Set<string>();
  collectInstallParamKeys(manifest.action.paramsTemplate, keys);
  return [...keys].sort();
}

function collectInstallParamKeys(value: unknown, keys: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(INSTALL_PARAM_PLACEHOLDER_RE)) {
      const key = match[1];
      if (key) keys.add(key);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectInstallParamKeys(entry, keys));
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectInstallParamKeys(entry, keys);
    }
  }
}

function addInstallParamRecipientCaps(
  caps: SkillCaps,
  installParams: JsonObject | undefined,
): SkillCaps {
  if (!installParams) return caps;
  const recipients = new Set(caps.allowlistedRecipients ?? []);
  const hadRecipientCap = recipients.size > 0;
  for (const [key, value] of Object.entries(installParams)) {
    if (INSTALL_PARAM_RECIPIENT_KEYS.has(key) && typeof value === 'string' && value.trim()) {
      const recipient = value.trim();
      if (hadRecipientCap && !recipients.has(recipient)) {
        throw new WorkflowValidationError(
          'install_param_recipient_not_allowed',
          `installParams.${key} is not included in caps.allowlistedRecipients.`,
          `$.installParams.${key}`,
        );
      }
      recipients.add(recipient);
    }
  }
  if (recipients.size === 0) return caps;
  return {
    ...caps,
    allowlistedRecipients: [...recipients],
  };
}

function authorEarningsSkillId(
  schedule: RecurringScheduleRecord,
  authorWallet: string,
): string | null {
  // Known limit (skr-earnings): Duplicate of getAuthorEarningsSkillId above — same
  // USDC-only filter; the $SKR-priced subscriptions are skipped pending a
  // per-token earnings response shape. See plan section P3.7.
  if (
    schedule.status !== 'active' ||
    schedule.cadence !== 'monthly' ||
    schedule.token !== DEFAULT_MONETIZATION_TOKEN ||
    schedule.recipient !== authorWallet ||
    !isNonNegativeDecimalString(schedule.amount)
  ) {
    return null;
  }
  const metadata = schedule.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  if (metadata.source !== 'skill_install_monetization') return null;
  const skillId = metadata.skillId;
  return typeof skillId === 'string' && skillId.trim() ? skillId.trim() : null;
}

function addDecimalStrings(a: string, b: string): string {
  if (!isNonNegativeDecimalString(a) || !isNonNegativeDecimalString(b)) return a;
  const decimals = Math.max(decimalPlaces(a), decimalPlaces(b));
  return unscaleDecimal(scaleDecimal(a, decimals) + scaleDecimal(b, decimals), decimals);
}

function isNonNegativeDecimalString(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value);
}

function decimalPlaces(value: string): number {
  return value.includes('.') ? (value.split('.')[1] ?? '').length : 0;
}

function unscaleDecimal(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const raw = value.toString().padStart(decimals + 1, '0');
  const intPart = raw.slice(0, -decimals);
  const fracPart = raw.slice(-decimals).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

function decimalGreater(a: string, b: string): boolean {
  const SCALE = 12;
  return scaleDecimal(a, SCALE) > scaleDecimal(b, SCALE);
}

function utcLocalTime(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function scaleDecimal(value: string, decimals: number): bigint {
  const [intPart, fracPart = ''] = value.split('.');
  const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
  return BigInt((intPart ?? '0') + padded);
}

function assertNoForbiddenAuthority(node: unknown, path = '$'): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => assertNoForbiddenAuthority(item, `${path}[${i}]`));
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(key)) {
      throw new WorkflowValidationError(
        'forbidden_authority',
        `Skill manifest contains forbidden field: ${key}`,
        `${path}.${key}`,
      );
    }
    if (key === 'approvalAuthority' && value === 'unlimited') {
      throw new WorkflowValidationError(
        'forbidden_authority',
        'approvalAuthority: "unlimited" is not permitted in skill manifests.',
        `${path}.${key}`,
      );
    }
    assertNoForbiddenAuthority(value, `${path}.${key}`);
  }
}

async function appendSkillsAuditEvent(
  context: DevApiHandlerContext,
  actor: AuditActor,
  type: string,
  metadata: JsonObject,
  subjectType: string,
  subjectId: string,
): Promise<void> {
  if (!context.walletAddress) return;
  const record: AuditEventRecord = {
    id: `audit_${randomUUID()}`,
    walletAddress: context.walletAddress,
    type,
    createdAt: context.clock.now().toISOString(),
    actor,
    subjectType,
    subjectId,
    metadata,
  };
  await context.workflowStore.appendAuditEvent(context.walletAddress, record);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw new BodyTooLargeError();
    }
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

function writeJsonNoStore(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function writeSkillsError(res: ServerResponse, err: unknown): void {
  if (err instanceof BodyTooLargeError) {
    writeJsonNoStore(res, 413, { error: 'body_too_large', message: err.message });
    return;
  }
  if (err instanceof InvalidJsonError) {
    writeJsonNoStore(res, 400, { error: 'invalid_json', message: err.message });
    return;
  }
  if (err instanceof WorkflowValidationError) {
    const code = err.code ?? 'invalid_input';
    const payload: JsonObject = { error: code, message: err.message };
    if (err.path) payload.path = err.path;
    writeJsonNoStore(res, 400, payload);
    return;
  }
  if (err instanceof SkillNotFoundError) {
    writeJsonNoStore(res, err.status, { error: err.code, message: err.message });
    return;
  }
  if (err instanceof SkillInvalidStateError) {
    writeJsonNoStore(res, err.status, { error: err.code, message: err.message });
    return;
  }
  if (err instanceof RecurringServiceError) {
    writeJsonNoStore(res, err.status, { error: err.code, message: err.message });
    return;
  }
  if (err instanceof SkillInternalError) {
    writeJsonNoStore(res, 500, { error: 'internal_error', message: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[skillsRoutes] internal error', err);
  writeJsonNoStore(res, 500, {
    error: 'internal_error',
    message: err instanceof Error ? err.message : 'Unexpected server error.',
  });
}

const skillsHandler: DevApiHandler = {
  prefix: PREFIX,
  methods: ['GET', 'POST'],
  publicRoute: true,
  handle: handleSkillsRequest,
};

registerDevApiHandler(skillsHandler);
