// Durable Transaction Ledger
//
// Persists signed/submitted transaction state in browser-local storage so the
// app can recover the in-flight execution status across refreshes and prevent
// accidental double approvals. The module is intentionally pure: every public
// function accepts an optional `storage` argument (defaulting to
// `globalThis.localStorage`) so tests can drive it without mocking globals.

export type ExecutionPhase =
  | 'prepared'
  | 'wallet_opening'
  | 'wallet_signed'
  | 'broadcasting'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'failed'
  | 'ambiguous';

export type ExecutionFailureKind =
  | 'wallet_rejected'
  | 'wallet_unavailable'
  | 'config_missing'
  | 'rpc_timeout'
  | 'rpc_rejected'
  | 'network_unreachable'
  | 'onchain_failed'
  | 'expired_blockhash'
  | 'slippage_or_quote_failed'
  | 'unknown_maybe_submitted';

export type WorkflowSource = 'browser' | 'cloud' | 'local-bridge';

export interface PendingTransactionRecord {
  id: string;
  actionId: string;
  cluster: string;
  workflowSource: WorkflowSource;
  kind: string;
  phase: ExecutionPhase;
  walletAddress?: string;
  txid?: string;
  unsignedTransactionHash?: string;
  signedTransactionHash?: string;
  signedTransactionBase64?: string;
  jupiterRequestId?: string;
  attemptCount: number;
  signedAt?: string;
  submittedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  lastError?: string;
  failureKind?: ExecutionFailureKind;
  explorerUrl?: string;
  /**
   * Toast id linked to this transaction so the background reconciler can update
   * the original "Confirming..." toast in place instead of pushing a new one.
   */
  toastId?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionLedgerDocument {
  version: 1;
  records: PendingTransactionRecord[];
}

export interface PendingTransactionPatch {
  id?: string;
  actionId: string;
  cluster: string;
  workflowSource: WorkflowSource;
  kind: string;
  phase?: ExecutionPhase;
  walletAddress?: string;
  txid?: string;
  unsignedTransactionHash?: string;
  signedTransactionHash?: string;
  signedTransactionBase64?: string;
  jupiterRequestId?: string;
  attemptCount?: number;
  signedAt?: string;
  submittedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  lastError?: string;
  failureKind?: ExecutionFailureKind;
  explorerUrl?: string;
  toastId?: number;
}

export const TRANSACTION_LEDGER_STORAGE_KEY = 'solana-agent-wallet-pending-transactions-v1';
export const TRANSACTION_LEDGER_VERSION = 1 as const;
export const TRANSACTION_LEDGER_MAX_RECORDS = 100;

const VALID_PHASES: ReadonlySet<ExecutionPhase> = new Set<ExecutionPhase>([
  'prepared',
  'wallet_opening',
  'wallet_signed',
  'broadcasting',
  'submitted',
  'confirming',
  'confirmed',
  'failed',
  'ambiguous',
]);

const VALID_FAILURE_KINDS: ReadonlySet<ExecutionFailureKind> = new Set<ExecutionFailureKind>([
  'wallet_rejected',
  'wallet_unavailable',
  'config_missing',
  'rpc_timeout',
  'rpc_rejected',
  'network_unreachable',
  'onchain_failed',
  'expired_blockhash',
  'slippage_or_quote_failed',
  'unknown_maybe_submitted',
]);

const VALID_WORKFLOW_SOURCES: ReadonlySet<WorkflowSource> = new Set<WorkflowSource>([
  'browser',
  'cloud',
  'local-bridge',
]);

const RECONCILIATION_PHASES: ReadonlySet<ExecutionPhase> = new Set<ExecutionPhase>([
  'wallet_signed',
  'broadcasting',
  'submitted',
  'confirming',
  'ambiguous',
]);

const MAINNET_CLUSTERS = new Set(['mainnet-beta', 'mainnet']);
const NODE_CRYPTO_SPECIFIER = 'node:crypto';

interface NodeCryptoSha256Module {
  createHash(algorithm: string): {
    update(input: string, encoding: string): {
      digest(encoding: string): string;
    };
  };
}

/**
 * Resolve the storage backend, gracefully returning `undefined` when neither
 * the caller-provided storage nor `globalThis.localStorage` is reachable. We
 * never throw from storage access — a missing or quota-exceeded localStorage
 * must degrade silently to "no ledger" rather than break the page.
 */
function resolveStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage;
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    return candidate ?? undefined;
  } catch {
    return undefined;
  }
}

function safeGetItem(storage: Storage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(storage: Storage | undefined, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    /* swallow quota/serialization errors */
  }
}

function safeRemoveItem(storage: Storage | undefined, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* swallow */
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
  return nonEmptyString(value) ? value : undefined;
}

function isFiniteNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isIsoString(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

function normalizeIsoString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Produce a stable-ish browser-local id when the caller did not supply one.
 * The shape `tx-ledger-<actionId>-<timestamp>-<short-random>` keeps the id
 * readable while remaining unique enough across rapid upserts. The dedup
 * rules (`id` / `actionId` / `txid+cluster`) still ensure the same logical
 * record is updated rather than duplicated when callers omit `id`.
 */
function generateRecordId(actionId: string, timestamp: string): string {
  const slug = actionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'action';
  const stamp = timestamp.replace(/[^0-9]/g, '') || `${Date.now()}`;
  const random = Math.random().toString(36).slice(2, 8) || 'random';
  return `tx-ledger-${slug}-${stamp}-${random}`;
}

function normalizeRecord(raw: unknown): PendingTransactionRecord | undefined {
  if (!isPlainObject(raw)) return undefined;

  const actionId = optionalString(raw.actionId);
  const cluster = optionalString(raw.cluster);
  const workflowSource = raw.workflowSource;
  const kind = optionalString(raw.kind);

  if (!actionId || !cluster || !kind) return undefined;
  if (typeof workflowSource !== 'string' || !VALID_WORKFLOW_SOURCES.has(workflowSource as WorkflowSource)) {
    return undefined;
  }

  const phaseRaw = raw.phase;
  const phase: ExecutionPhase =
    typeof phaseRaw === 'string' && VALID_PHASES.has(phaseRaw as ExecutionPhase)
      ? (phaseRaw as ExecutionPhase)
      : 'prepared';

  const attemptCount = isFiniteNonNegativeInt(raw.attemptCount) ? Math.floor(raw.attemptCount) : 0;

  const createdAt = normalizeIsoString(raw.createdAt) ?? nowIso();
  const updatedAt = normalizeIsoString(raw.updatedAt) ?? createdAt;

  const id = nonEmptyString(raw.id) ? raw.id : generateRecordId(actionId, updatedAt);

  const txid = optionalString(raw.txid);

  const failureKindRaw = raw.failureKind;
  const failureKind: ExecutionFailureKind | undefined =
    typeof failureKindRaw === 'string' && VALID_FAILURE_KINDS.has(failureKindRaw as ExecutionFailureKind)
      ? (failureKindRaw as ExecutionFailureKind)
      : undefined;

  const explorerUrlInput = optionalString(raw.explorerUrl);
  const explorerUrl = explorerUrlInput ?? (txid ? explorerUrlForTxid(txid, cluster) : undefined);
  const toastId = isFiniteNonNegativeInt(raw.toastId) ? Math.floor(raw.toastId) : undefined;

  const record: PendingTransactionRecord = {
    id,
    actionId,
    cluster,
    workflowSource: workflowSource as WorkflowSource,
    kind,
    phase,
    walletAddress: optionalString(raw.walletAddress),
    txid,
    unsignedTransactionHash: optionalString(raw.unsignedTransactionHash),
    signedTransactionHash: optionalString(raw.signedTransactionHash),
    signedTransactionBase64: optionalString(raw.signedTransactionBase64),
    jupiterRequestId: optionalString(raw.jupiterRequestId),
    attemptCount,
    signedAt: normalizeIsoString(raw.signedAt),
    submittedAt: normalizeIsoString(raw.submittedAt),
    confirmedAt: normalizeIsoString(raw.confirmedAt),
    failedAt: normalizeIsoString(raw.failedAt),
    lastAttemptAt: normalizeIsoString(raw.lastAttemptAt),
    nextRetryAt: normalizeIsoString(raw.nextRetryAt),
    lastError: optionalString(raw.lastError),
    failureKind,
    explorerUrl,
    toastId,
    createdAt,
    updatedAt,
  };

  return stripUndefined(record);
}

function stripUndefined(record: PendingTransactionRecord): PendingTransactionRecord {
  const result = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as unknown as PendingTransactionRecord;
}

function sortRecordsNewestFirst(records: PendingTransactionRecord[]): PendingTransactionRecord[] {
  return [...records].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt);
    const bTime = Date.parse(b.updatedAt);
    const aSafe = Number.isFinite(aTime) ? aTime : 0;
    const bSafe = Number.isFinite(bTime) ? bTime : 0;
    if (aSafe !== bSafe) return bSafe - aSafe;
    // Deterministic tie break so stable ordering for tests.
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

function parseLedgerPayload(raw: string | null): PendingTransactionRecord[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  if (parsed.version !== TRANSACTION_LEDGER_VERSION) return [];
  const rawRecords = parsed.records;
  if (!Array.isArray(rawRecords)) return [];

  const normalized: PendingTransactionRecord[] = [];
  for (const candidate of rawRecords) {
    const record = normalizeRecord(candidate);
    if (record) normalized.push(record);
  }
  return normalized;
}

export function loadTransactionLedger(storage?: Storage): PendingTransactionRecord[] {
  const target = resolveStorage(storage);
  const raw = safeGetItem(target, TRANSACTION_LEDGER_STORAGE_KEY);
  const records = parseLedgerPayload(raw);
  return sortRecordsNewestFirst(records);
}

export function saveTransactionLedger(records: PendingTransactionRecord[], storage?: Storage): void {
  const target = resolveStorage(storage);
  if (!target) return;

  // Re-normalize (drops bad input even if caller hand-crafted invalid records)
  const normalized: PendingTransactionRecord[] = [];
  for (const candidate of records) {
    const record = normalizeRecord(candidate);
    if (record) normalized.push(record);
  }

  if (normalized.length === 0) {
    safeRemoveItem(target, TRANSACTION_LEDGER_STORAGE_KEY);
    return;
  }

  const sorted = sortRecordsNewestFirst(normalized);
  const trimmed = sorted.slice(0, TRANSACTION_LEDGER_MAX_RECORDS);
  const document: TransactionLedgerDocument = {
    version: TRANSACTION_LEDGER_VERSION,
    records: trimmed,
  };
  try {
    safeSetItem(target, TRANSACTION_LEDGER_STORAGE_KEY, JSON.stringify(document));
  } catch {
    /* swallow */
  }
}

function findIndexForUpsert(
  records: PendingTransactionRecord[],
  patch: PendingTransactionPatch,
): number {
  const patchId = optionalString(patch.id);
  if (patchId) {
    const byId = records.findIndex((record) => record.id === patchId);
    if (byId !== -1) return byId;
  }
  const patchActionId = optionalString(patch.actionId);
  if (patchActionId) {
    const byAction = records.findIndex((record) => record.actionId === patchActionId);
    if (byAction !== -1) return byAction;
  }
  const patchTxid = optionalString(patch.txid);
  if (patchTxid) {
    const cluster = optionalString(patch.cluster);
    const byTxid = records.findIndex(
      (record) => record.txid === patchTxid && (!cluster || record.cluster === cluster),
    );
    if (byTxid !== -1) return byTxid;
  }
  return -1;
}

function mergeRecord(
  existing: PendingTransactionRecord,
  patch: PendingTransactionPatch,
  timestamp: string,
): PendingTransactionRecord {
  const next: PendingTransactionRecord = {
    ...existing,
    // Caller-provided required-shape fields can be refreshed.
    actionId: patch.actionId,
    cluster: patch.cluster,
    workflowSource: patch.workflowSource,
    kind: patch.kind,
  };

  if (patch.phase && VALID_PHASES.has(patch.phase)) {
    next.phase = patch.phase;
  }

  if (patch.id !== undefined && nonEmptyString(patch.id)) {
    next.id = patch.id;
  }

  // Preserve signed bytes / hashes / txid unless caller explicitly overrides.
  if (patch.signedTransactionBase64 !== undefined) {
    next.signedTransactionBase64 = optionalString(patch.signedTransactionBase64);
  }
  if (patch.signedTransactionHash !== undefined) {
    next.signedTransactionHash = optionalString(patch.signedTransactionHash);
  }
  if (patch.unsignedTransactionHash !== undefined) {
    next.unsignedTransactionHash = optionalString(patch.unsignedTransactionHash);
  }
  if (patch.txid !== undefined) {
    next.txid = optionalString(patch.txid);
  }

  if (patch.walletAddress !== undefined) {
    next.walletAddress = optionalString(patch.walletAddress);
  }
  if (patch.jupiterRequestId !== undefined) {
    next.jupiterRequestId = optionalString(patch.jupiterRequestId);
  }

  if (patch.attemptCount !== undefined && isFiniteNonNegativeInt(patch.attemptCount)) {
    next.attemptCount = Math.floor(patch.attemptCount);
  }

  if (patch.signedAt !== undefined) next.signedAt = normalizeIsoString(patch.signedAt);
  if (patch.submittedAt !== undefined) next.submittedAt = normalizeIsoString(patch.submittedAt);
  if (patch.confirmedAt !== undefined) next.confirmedAt = normalizeIsoString(patch.confirmedAt);
  if (patch.failedAt !== undefined) next.failedAt = normalizeIsoString(patch.failedAt);
  if (patch.lastAttemptAt !== undefined) next.lastAttemptAt = normalizeIsoString(patch.lastAttemptAt);
  if (patch.nextRetryAt !== undefined) next.nextRetryAt = normalizeIsoString(patch.nextRetryAt);

  if (patch.lastError !== undefined) {
    next.lastError = optionalString(patch.lastError);
  }
  if (patch.failureKind !== undefined) {
    next.failureKind = VALID_FAILURE_KINDS.has(patch.failureKind as ExecutionFailureKind)
      ? patch.failureKind
      : undefined;
  }

  if (patch.explorerUrl !== undefined) {
    next.explorerUrl = optionalString(patch.explorerUrl);
  }

  if (patch.toastId !== undefined) {
    next.toastId = isFiniteNonNegativeInt(patch.toastId) ? Math.floor(patch.toastId) : undefined;
  }

  // Auto-fill explorerUrl when txid present and caller did not provide a URL.
  if (!next.explorerUrl && next.txid) {
    next.explorerUrl = explorerUrlForTxid(next.txid, next.cluster);
  }

  next.updatedAt = timestamp;
  // createdAt is preserved by the spread above.

  return stripUndefined(next);
}

function buildRecord(patch: PendingTransactionPatch, timestamp: string): PendingTransactionRecord {
  const phase: ExecutionPhase =
    patch.phase && VALID_PHASES.has(patch.phase) ? patch.phase : 'prepared';

  const attemptCount =
    patch.attemptCount !== undefined && isFiniteNonNegativeInt(patch.attemptCount)
      ? Math.floor(patch.attemptCount)
      : 0;

  const id = nonEmptyString(patch.id) ? patch.id : generateRecordId(patch.actionId, timestamp);
  const txid = optionalString(patch.txid);

  const failureKind: ExecutionFailureKind | undefined =
    patch.failureKind && VALID_FAILURE_KINDS.has(patch.failureKind as ExecutionFailureKind)
      ? patch.failureKind
      : undefined;

  const explorerUrl =
    optionalString(patch.explorerUrl) ?? (txid ? explorerUrlForTxid(txid, patch.cluster) : undefined);

  const toastId =
    patch.toastId !== undefined && isFiniteNonNegativeInt(patch.toastId) ? Math.floor(patch.toastId) : undefined;

  const record: PendingTransactionRecord = {
    id,
    actionId: patch.actionId,
    cluster: patch.cluster,
    workflowSource: patch.workflowSource,
    kind: patch.kind,
    phase,
    walletAddress: optionalString(patch.walletAddress),
    txid,
    unsignedTransactionHash: optionalString(patch.unsignedTransactionHash),
    signedTransactionHash: optionalString(patch.signedTransactionHash),
    signedTransactionBase64: optionalString(patch.signedTransactionBase64),
    jupiterRequestId: optionalString(patch.jupiterRequestId),
    attemptCount,
    signedAt: normalizeIsoString(patch.signedAt),
    submittedAt: normalizeIsoString(patch.submittedAt),
    confirmedAt: normalizeIsoString(patch.confirmedAt),
    failedAt: normalizeIsoString(patch.failedAt),
    lastAttemptAt: normalizeIsoString(patch.lastAttemptAt),
    nextRetryAt: normalizeIsoString(patch.nextRetryAt),
    lastError: optionalString(patch.lastError),
    failureKind,
    explorerUrl,
    toastId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return stripUndefined(record);
}

export function upsertPendingTransaction(
  patch: PendingTransactionPatch,
  storage?: Storage,
): PendingTransactionRecord {
  if (!nonEmptyString(patch.actionId)) {
    throw new Error('upsertPendingTransaction: actionId is required');
  }
  if (!nonEmptyString(patch.cluster)) {
    throw new Error('upsertPendingTransaction: cluster is required');
  }
  if (!nonEmptyString(patch.kind)) {
    throw new Error('upsertPendingTransaction: kind is required');
  }
  if (!VALID_WORKFLOW_SOURCES.has(patch.workflowSource)) {
    throw new Error(`upsertPendingTransaction: invalid workflowSource "${patch.workflowSource}"`);
  }

  const target = resolveStorage(storage);
  const existing = loadTransactionLedger(target);
  const timestamp = nowIso();

  const index = findIndexForUpsert(existing, patch);

  let merged: PendingTransactionRecord;
  let nextRecords: PendingTransactionRecord[];
  if (index === -1) {
    merged = buildRecord(patch, timestamp);
    nextRecords = [merged, ...existing];
  } else {
    const previous = existing[index];
    if (!previous) {
      merged = buildRecord(patch, timestamp);
      nextRecords = [merged, ...existing];
    } else {
      merged = mergeRecord(previous, patch, timestamp);
      nextRecords = existing.slice();
      nextRecords[index] = merged;
    }
  }

  saveTransactionLedger(nextRecords, target);
  return merged;
}

export function findPendingTransactionByAction(
  actionId: string,
  storage?: Storage,
): PendingTransactionRecord | undefined {
  if (!nonEmptyString(actionId)) return undefined;
  const records = loadTransactionLedger(storage);
  return records.find((record) => record.actionId === actionId);
}

export function findPendingTransactionByTxid(
  txid: string,
  cluster?: string,
  storage?: Storage,
): PendingTransactionRecord | undefined {
  if (!nonEmptyString(txid)) return undefined;
  const records = loadTransactionLedger(storage);
  const trimmedCluster = optionalString(cluster);
  return records.find((record) => {
    if (record.txid !== txid) return false;
    if (trimmedCluster && record.cluster !== trimmedCluster) return false;
    return true;
  });
}

export function markTransactionPhase(
  id: string,
  phase: ExecutionPhase,
  patch?: Partial<PendingTransactionRecord>,
  storage?: Storage,
): PendingTransactionRecord | undefined {
  if (!nonEmptyString(id)) return undefined;
  if (!VALID_PHASES.has(phase)) return undefined;

  const target = resolveStorage(storage);
  const existing = loadTransactionLedger(target);
  const index = existing.findIndex((record) => record.id === id);
  if (index === -1) return undefined;

  const previous = existing[index];
  if (!previous) return undefined;

  const overlay = patch ?? {};
  const timestamp = nowIso();

  const updated: PendingTransactionRecord = {
    ...previous,
    ...overlay,
    id: previous.id,
    createdAt: previous.createdAt,
    phase,
    updatedAt: timestamp,
  };

  if (overlay.failureKind !== undefined) {
    updated.failureKind = VALID_FAILURE_KINDS.has(overlay.failureKind as ExecutionFailureKind)
      ? overlay.failureKind
      : undefined;
  }

  if (!updated.explorerUrl && updated.txid) {
    updated.explorerUrl = explorerUrlForTxid(updated.txid, updated.cluster);
  }

  const cleaned = stripUndefined(updated);
  const next = existing.slice();
  next[index] = cleaned;
  saveTransactionLedger(next, target);
  return cleaned;
}

export function removePendingTransaction(id: string, storage?: Storage): void {
  if (!nonEmptyString(id)) return;
  const target = resolveStorage(storage);
  const existing = loadTransactionLedger(target);
  const next = existing.filter((record) => record.id !== id);
  if (next.length === existing.length) return;
  saveTransactionLedger(next, target);
}

export function pendingTransactionsNeedingReconciliation(
  records?: PendingTransactionRecord[],
  now: Date = new Date(),
  storage?: Storage,
): PendingTransactionRecord[] {
  const source = records ?? loadTransactionLedger(storage);
  const nowMs = now.getTime();
  const filtered = source.filter((record) => {
    if (!RECONCILIATION_PHASES.has(record.phase)) return false;
    if (!record.nextRetryAt) return true;
    const retryTime = Date.parse(record.nextRetryAt);
    if (!Number.isFinite(retryTime)) return true;
    return retryTime <= nowMs;
  });
  return sortRecordsNewestFirst(filtered);
}

/**
 * SHA-256 hex over the signed transaction base64 string. We prefer Web Crypto
 * (browser, modern Node) and fall back to `node:crypto` so unit tests pass in
 * vitest's default node environment.
 */
export async function signedTransactionHashFromBase64(
  signedTransactionBase64: string,
): Promise<string> {
  const input = typeof signedTransactionBase64 === 'string' ? signedTransactionBase64 : '';

  const subtle = readWebCryptoSubtle();
  if (subtle) {
    const encoder = new TextEncoder();
    const buffer = await subtle.digest('SHA-256', encoder.encode(input));
    return bufferToHex(buffer);
  }

  const nodeHex = await tryNodeSha256Hex(input);
  if (nodeHex) return nodeHex;

  // Last-resort deterministic fallback (sha-256 is required by callers, but
  // we must not throw in tooling-limited environments). Use a stable JS hash.
  return jsFallbackSha256Hex(input);
}

function readWebCryptoSubtle(): SubtleCrypto | undefined {
  try {
    const value = (globalThis as { crypto?: Crypto }).crypto;
    return value?.subtle;
  } catch {
    return undefined;
  }
}

async function tryNodeSha256Hex(input: string): Promise<string | undefined> {
  if (!isNodeRuntime()) return undefined;
  try {
    const mod = (await import(/* @vite-ignore */ NODE_CRYPTO_SPECIFIER)) as NodeCryptoSha256Module;
    return mod.createHash('sha256').update(input, 'utf8').digest('hex');
  } catch {
    return undefined;
  }
}

function isNodeRuntime(): boolean {
  const processLike = (globalThis as { process?: { versions?: { node?: unknown } } }).process;
  return typeof processLike?.versions?.node === 'string';
}

function bufferToHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) {
    const byte = view[i] ?? 0;
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// Tiny pure-JS SHA-256 used only as an emergency fallback. Not used in the
// happy path (Web Crypto and node:crypto cover virtually every environment).
function jsFallbackSha256Hex(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const length = utf8.length;
  const bitLength = length * 8;
  const padded = new Uint8Array((((length + 9) + 63) >> 6) << 6);
  padded.set(utf8);
  padded[length] = 0x80;
  // 64-bit big-endian length
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  const lengthOffset = padded.length - 8;
  padded[lengthOffset + 0] = (high >>> 24) & 0xff;
  padded[lengthOffset + 1] = (high >>> 16) & 0xff;
  padded[lengthOffset + 2] = (high >>> 8) & 0xff;
  padded[lengthOffset + 3] = high & 0xff;
  padded[lengthOffset + 4] = (low >>> 24) & 0xff;
  padded[lengthOffset + 5] = (low >>> 16) & 0xff;
  padded[lengthOffset + 6] = (low >>> 8) & 0xff;
  padded[lengthOffset + 7] = low & 0xff;

  const W = new Uint32Array(64);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) {
      const o = chunk + i * 4;
      W[i] =
        ((padded[o] ?? 0) << 24) |
        ((padded[o + 1] ?? 0) << 16) |
        ((padded[o + 2] ?? 0) << 8) |
        (padded[o + 3] ?? 0);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = W[i - 15] ?? 0;
      const w2 = W[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      W[i] = ((W[i - 16] ?? 0) + s0 + (W[i - 7] ?? 0) + s1) >>> 0;
    }
    let a = H[0] ?? 0;
    let b = H[1] ?? 0;
    let c = H[2] ?? 0;
    let d = H[3] ?? 0;
    let e = H[4] ?? 0;
    let f = H[5] ?? 0;
    let g = H[6] ?? 0;
    let h = H[7] ?? 0;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + (K[i] ?? 0) + (W[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = ((H[0] ?? 0) + a) >>> 0;
    H[1] = ((H[1] ?? 0) + b) >>> 0;
    H[2] = ((H[2] ?? 0) + c) >>> 0;
    H[3] = ((H[3] ?? 0) + d) >>> 0;
    H[4] = ((H[4] ?? 0) + e) >>> 0;
    H[5] = ((H[5] ?? 0) + f) >>> 0;
    H[6] = ((H[6] ?? 0) + g) >>> 0;
    H[7] = ((H[7] ?? 0) + h) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < H.length; i += 1) {
    hex += (H[i] ?? 0).toString(16).padStart(8, '0');
  }
  return hex;
}

function rotr(value: number, amount: number): number {
  return ((value >>> amount) | (value << (32 - amount))) >>> 0;
}

/**
 * Build a Solscan transaction explorer URL. Mainnet URLs use no cluster query.
 * Devnet/testnet append the `?cluster=<name>` query. Custom clusters are also
 * forwarded as a cluster query so users land on the right environment.
 */
export function explorerUrlForTxid(txid: string, cluster: string): string {
  const safeTxid = encodeURIComponent(txid);
  const trimmedCluster = (cluster ?? '').trim();
  if (!trimmedCluster || MAINNET_CLUSTERS.has(trimmedCluster)) {
    return `https://solscan.io/tx/${safeTxid}`;
  }
  return `https://solscan.io/tx/${safeTxid}?cluster=${encodeURIComponent(trimmedCluster)}`;
}
