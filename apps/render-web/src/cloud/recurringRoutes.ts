import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  RecurringNotificationDeliveryRecord,
  RecurringNotificationStore,
} from './notificationService.js';
import {
  RecurringService,
  RecurringServiceError,
  RecurringValidationError,
  RECURRING_OCCURRENCE_STATUSES,
  WorkflowValidationError,
  buildScheduleView,
  validateCreateRecurringRequest,
  validateRecurringId,
  validateUpdateRecurringRequest,
  type RecurringAuditEvent,
  type RecurringOccurrenceRecord,
  type RecurringOccurrenceStatus,
  type RecurringScheduleRecord,
  type RecurringSession,
  type RecurringStore,
} from './recurringService.js';
import { redactSecrets } from './redaction.js';
import type { WorkflowStore as CloudSessionStore } from './store.js';

const MAX_JSON_BYTES = 64 * 1024;
const cloudStoreRecurringState = new WeakMap<CloudSessionStore, RecurringStoreState>();

interface RecurringStoreState {
  schedules: Map<string, RecurringScheduleRecord>;
  occurrences: Map<string, RecurringOccurrenceRecord>;
  notificationDeliveries: Map<string, RecurringNotificationDeliveryRecord>;
}

export interface RecurringRouteContext {
  store?: RecurringStore;
  service?: RecurringService;
  getSession(req: IncomingMessage): Promise<RecurringSession | null | undefined> | RecurringSession | null | undefined;
}

type RecurringHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createRecurringApiHandler(context: RecurringRouteContext): RecurringHandler {
  const service = context.service ?? (context.store ? new RecurringService(context.store) : undefined);
  if (!service) {
    throw new Error('Recurring API handler requires a recurring service or store.');
  }
  return async (req, res) => handleRecurringApiRequest(req, res, {
    service,
    getSession: context.getSession,
  });
}

export function recurringStoreAdapterForCloudStore(store: CloudSessionStore): RecurringStore & RecurringNotificationStore {
  let state = cloudStoreRecurringState.get(store);
  if (!state) {
    state = {
      schedules: new Map(),
      occurrences: new Map(),
      notificationDeliveries: new Map(),
    };
    cloudStoreRecurringState.set(store, state);
  }

  return {
    async listSchedules(walletAddress) {
      return [...state.schedules.values()]
        .filter((record) => record.walletAddress === walletAddress)
        .map(clone);
    },
    async getSchedule(walletAddress, id) {
      return ownerClone(state.schedules.get(id), walletAddress);
    },
    async saveSchedule(_walletAddress, record) {
      state.schedules.set(record.id, clone(record));
    },
    async deleteSchedule(walletAddress, id) {
      const record = state.schedules.get(id);
      if (!record || record.walletAddress !== walletAddress) return false;
      state.schedules.delete(id);
      for (const [occurrenceId, occurrence] of state.occurrences) {
        if (occurrence.recurringScheduleId === id && occurrence.walletAddress === walletAddress) {
          state.occurrences.delete(occurrenceId);
        }
      }
      return true;
    },
    async listOccurrences(walletAddress, scheduleId) {
      return [...state.occurrences.values()]
        .filter((record) => record.walletAddress === walletAddress)
        .filter((record) => (scheduleId ? record.recurringScheduleId === scheduleId : true))
        .map(clone);
    },
    async getOccurrence(walletAddress, id) {
      return ownerClone(state.occurrences.get(id), walletAddress);
    },
    async saveOccurrence(_walletAddress, record) {
      state.occurrences.set(record.id, clone(record));
    },
    async claimOccurrence(_walletAddress, record) {
      for (const existing of state.occurrences.values()) {
        if (
          existing.walletAddress === record.walletAddress &&
          existing.recurringScheduleId === record.recurringScheduleId &&
          existing.occurrenceKey === record.occurrenceKey
        ) {
          return { created: false, occurrence: clone(existing) };
        }
      }
      state.occurrences.set(record.id, clone(record));
      return { created: true, occurrence: clone(record) };
    },
    async findOccurrenceByKey(walletAddress, scheduleId, occurrenceKey) {
      for (const record of state.occurrences.values()) {
        if (
          record.walletAddress === walletAddress &&
          record.recurringScheduleId === scheduleId &&
          record.occurrenceKey === occurrenceKey
        ) {
          return clone(record);
        }
      }
      return undefined;
    },
    async appendAuditEvent(walletAddress, record: RecurringAuditEvent) {
      await store.forWallet(walletAddress).insertAuditEvent({
        id: record.id,
        type: record.type,
        createdAt: record.createdAt,
        metadata: {
          ...record.metadata,
          scheduleId: record.scheduleId,
          ...(record.occurrenceId ? { occurrenceId: record.occurrenceId } : {}),
          ...(record.occurrenceKey ? { occurrenceKey: record.occurrenceKey } : {}),
        },
      });
    },
    async listKnownWallets() {
      const wallets = new Set<string>();
      for (const record of state.schedules.values()) wallets.add(record.walletAddress);
      return [...wallets];
    },
    async saveNotificationDelivery(record) {
      state.notificationDeliveries.set(record.id, clone(record));
    },
    async findNotificationDelivery(walletAddress, occurrenceId, type) {
      for (const record of state.notificationDeliveries.values()) {
        if (
          record.walletAddress === walletAddress &&
          record.occurrenceId === occurrenceId &&
          record.type === type
        ) {
          return clone(record);
        }
      }
      return undefined;
    },
    async listDueNotificationDeliveries(nowIso, limit) {
      const now = Date.parse(nowIso);
      return [...state.notificationDeliveries.values()]
        .filter((record) => record.status === 'pending' || record.status === 'failed')
        .filter((record) => Date.parse(record.nextAttemptAt) <= now)
        .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
        .slice(0, limit)
        .map(clone);
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ownerClone<T extends { walletAddress: string }>(record: T | undefined, walletAddress: string): T | undefined {
  if (!record || record.walletAddress !== walletAddress) return undefined;
  return clone(record);
}

export async function handleRecurringApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: Required<Pick<RecurringRouteContext, 'service' | 'getSession'>>,
): Promise<boolean> {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = matchRecurringRoute(url.pathname, url);
    if (!route) return false;

    const session = await context.getSession(req);
    if (!session?.walletAddress) {
      writeJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    switch (route.name) {
      case 'collection':
        await handleCollection(req, res, context.service, session);
        return true;
      case 'item':
        await handleItem(req, res, context.service, session, route.id);
        return true;
      case 'materialize':
        await handleMaterialize(req, res, context.service, session);
        return true;
      case 'occurrences':
        await handleOccurrences(req, res, context.service, session, route.id, route.url);
        return true;
      case 'pause':
        await handlePauseResume(req, res, context.service, session, route.id, 'paused');
        return true;
      case 'resume':
        await handlePauseResume(req, res, context.service, session, route.id, 'active');
        return true;
    }
  } catch (err) {
    writeRouteError(res, err);
    return true;
  }
}

type RecurringRoute =
  | { name: 'collection' }
  | { name: 'item'; id: string }
  | { name: 'materialize' }
  | { name: 'occurrences'; id: string; url: URL }
  | { name: 'pause'; id: string }
  | { name: 'resume'; id: string };

function matchRecurringRoute(pathname: string, url?: URL): RecurringRoute | undefined {
  if (pathname === '/api/recurring') return { name: 'collection' };
  if (pathname === '/api/recurring/materialize-due') return { name: 'materialize' };
  const occurrencesMatch = /^\/api\/recurring\/([^/]+)\/occurrences$/.exec(pathname);
  if (occurrencesMatch?.[1] && url) {
    return { name: 'occurrences', id: validateRecurringId(occurrencesMatch[1]), url };
  }
  const pauseMatch = /^\/api\/recurring\/([^/]+)\/pause$/.exec(pathname);
  if (pauseMatch?.[1]) return { name: 'pause', id: validateRecurringId(pauseMatch[1]) };
  const resumeMatch = /^\/api\/recurring\/([^/]+)\/resume$/.exec(pathname);
  if (resumeMatch?.[1]) return { name: 'resume', id: validateRecurringId(resumeMatch[1]) };
  const match = /^\/api\/recurring\/([^/]+)$/.exec(pathname);
  if (match?.[1]) return { name: 'item', id: validateRecurringId(match[1]) };
  return undefined;
}

async function handleCollection(
  req: IncomingMessage,
  res: ServerResponse,
  service: RecurringService,
  session: RecurringSession,
): Promise<void> {
  if (req.method === 'POST') {
    const schedule = await service.createSchedule(session, validateCreateRecurringRequest(await readJsonBody(req)));
    const view = buildScheduleView(schedule);
    writeJson(res, 201, {
      schedule: view.schedule,
      lifetimeSpend: view.lifetimeSpend,
      nextRuns: view.nextRuns,
    });
    return;
  }
  if (req.method === 'GET') {
    await service.materializeDueOccurrences(session);
    const list = await service.listSchedules(session);
    const views = list.schedules.map((s) => buildScheduleView(s));
    writeJson(res, 200, {
      schedules: views.map((v) => v.schedule),
      occurrences: list.occurrences,
      views: Object.fromEntries(
        views.map((v) => [v.schedule.id, { lifetimeSpend: v.lifetimeSpend, nextRuns: v.nextRuns }]),
      ),
    });
    return;
  }
  methodNotAllowed(res);
}

async function handleItem(
  req: IncomingMessage,
  res: ServerResponse,
  service: RecurringService,
  session: RecurringSession,
  id: string,
): Promise<void> {
  if (req.method === 'PATCH') {
    const schedule = await service.updateSchedule(session, id, validateUpdateRecurringRequest(await readJsonBody(req)));
    const view = buildScheduleView(schedule);
    writeJson(res, 200, {
      schedule: view.schedule,
      lifetimeSpend: view.lifetimeSpend,
      nextRuns: view.nextRuns,
    });
    return;
  }
  if (req.method === 'DELETE') {
    await service.deleteSchedule(session, id);
    writeJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET') {
    const view = buildScheduleView(await service.getSchedule(session, id));
    writeJson(res, 200, {
      schedule: view.schedule,
      lifetimeSpend: view.lifetimeSpend,
      nextRuns: view.nextRuns,
    });
    return;
  }
  methodNotAllowed(res);
}

async function handleMaterialize(
  req: IncomingMessage,
  res: ServerResponse,
  service: RecurringService,
  session: RecurringSession,
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  const results = await service.materializeDueOccurrences(session);
  writeJson(res, 200, { results });
}

async function handleOccurrences(
  req: IncomingMessage,
  res: ServerResponse,
  service: RecurringService,
  session: RecurringSession,
  scheduleId: string,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    methodNotAllowed(res);
    return;
  }
  const statusParam = parseOccurrenceStatusParam(url.searchParams.get('status'));
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 0, 1), 200) : 50;
  const result = await service.listScheduleOccurrences(session, scheduleId, {
    ...(statusParam ? { status: statusParam as RecurringOccurrenceRecord['status'] } : {}),
    cursor,
    limit,
  });
  writeJson(res, 200, result);
}

function parseOccurrenceStatusParam(value: string | null): RecurringOccurrenceStatus | undefined {
  if (!value) return undefined;
  if ((RECURRING_OCCURRENCE_STATUSES as readonly string[]).includes(value)) {
    return value as RecurringOccurrenceStatus;
  }
  throw new RecurringValidationError(
    'invalid_occurrence_status',
    `status must be one of ${RECURRING_OCCURRENCE_STATUSES.join(', ')}.`,
  );
}

async function handlePauseResume(
  req: IncomingMessage,
  res: ServerResponse,
  service: RecurringService,
  session: RecurringSession,
  scheduleId: string,
  nextStatus: 'paused' | 'active',
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  const schedule = await service.updateSchedule(session, scheduleId, { status: nextStatus });
  const view = buildScheduleView(schedule);
  writeJson(res, 200, {
    schedule: view.schedule,
    lifetimeSpend: view.lifetimeSpend,
    nextRuns: view.nextRuns,
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw new RecurringValidationError('body_too_large', 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RecurringValidationError('invalid_json', 'Request body must be valid JSON.');
  }
}

function methodNotAllowed(res: ServerResponse): void {
  writeJson(res, 405, { error: 'method_not_allowed' });
}

function writeRouteError(res: ServerResponse, err: unknown): void {
  if (err instanceof RecurringValidationError || err instanceof WorkflowValidationError) {
    writeJson(res, 400, { error: err.code, message: err.message });
    return;
  }
  if (err instanceof RecurringServiceError) {
    writeJson(res, err.status, { error: err.code, message: err.message });
    return;
  }
  const message = err instanceof Error ? redactSecrets(err.message) : 'Unexpected recurring API error.';
  writeJson(res, 500, { error: 'internal_error', message });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}
