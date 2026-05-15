import { WorkflowValidationError, type JsonObject } from '../index.js';

export type AggregatorSnapshotKind = 'skill' | 'wallet';

export interface SkillStatsSnapshot {
  skillId: string;
  installs: number;
  totalExecutions: number;
  successRate: number;
  medianGasUsd?: string;
  medianApyPercent?: string;
  maxDrawdownPercent?: string;
  lastExecutionAt?: string;
  computedAt: string;
}

export interface WalletStatsSnapshot {
  walletAddress: string;
  totalSkillsInstalled: number;
  totalExecutions: number;
  successRate: number;
  totalProfitUsd?: string;
  totalGasUsd?: string;
  installedSkillIds: string[];
  computedAt: string;
}

export interface AggregatorSnapshotRecord {
  key: string;
  kind: AggregatorSnapshotKind;
  computedAt: string;
  snapshot: SkillStatsSnapshot | WalletStatsSnapshot;
  metadata?: JsonObject;
}

export interface AggregatorRollupQuery {
  sinceIso?: string;
  skillIds?: string[];
}

export function validateAggregatorRollupQuery(
  input: unknown = {},
  path = '$',
): AggregatorRollupQuery {
  if (input === undefined) return {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('invalid_object', `${path} must be a JSON object.`, path);
  }

  const record = input as Record<string, unknown>;
  const allowedKeys = new Set(['sinceIso', 'skillIds']);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw invalid('unknown_key', `${path}.${key} is not supported.`, `${path}.${key}`);
    }
  }

  const query: AggregatorRollupQuery = {};
  if (record.sinceIso !== undefined) {
    if (typeof record.sinceIso !== 'string' || record.sinceIso.trim().length === 0) {
      throw invalid('invalid_since_iso', 'sinceIso must be a non-empty ISO timestamp string.', `${path}.sinceIso`);
    }
    const sinceIso = record.sinceIso.trim();
    if (Number.isNaN(Date.parse(sinceIso))) {
      throw invalid('invalid_since_iso', 'sinceIso must be a valid ISO timestamp.', `${path}.sinceIso`);
    }
    query.sinceIso = sinceIso;
  }

  if (record.skillIds !== undefined) {
    if (!Array.isArray(record.skillIds)) {
      throw invalid('invalid_skill_ids', 'skillIds must be an array of skill ids.', `${path}.skillIds`);
    }
    query.skillIds = record.skillIds.map((skillId, index) => {
      if (typeof skillId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skillId.trim())) {
        throw invalid(
          'invalid_skill_id',
          'skillIds entries must be lowercase kebab-case skill ids.',
          `${path}.skillIds[${index}]`,
        );
      }
      return skillId.trim();
    });
  }

  return query;
}

function invalid(code: string, message: string, path: string): WorkflowValidationError {
  return new WorkflowValidationError(code, message, path);
}
