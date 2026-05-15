import type { BuildApprovalInput, BuildApprovalResult, JsonObject } from './types.js';

export function buildApprovalRequest(input: BuildApprovalInput): BuildApprovalResult {
  const { install, manifest, boundParams, cluster, nowIso } = input;
  const connectorAction = manifest.action.connectorAction;
  if (!connectorAction || typeof connectorAction !== 'string') {
    throw new Error('skill manifest missing action.connectorAction');
  }
  const kind = normalizeSkillApprovalKind(connectorAction);
  const summary = `${manifest.name} (skill ${manifest.id}@${manifest.version})`;
  const metadata: JsonObject = {
    skillId: manifest.id,
    skillVersion: manifest.version,
    skillInstallId: install.id,
    skillExecutionAt: nowIso,
    skillConnectorAction: connectorAction,
    ...(kind !== connectorAction ? { normalizedApprovalKind: kind } : {}),
    approvalBoundary:
      'Wallet approval is required for every skill execution; the skill never signs or submits transactions.',
  };
  return { kind, summary, params: boundParams, metadata, cluster };
}

export function normalizeSkillApprovalKind(connectorAction: string): string {
  const trimmed = connectorAction.trim();
  if (trimmed.startsWith('solana_prepare_')) return trimmed.slice('solana_prepare_'.length);
  if (trimmed.startsWith('prepare_')) return trimmed.slice('prepare_'.length);
  return trimmed;
}
