import type { IncomingMessage, ServerResponse } from 'node:http';

import type { WorkflowCluster } from '@solana-agent-wallet-adapter/workflow';

import {
  EVIDENCE_RECEIPT_KINDS,
  EVIDENCE_RECEIPT_STATUSES,
  EvidenceService,
  EvidenceServiceError,
  type CreateEvidenceReceiptInput,
  type EvidenceAuditEvent,
  type EvidenceReceiptKind,
  type EvidenceReceiptRecord,
  type EvidenceReceiptStatus,
  type EvidenceStore,
} from './evidenceService.js';

const WORKFLOW_CLUSTERS: readonly WorkflowCluster[] = ['mainnet-beta', 'testnet', 'devnet', 'localnet'];
import type { WorkflowStore as CloudSessionStore } from './store.js';
import {
  WorkflowValidationError,
  validateRecordId,
  type JsonObject,
  type WorkflowSession,
} from './workflowValidation.js';

const cloudStoreEvidenceState = new WeakMap<CloudSessionStore, Map<string, EvidenceReceiptRecord>>();

const MAX_JSON_BYTES = 256 * 1024;
const MAX_SHORT_FIELD_LEN = 240;
const MAX_SIGNING_MESSAGE_LEN = 8192;
const MAX_SIGNATURE_LEN = 1024;
const MAX_HASH_LEN = 256;
const FORBIDDEN_EXACT_KEYS = new Set([
  'seedphrase',
  'recoveryphrase',
  'mnemonic',
  'privatekey',
  'secretkey',
  'delegatedsigner',
  'delegatesigner',
  'unlimitedapproval',
]);

export interface EvidenceRouteContext {
  store?: EvidenceStore;
  service?: EvidenceService;
  getSession(req: IncomingMessage): Promise<WorkflowSession | null | undefined> | WorkflowSession | null | undefined;
}

type EvidenceHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createEvidenceApiHandler(context: EvidenceRouteContext): EvidenceHandler {
  const service = context.service ?? (context.store ? new EvidenceService(context.store) : undefined);
  if (!service) {
    throw new Error('Evidence API handler requires an evidence service or store.');
  }

  return async (req, res) => handleEvidenceApiRequest(req, res, {
    service,
    getSession: context.getSession,
  });
}

export function evidenceStoreAdapterForCloudStore(store: CloudSessionStore): EvidenceStore {
  let state = cloudStoreEvidenceState.get(store);
  if (!state) {
    state = new Map();
    cloudStoreEvidenceState.set(store, state);
  }
  const records = state;

  return {
    async listEvidence(walletAddress) {
      return [...records.values()]
        .filter((record) => record.walletAddress === walletAddress)
        .map(clone);
    },
    async getEvidence(walletAddress, id) {
      const record = records.get(id);
      if (!record || record.walletAddress !== walletAddress) return undefined;
      return clone(record);
    },
    async saveEvidence(_walletAddress, record) {
      records.set(record.id, clone(record));
    },
    async deleteEvidence(walletAddress, id) {
      const record = records.get(id);
      if (!record || record.walletAddress !== walletAddress) return false;
      return records.delete(id);
    },
    async appendEvidenceAuditEvent(walletAddress, event: EvidenceAuditEvent) {
      await store.forWallet(walletAddress).insertAuditEvent({
        id: event.id,
        type: event.type,
        createdAt: event.createdAt,
        metadata: {
          ...event.metadata,
          recordType: event.recordType,
          recordId: event.recordId,
        },
      });
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function handleEvidenceApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: Required<Pick<EvidenceRouteContext, 'service' | 'getSession'>>,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const route = matchEvidenceRoute(url.pathname);
  if (!route) return false;

  try {
    const session = await context.getSession(req);
    if (!session?.walletAddress) {
      writeJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    if (route.name === 'collection') {
      await handleCollection(req, res, context.service, session);
      return true;
    }
    await handleRecord(req, res, context.service, session, route.id);
    return true;
  } catch (err) {
    writeRouteError(res, err);
    return true;
  }
}

type EvidenceRoute = { name: 'collection' } | { name: 'record'; id: string };

function matchEvidenceRoute(pathname: string): EvidenceRoute | undefined {
  if (pathname === '/api/evidence') return { name: 'collection' };
  const record = /^\/api\/evidence\/([^/]+)$/.exec(pathname);
  if (record?.[1]) return { name: 'record', id: validateRecordId(record[1], 'evidence id') };
  return undefined;
}

async function handleCollection(
  req: IncomingMessage,
  res: ServerResponse,
  service: EvidenceService,
  session: WorkflowSession,
): Promise<void> {
  if (req.method === 'POST') {
    const receipt = await service.createReceipt(session, validateCreateEvidenceRequest(await readJsonBody(req)));
    writeJson(res, 201, { receipt });
    return;
  }
  if (req.method === 'GET') {
    writeJson(res, 200, { receipts: await service.listReceipts(session) });
    return;
  }
  methodNotAllowed(res);
}

async function handleRecord(
  req: IncomingMessage,
  res: ServerResponse,
  service: EvidenceService,
  session: WorkflowSession,
  id: string,
): Promise<void> {
  if (req.method === 'DELETE') {
    await service.deleteReceipt(session, id);
    writeJson(res, 200, { ok: true });
    return;
  }
  methodNotAllowed(res);
}

export function validateCreateEvidenceRequest(body: unknown): CreateEvidenceReceiptInput {
  assertNoForbiddenEvidenceSecrets(body);
  const input = requireObject(body, 'request body');
  const title = requiredShortString(input.title, 'title');
  const kind = requireKind(input.kind);
  const status = requireStatus(input.status);
  const cluster = requireCluster(input.cluster);
  const payload = requireJsonObject(input.payload, 'payload');
  const preSignatureHash = requiredHash(input.preSignatureHash, 'preSignatureHash');
  const signingMessage = requiredSigningMessage(input.signingMessage);
  const signature = requiredSignature(input.signature);
  return {
    title,
    kind,
    status,
    cluster,
    payload,
    preSignatureHash,
    signingMessage,
    signature,
    ...(optionalHash(input.artifactHash, 'artifactHash') ? { artifactHash: optionalHash(input.artifactHash, 'artifactHash') } : {}),
    ...(optionalShortString(input.receiptType, 'receiptType') ? { receiptType: optionalShortString(input.receiptType, 'receiptType') } : {}),
    ...(optionalShortString(input.summary, 'summary') ? { summary: optionalShortString(input.summary, 'summary') } : {}),
    ...(optionalShortString(input.verdict, 'verdict') ? { verdict: optionalShortString(input.verdict, 'verdict') } : {}),
    ...(optionalShortString(input.effect, 'effect') ? { effect: optionalShortString(input.effect, 'effect') } : {}),
    ...(input.metadata === undefined ? {} : { metadata: requireJsonObject(input.metadata, 'metadata') }),
  };
}

function requireCluster(value: unknown): WorkflowCluster {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    throw new WorkflowValidationError('missing_field', 'cluster is required.');
  }
  const cluster = requiredString(value, 'cluster').trim();
  if (!WORKFLOW_CLUSTERS.includes(cluster as WorkflowCluster)) {
    throw new WorkflowValidationError(
      'invalid_cluster',
      `cluster must be one of ${WORKFLOW_CLUSTERS.join(', ')}.`,
    );
  }
  return cluster as WorkflowCluster;
}

function requireKind(value: unknown): EvidenceReceiptKind {
  const kind = requiredString(value, 'kind').trim();
  if (!EVIDENCE_RECEIPT_KINDS.includes(kind as EvidenceReceiptKind)) {
    throw new WorkflowValidationError(
      'invalid_kind',
      `kind must be one of ${EVIDENCE_RECEIPT_KINDS.join(', ')}.`,
    );
  }
  return kind as EvidenceReceiptKind;
}

function requireStatus(value: unknown): EvidenceReceiptStatus {
  const status = requiredString(value, 'status').trim();
  if (!EVIDENCE_RECEIPT_STATUSES.includes(status as EvidenceReceiptStatus)) {
    throw new WorkflowValidationError(
      'invalid_status',
      `status must be one of ${EVIDENCE_RECEIPT_STATUSES.join(', ')}.`,
    );
  }
  return status as EvidenceReceiptStatus;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw new WorkflowValidationError('body_too_large', 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new WorkflowValidationError('invalid_json', 'Request body must be valid JSON.');
  }
}

function methodNotAllowed(res: ServerResponse): void {
  writeJson(res, 405, { error: 'method_not_allowed' });
}

function writeRouteError(res: ServerResponse, err: unknown): void {
  if (err instanceof WorkflowValidationError) {
    writeJson(res, 400, { error: err.code, message: err.message });
    return;
  }
  if (err instanceof EvidenceServiceError) {
    writeJson(res, err.status, { error: err.code, message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected evidence API error.';
  writeJson(res, 500, { error: 'internal_error', message });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', `${label} must be a string.`);
  }
  return value;
}

function requiredShortString(value: unknown, label: string): string {
  const trimmed = requiredString(value, label).trim();
  if (!trimmed) {
    throw new WorkflowValidationError('missing_field', `${label} is required.`);
  }
  if (trimmed.length > MAX_SHORT_FIELD_LEN) {
    throw new WorkflowValidationError('field_too_long', `${label} must be at most ${MAX_SHORT_FIELD_LEN} characters.`);
  }
  return trimmed;
}

function optionalShortString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', `${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_SHORT_FIELD_LEN) {
    throw new WorkflowValidationError('field_too_long', `${label} must be at most ${MAX_SHORT_FIELD_LEN} characters.`);
  }
  return trimmed;
}

function requiredHash(value: unknown, label: string): string {
  const trimmed = requiredString(value, label).trim();
  if (!trimmed) {
    throw new WorkflowValidationError('missing_field', `${label} is required.`);
  }
  if (trimmed.length > MAX_HASH_LEN) {
    throw new WorkflowValidationError('field_too_long', `${label} must be at most ${MAX_HASH_LEN} characters.`);
  }
  return trimmed;
}

function optionalHash(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredHash(value, label);
}

function requiredSigningMessage(value: unknown): string {
  const text = requiredString(value, 'signingMessage');
  if (!text.trim()) {
    throw new WorkflowValidationError('missing_field', 'signingMessage is required.');
  }
  if (text.length > MAX_SIGNING_MESSAGE_LEN) {
    throw new WorkflowValidationError('field_too_long', `signingMessage must be at most ${MAX_SIGNING_MESSAGE_LEN} characters.`);
  }
  return text;
}

function requiredSignature(value: unknown): string {
  const trimmed = requiredString(value, 'signature').trim();
  if (!trimmed) {
    throw new WorkflowValidationError('missing_field', 'signature is required.');
  }
  if (trimmed.length > MAX_SIGNATURE_LEN) {
    throw new WorkflowValidationError('field_too_long', `signature must be at most ${MAX_SIGNATURE_LEN} characters.`);
  }
  return trimmed;
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  return coerceJsonObject(value, label);
}

function coerceJsonObject(value: unknown, label: string): JsonObject {
  const object = requireObject(value, label);
  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(object)) {
    output[key] = coerceJsonValue(entry, `${label}.${key}`);
  }
  return output;
}

function coerceJsonValue(value: unknown, label: string): JsonObject[string] {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WorkflowValidationError('invalid_json', `${label} must be finite.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => coerceJsonValue(entry, `${label}[${index}]`));
  }
  if (typeof value === 'object') {
    return coerceJsonObject(value, label);
  }
  throw new WorkflowValidationError('invalid_json', `${label} must be JSON serializable.`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_object', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertNoForbiddenEvidenceSecrets(value: unknown, path = '$'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenEvidenceSecrets(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (FORBIDDEN_EXACT_KEYS.has(normalized) || normalized.includes('privatekey') || normalized.includes('secretkey')) {
      throw new WorkflowValidationError('forbidden_secret', `${path}.${key} is not accepted by the evidence archive.`);
    }
    if (
      (normalized.includes('approvalauthority') || normalized.includes('signingauthority') || normalized.includes('authority')) &&
      indicatesUnlimitedAuthority(entry)
    ) {
      throw new WorkflowValidationError('forbidden_authority', `${path}.${key} cannot grant unlimited approval authority.`);
    }
    assertNoForbiddenEvidenceSecrets(entry, `${path}.${key}`);
  }
}

function indicatesUnlimitedAuthority(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    return normalized.includes('unlimited') || normalized.includes('delegate') || normalized.includes('any amount');
  }
  if (typeof value === 'number') return !Number.isFinite(value);
  return false;
}
