import { createHash } from 'node:crypto';

import type { JsonObject, JsonValue } from '@solana-agent-wallet-adapter/workflow';
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';
import type { SkillInstallRecord, SkillManifest } from '@solana-agent-wallet-adapter/skills-runtime';

import type { SkillManifestStoreRecord } from './store.js';

const HASH_PREFIX = 'sha256:';

export function skillManifestHash(manifest: SkillManifest): string {
  return `${HASH_PREFIX}${createHash('sha256')
    .update(canonicalJson(manifest as unknown as JsonValue))
    .digest('hex')}`;
}

export function skillManifestHashForRecord(record: SkillManifestStoreRecord): string {
  if (typeof record.manifestHash === 'string' && record.manifestHash.startsWith(HASH_PREFIX)) {
    return record.manifestHash;
  }
  return skillManifestHash(record.manifest as SkillManifest);
}

export function cloneSkillManifest(manifest: SkillManifest): SkillManifest {
  return JSON.parse(JSON.stringify(manifest)) as SkillManifest;
}

export type InstallManifestSnapshotRead =
  | { status: 'missing'; manifestHash?: string }
  | { status: 'valid'; manifest: SkillManifest; manifestHash?: string }
  | { status: 'invalid'; reason: string; manifestHash?: string };

export function manifestSnapshotFromInstall(install: SkillInstallRecord): InstallManifestSnapshotRead {
  const manifestHash = manifestHashFromInstall(install);
  const metadata = install.metadata;
  if (!isJsonObject(metadata)) return { status: 'missing', ...(manifestHash ? { manifestHash } : {}) };
  if (!Object.prototype.hasOwnProperty.call(metadata, 'manifestSnapshot')) {
    return { status: 'missing', ...(manifestHash ? { manifestHash } : {}) };
  }
  const snapshot = metadata.manifestSnapshot;
  if (!isJsonObject(snapshot)) {
    return {
      status: 'invalid',
      reason: 'manifest-snapshot-not-object',
      ...(manifestHash ? { manifestHash } : {}),
    };
  }
  try {
    return {
      status: 'valid',
      manifest: DevLayer1.skills.validateSkillManifest(snapshot) as SkillManifest,
      ...(manifestHash ? { manifestHash } : {}),
    };
  } catch (err) {
    return {
      status: 'invalid',
      reason: err instanceof Error ? err.message.slice(0, 160) : 'manifest-snapshot-validation-failed',
      ...(manifestHash ? { manifestHash } : {}),
    };
  }
}

export function manifestHashFromInstall(install: SkillInstallRecord): string | undefined {
  const metadata = install.metadata;
  if (!isJsonObject(metadata)) return undefined;
  const raw = metadata.manifestHash;
  return typeof raw === 'string' && raw.startsWith(HASH_PREFIX) ? raw : undefined;
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson((entry ?? null) as JsonValue)).join(',')}]`;
  }
  const entries = Object.entries(value as JsonObject)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry as JsonValue)}`)
    .join(',')}}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
