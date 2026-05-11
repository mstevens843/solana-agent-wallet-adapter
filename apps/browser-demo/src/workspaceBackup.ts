// Workspace Backup
//
// Export and restore the browser-local state of the app (drafts, receipts,
// recurring schedules, safety rails, pending tx ledger) as a versioned JSON
// envelope. Pure: every function accepts an explicit `storage` argument so
// tests can drive it without touching globals.

import {
  TRANSACTION_LEDGER_STORAGE_KEY,
  loadTransactionLedger,
  type ExecutionPhase,
  type PendingTransactionRecord,
} from './transactionLedger.js';

export const WORKSPACE_BACKUP_VERSION = 1 as const;

export interface WorkspaceBackupSection {
  key: string;
  raw: string | null;
}

export interface WorkspaceBackup {
  schemaVersion: typeof WORKSPACE_BACKUP_VERSION;
  exportedAt: string;
  appVersion?: string;
  sections: Record<string, WorkspaceBackupSection>;
}

export interface ExportOptions {
  storage?: Storage;
  appVersion?: string;
  includeKeys?: ReadonlyArray<string>;
}

export type RestoreMode = 'replace' | 'merge';

export interface RestoreOptions {
  storage?: Storage;
  bundle: WorkspaceBackup;
  mode?: RestoreMode;
}

export interface RestoreResult {
  applied: string[];
  cleared: string[];
  skipped: string[];
  warnings: string[];
}

export interface BackupSectionSummary {
  key: string;
  bytes: number;
  present: boolean;
}

export const WORKSPACE_BACKUP_KEYS: ReadonlyArray<string> = [
  'solana-agent-wallet-demo-v2',
  'solana-agent-wallet-generated-plans-v1',
  'solana-agent-wallet-browser-workflow-v1',
  'solana-agent-wallet-recipient-rules-v1',
  'solana-agent-wallet-lab-artifacts-v1',
  TRANSACTION_LEDGER_STORAGE_KEY,
];

// Session secrets that must never leave this browser.
export const NEVER_EXPORT_KEYS: ReadonlySet<string> = new Set([
  'agentic-local-bridge-token',
  'agent-wallet-desktop-token',
]);

const UNRESOLVED_PHASES: ReadonlySet<ExecutionPhase> = new Set<ExecutionPhase>([
  'wallet_signed',
  'broadcasting',
  'submitted',
  'confirming',
  'ambiguous',
]);

export function exportWorkspace(options: ExportOptions = {}): WorkspaceBackup {
  const storage = resolveStorage(options.storage);
  const keys = options.includeKeys ?? WORKSPACE_BACKUP_KEYS;
  const sections: Record<string, WorkspaceBackupSection> = {};
  for (const key of keys) {
    if (NEVER_EXPORT_KEYS.has(key)) continue;
    const raw = storage.getItem(key);
    sections[key] = { key, raw };
  }
  const bundle: WorkspaceBackup = {
    schemaVersion: WORKSPACE_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sections,
  };
  if (options.appVersion) bundle.appVersion = options.appVersion;
  return bundle;
}

export function serializeBackup(bundle: WorkspaceBackup): string {
  return JSON.stringify(bundle, null, 2);
}

export function parseBackup(input: string): WorkspaceBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch (err) {
    throw new Error(`Backup file is not valid JSON: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Backup file is not an object.');
  }
  const cast = raw as Partial<WorkspaceBackup>;
  if (cast.schemaVersion !== WORKSPACE_BACKUP_VERSION) {
    throw new Error(
      `Unsupported backup schema version: expected ${WORKSPACE_BACKUP_VERSION}, got ${String(cast.schemaVersion)}.`,
    );
  }
  if (!cast.sections || typeof cast.sections !== 'object') {
    throw new Error('Backup file is missing the sections field.');
  }
  for (const [key, value] of Object.entries(cast.sections)) {
    if (value === null || typeof value !== 'object') {
      throw new Error(`Section ${key} is not an object.`);
    }
    const section = value as Partial<WorkspaceBackupSection>;
    if (section.key !== key) {
      throw new Error(`Section ${key} has mismatched key field.`);
    }
    if (section.raw !== null && typeof section.raw !== 'string') {
      throw new Error(`Section ${key} has invalid raw payload.`);
    }
  }
  return cast as WorkspaceBackup;
}

export function summarizeBackup(bundle: WorkspaceBackup): BackupSectionSummary[] {
  return Object.values(bundle.sections).map((section) => ({
    key: section.key,
    bytes: section.raw?.length ?? 0,
    present: section.raw !== null,
  }));
}

export function unresolvedPendingTransactions(storage?: Storage): PendingTransactionRecord[] {
  const records = loadTransactionLedger(storage);
  return records.filter((record) => UNRESOLVED_PHASES.has(record.phase));
}

export function restoreWorkspace(options: RestoreOptions): RestoreResult {
  const storage = resolveStorage(options.storage);
  const mode: RestoreMode = options.mode ?? 'replace';
  const result: RestoreResult = { applied: [], cleared: [], skipped: [], warnings: [] };
  const entries = Object.entries(options.bundle.sections);
  for (const [key, section] of entries) {
    if (NEVER_EXPORT_KEYS.has(key)) {
      result.skipped.push(key);
      result.warnings.push(`Skipped ${key}: never imported.`);
      continue;
    }
    if (section.raw === null) {
      if (mode === 'replace') {
        storage.removeItem(key);
        result.cleared.push(key);
      } else {
        result.skipped.push(key);
      }
      continue;
    }
    if (!isValidJsonString(section.raw)) {
      result.skipped.push(key);
      result.warnings.push(`Skipped ${key}: stored payload is not valid JSON.`);
      continue;
    }
    storage.setItem(key, section.raw);
    result.applied.push(key);
  }
  return result;
}

export function backupFilename(now = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `solana-agent-wallet-workspace-${yyyy}-${mm}-${dd}-${hh}${mi}.json`;
}

function resolveStorage(storage?: Storage): Storage {
  const resolved = storage ?? (typeof globalThis !== 'undefined' ? globalThis.localStorage : undefined);
  if (!resolved) {
    throw new Error('localStorage is not available in this environment.');
  }
  return resolved;
}

function isValidJsonString(value: string): boolean {
  if (value.length === 0) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
