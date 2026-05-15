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

export function manifestSnapshotFromInstall(install: SkillInstallRecord): SkillManifest | undefined {
  const metadata = install.metadata;
  if (!isJsonObject(metadata)) return undefined;
  const snapshot = metadata.manifestSnapshot;
  if (!isJsonObject(snapshot)) return undefined;
  try {
    return DevLayer1.skills.validateSkillManifest(snapshot) as SkillManifest;
  } catch {
    return undefined;
  }
}

export function manifestHashFromInstall(install: SkillInstallRecord): string | undefined {
  const metadata = install.metadata;
  if (!isJsonObject(metadata)) return undefined;
  const raw = metadata.manifestHash;
  return typeof raw === 'string' && raw.startsWith(HASH_PREFIX) ? raw : undefined;
}

export function validateSkillManifestRecord(value: unknown): SkillManifest {
  return DevLayer1.skills.validateSkillManifest(value) as SkillManifest;
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
