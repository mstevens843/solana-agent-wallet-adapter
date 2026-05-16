import {
  WORKFLOW_CLUSTERS,
  WorkflowValidationError,
  assertNoForbiddenWorkflowSecrets,
  type WorkflowCluster,
} from '../index.js';
import {
  MppParseError,
  MppVerifyError,
  parseMppChallenge,
  verifyMppChallenge,
  type MppChallenge,
} from '@solana-agent-wallet-adapter/mpp-adapter';

export interface MppCreate {
  challenge: MppChallenge;
  cluster?: WorkflowCluster;
  receivedAt: string;
  agentLabel?: string;
}

export function validateCreateMppRequest(body: unknown, path = '$'): MppCreate {
  assertNoForbiddenWorkflowSecrets(body, path);
  if (!isPlainObject(body)) {
    throw new WorkflowValidationError('invalid_object', `${path} must be a JSON object.`, path);
  }
  if (body.challenge === undefined || body.challenge === null) {
    throw new WorkflowValidationError(
      'missing_mpp_challenge',
      'MPP request must include challenge.',
      `${path}.challenge`,
    );
  }

  let rawChallenge: unknown = body.challenge;
  if (typeof rawChallenge === 'string') {
    try {
      rawChallenge = JSON.parse(rawChallenge);
    } catch {
      // parseMppChallenge below will raise invalid_json with the right context.
    }
  }
  assertNoForbiddenWorkflowSecrets(rawChallenge, `${path}.challenge`);

  let challenge: MppChallenge;
  try {
    challenge = parseMppChallenge(body.challenge);
    verifyMppChallenge(challenge);
  } catch (err) {
    if (err instanceof MppParseError) {
      throw new WorkflowValidationError(
        `invalid_mpp_challenge:${err.code}`,
        err.message,
        err.path ?? `${path}.challenge`,
      );
    }
    if (err instanceof MppVerifyError) {
      throw new WorkflowValidationError(
        `invalid_mpp_challenge:${err.code}`,
        err.message,
        err.path ?? `${path}.challenge`,
      );
    }
    throw new WorkflowValidationError(
      'invalid_mpp_challenge',
      (err as Error).message ?? 'MPP challenge could not be parsed.',
      `${path}.challenge`,
    );
  }

  let cluster: WorkflowCluster | undefined;
  if (body.cluster !== undefined && body.cluster !== null && body.cluster !== '') {
    if (typeof body.cluster !== 'string') {
      throw new WorkflowValidationError('invalid_cluster', 'cluster must be a string.', `${path}.cluster`);
    }
    const trimmed = body.cluster.trim();
    if (!(WORKFLOW_CLUSTERS as readonly string[]).includes(trimmed)) {
      throw new WorkflowValidationError(
        'invalid_cluster',
        `cluster must be one of: ${WORKFLOW_CLUSTERS.join(', ')}.`,
        `${path}.cluster`,
      );
    }
    cluster = trimmed as WorkflowCluster;
  }

  const agentLabel = optionalShortString(body.agentLabel, `${path}.agentLabel`, 120);
  return {
    challenge,
    ...(cluster ? { cluster } : {}),
    receivedAt: new Date().toISOString(),
    ...(agentLabel ? { agentLabel } : {}),
  };
}

function optionalShortString(value: unknown, path: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', `${path} must be a string.`, path);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) {
    throw new WorkflowValidationError('field_too_long', `${path} must be at most ${max} characters.`, path);
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
