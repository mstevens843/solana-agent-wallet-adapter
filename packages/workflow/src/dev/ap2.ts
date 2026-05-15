import {
  WORKFLOW_CLUSTERS,
  WorkflowValidationError,
  assertNoForbiddenWorkflowSecrets,
  type WorkflowCluster,
} from '../index.js';
import {
  Ap2ParseError,
  parseAp2Mandate,
  type Ap2Mandate,
} from '@solana-agent-wallet-adapter/ap2-adapter';

export interface Ap2InboundCreate {
  mandate: Ap2Mandate;
  cluster?: WorkflowCluster;
  receivedAt: string;
}

export function validateCreateAp2InboundRequest(body: unknown, path = '$'): Ap2InboundCreate {
  assertNoForbiddenWorkflowSecrets(body, path);
  if (!isPlainObject(body)) {
    throw new WorkflowValidationError('invalid_object', `${path} must be a JSON object.`, path);
  }
  if (body.mandate === undefined || body.mandate === null) {
    throw new WorkflowValidationError(
      'missing_ap2_mandate',
      'AP2 inbound request must include mandate.',
      `${path}.mandate`,
    );
  }

  let mandate: Ap2Mandate;
  try {
    mandate = parseAp2Mandate(body.mandate);
  } catch (err) {
    if (err instanceof Ap2ParseError) {
      throw new WorkflowValidationError(
        `invalid_ap2_mandate:${err.code}`,
        err.message,
        err.path ?? `${path}.mandate`,
      );
    }
    throw new WorkflowValidationError(
      'invalid_ap2_mandate',
      (err as Error).message ?? 'AP2 mandate could not be parsed.',
      `${path}.mandate`,
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

  return {
    mandate,
    ...(cluster ? { cluster } : {}),
    receivedAt: new Date().toISOString(),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
