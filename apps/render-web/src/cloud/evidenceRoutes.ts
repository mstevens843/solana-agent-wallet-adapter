import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  EvidenceService,
  EvidenceServiceError,
  type EvidenceAuditEvent,
  type EvidenceReceiptRecord,
  type EvidenceStore,
} from './evidenceService.js';
import type { WorkflowStore as CloudSessionStore } from './store.js';
import {
  WorkflowValidationError,
  validateCreateEvidenceReceiptRequest,
  validateRecordId,
  type WorkflowSession,
} from './workflowValidation.js';
import { redactSecrets } from './redaction.js';

const cloudStoreEvidenceState = new WeakMap<CloudSessionStore, Map<string, EvidenceReceiptRecord>>();

const MAX_JSON_BYTES = 256 * 1024;

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
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = matchEvidenceRoute(url.pathname);
    if (!route) return false;

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
    const receipt = await service.createReceipt(session, validateCreateEvidenceReceiptRequest(await readJsonBody(req)));
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
  const message = err instanceof Error ? redactSecrets(err.message) : 'Unexpected evidence API error.';
  writeJson(res, 500, { error: 'internal_error', message });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}
