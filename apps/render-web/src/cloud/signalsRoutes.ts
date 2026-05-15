import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  WorkflowValidationError,
  type AuditEventRecord,
  type JsonObject,
} from '@solana-agent-wallet-adapter/workflow';
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';

import {
  registerDevApiHandler,
  type DevApiHandler,
  type DevApiHandlerContext,
} from './devApiRegistry.js';
import {
  isSignalsStore,
  type SignalEmissionStoreRecord,
  type SignalFeedStoreRecord,
  type SignalSubscriptionStoreRecord,
  type SignalsStore,
} from './store.js';

const PREFIX = '/api/signals/';
const MAX_JSON_BYTES = 64 * 1024;
const FEEDS_PATH = '/api/signals/feeds';
const SUBSCRIPTIONS_PATH = '/api/signals/subscriptions';
const FEED_DETAIL_RE = /^\/api\/signals\/feeds\/([A-Za-z0-9_-]+)$/;
const FEED_EMISSIONS_RE = /^\/api\/signals\/feeds\/([A-Za-z0-9_-]+)\/emissions$/;
const SUBSCRIPTION_TRANSITION_RE = /^\/api\/signals\/subscriptions\/([A-Za-z0-9_-]+)\/(pause|resume|revoke)$/;

const FORBIDDEN_AUTHORITY_KEYS = new Set(['delegatedSigner', 'privateKey', 'seedPhrase', 'approvalAuthority']);
const MAX_FEED_NAME_LEN = 200;
const MAX_FEED_DESCRIPTION_LEN = 4_000;
const MIN_SOURCE_TXID_LEN = 32;

type SignalSubscriptionStatus = 'active' | 'paused' | 'revoked';
type SubscriptionTransition = 'pause' | 'resume' | 'revoke';

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large.');
    this.name = 'BodyTooLargeError';
  }
}

class InvalidJsonError extends Error {
  constructor() {
    super('Request body must be valid JSON.');
    this.name = 'InvalidJsonError';
  }
}

export async function handleSignalsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: DevApiHandlerContext,
): Promise<boolean> {
  if (!context.walletAddress) {
    writeJsonNoStore(res, 403, {
      error: 'dev_layer1_disabled',
      message: 'This route is only available to allowlisted dev wallets.',
    });
    return true;
  }

  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'POST' && path === FEEDS_PATH) {
    await handleCreateFeed(req, res, context);
    return true;
  }
  if (method === 'GET' && path === FEEDS_PATH) {
    await handleListFeeds(res, url, context);
    return true;
  }
  const feedDetail = FEED_DETAIL_RE.exec(path);
  if (feedDetail && method === 'GET') {
    await handleGetFeed(res, context, feedDetail[1] ?? '');
    return true;
  }
  const emissionsMatch = FEED_EMISSIONS_RE.exec(path);
  if (emissionsMatch && method === 'POST') {
    await handleCreateEmission(req, res, context, emissionsMatch[1] ?? '');
    return true;
  }
  if (method === 'POST' && path === SUBSCRIPTIONS_PATH) {
    await handleCreateSubscription(req, res, context);
    return true;
  }
  if (method === 'GET' && path === SUBSCRIPTIONS_PATH) {
    await handleListSubscriptions(res, context);
    return true;
  }
  const transition = SUBSCRIPTION_TRANSITION_RE.exec(path);
  if (transition && method === 'POST') {
    await handleTransitionSubscription(
      res,
      context,
      transition[1] ?? '',
      transition[2] as SubscriptionTransition,
    );
    return true;
  }
  return false;
}

async function handleCreateFeed(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  try {
    const store = requireSignalsStore(context.workflowStore);
    const body = await readJsonBody(req);
    const parsed = parseCreateFeedBody(body);
    const wallet = context.walletAddress!;
    const nowIso = context.clock.now().toISOString();
    const id = `feed_${randomUUID()}`;
    const feed = {
      id,
      publisherWallet: wallet,
      name: parsed.name,
      description: parsed.description,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: 'active' as const,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    };
    const record: SignalFeedStoreRecord = {
      id,
      publisherWallet: wallet,
      status: 'active',
      createdAt: nowIso,
      updatedAt: nowIso,
      feed,
    };
    const saved = await store.saveSignalFeed(record);
    await appendSignalsAuditEvent(context, 'signals.feed.created', id, {
      feedId: id,
      publisherWallet: wallet,
      name: parsed.name,
    });
    writeJsonNoStore(res, 201, { feed: extractFeed(saved) });
  } catch (err) {
    writeSignalsError(res, err);
  }
}

async function handleListFeeds(
  res: ServerResponse,
  url: URL,
  context: DevApiHandlerContext,
): Promise<void> {
  try {
    const store = requireSignalsStore(context.workflowStore);
    const publisherParam = url.searchParams.get('publisher');
    const publisherWallet = publisherParam && publisherParam.length > 0
      ? publisherParam
      : context.walletAddress!;
    const records = await store.listSignalFeedsByPublisher(publisherWallet);
    const feeds = records.map(extractFeed);
    writeJsonNoStore(res, 200, { feeds });
  } catch (err) {
    writeSignalsError(res, err);
  }
}

async function handleGetFeed(
  res: ServerResponse,
  context: DevApiHandlerContext,
  feedId: string,
): Promise<void> {
  try {
    const store = requireSignalsStore(context.workflowStore);
    const record = await store.getSignalFeed(feedId);
    if (!record) {
      writeJsonNoStore(res, 404, {
        error: 'feed_not_found',
        message: `No signal feed found for id ${feedId}.`,
      });
      return;
    }
    writeJsonNoStore(res, 200, { feed: extractFeed(record) });
  } catch (err) {
    writeSignalsError(res, err);
  }
}

async function handleCreateEmission(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
  feedId: string,
): Promise<void> {
  try {
    const store = requireSignalsStore(context.workflowStore);
    const body = await readJsonBody(req);
    const parsed = parseCreateEmissionBody(body, feedId);
    const wallet = context.walletAddress!;
    const feedRecord = await store.getSignalFeed(feedId);
    if (!feedRecord) {
      writeJsonNoStore(res, 404, {
        error: 'feed_not_found',
        message: `No signal feed found for id ${feedId}.`,
      });
      return;
    }
    if (feedRecord.publisherWallet !== wallet) {
      writeJsonNoStore(res, 403, {
        error: 'not_feed_owner',
        message: 'Only the feed publisher may emit signals on this feed.',
      });
      return;
    }
    if (feedRecord.status !== 'active') {
      writeJsonNoStore(res, 409, {
        error: 'feed_not_active',
        message: `Feed status is ${feedRecord.status}; only active feeds accept emissions.`,
      });
      return;
    }
    const nowIso = context.clock.now().toISOString();
    const id = `emission_${randomUUID()}`;
    const emission = {
      id,
      feedId,
      publisherWallet: wallet,
      emittedAt: nowIso,
      sourceTxid: parsed.sourceTxid,
      actionTemplate: parsed.actionTemplate,
      delivered: 0,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    };
    const record: SignalEmissionStoreRecord = {
      id,
      feedId,
      publisherWallet: wallet,
      emittedAt: nowIso,
      delivered: 0,
      emission,
    };
    const saved = await store.saveSignalEmission(record);
    await appendSignalsAuditEvent(context, 'signals.emission.created', id, {
      emissionId: id,
      feedId,
      publisherWallet: wallet,
      sourceTxid: parsed.sourceTxid,
    });
    writeJsonNoStore(res, 201, { emission: extractEmission(saved) });
  } catch (err) {
    writeSignalsError(res, err);
  }
}

async function handleCreateSubscription(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  try {
    const store = requireSignalsStore(context.workflowStore);
    const body = await readJsonBody(req);
    const parsed = parseCreateSubscriptionBody(body);
    // Run the shared validator against the normalized route body.
    DevLayer1.signals.validateCreateSignalSubscriptionRequest({
      feedId: parsed.feedId,
      caps: parsed.caps,
    });
    const wallet = context.walletAddress!;
    const feedRecord = await store.getSignalFeed(parsed.feedId);
    if (!feedRecord) {
      writeJsonNoStore(res, 404, {
        error: 'feed_not_found',
        message: `No signal feed found for id ${parsed.feedId}.`,
      });
      return;
    }
    const existing = await store.listSignalSubscriptionsForFollower(wallet);
    const conflict = existing.find(
      (sub) => sub.feedId === parsed.feedId && sub.status !== 'revoked',
    );
    if (conflict) {
      writeJsonNoStore(res, 409, {
        error: 'subscription_exists',
        message: 'Follower already has a non-revoked subscription to this feed.',
        existingId: conflict.id,
      });
      return;
    }
    const nowIso = context.clock.now().toISOString();
    const id = `sub_${randomUUID()}`;
    const subscription = {
      id,
      followerWallet: wallet,
      feedId: parsed.feedId,
      caps: parsed.caps,
      subscribedAt: nowIso,
      updatedAt: nowIso,
      status: 'active' as const,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    };
    const record: SignalSubscriptionStoreRecord = {
      id,
      followerWallet: wallet,
      feedId: parsed.feedId,
      status: 'active',
      subscribedAt: nowIso,
      updatedAt: nowIso,
      subscription,
    };
    const saved = await store.saveSignalSubscription(record);
    await appendSignalsAuditEvent(context, 'signals.subscription.created', id, {
      subscriptionId: id,
      feedId: parsed.feedId,
      followerWallet: wallet,
    });
    writeJsonNoStore(res, 201, { subscription: extractSubscription(saved) });
  } catch (err) {
    writeSignalsError(res, err);
  }
}

async function handleListSubscriptions(
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  try {
    const store = requireSignalsStore(context.workflowStore);
    const wallet = context.walletAddress!;
    const records = await store.listSignalSubscriptionsForFollower(wallet);
    const subscriptions = records.map(extractSubscription);
    writeJsonNoStore(res, 200, { subscriptions });
  } catch (err) {
    writeSignalsError(res, err);
  }
}

async function handleTransitionSubscription(
  res: ServerResponse,
  context: DevApiHandlerContext,
  subscriptionId: string,
  action: SubscriptionTransition,
): Promise<void> {
  try {
    const store = requireSignalsStore(context.workflowStore);
    const wallet = context.walletAddress!;
    // The SignalsStore offers no by-id lookup; we list the caller's subs
    // and match by id. A subscription owned by another follower therefore
    // returns 404 rather than 403 — that's the safer leak-free behavior
    // (the caller cannot prove a peer's subscription exists).
    const ownedSubs = await store.listSignalSubscriptionsForFollower(wallet);
    const existing = ownedSubs.find((s) => s.id === subscriptionId);
    if (!existing) {
      writeJsonNoStore(res, 404, {
        error: 'subscription_not_found',
        message: `No signal subscription found for id ${subscriptionId}.`,
      });
      return;
    }

    if (action === 'revoke' && existing.status === 'revoked') {
      // Idempotent revoke — no audit entry, no state change.
      writeJsonNoStore(res, 200, { subscription: extractSubscription(existing) });
      return;
    }

    const nextStatus = nextStatusFor(action);
    const validFrom = validPriorStatuses(action);
    if (!validFrom.has(existing.status)) {
      writeJsonNoStore(res, 409, {
        error: 'invalid_state_transition',
        message: `Cannot ${action} a subscription in status ${existing.status}.`,
      });
      return;
    }

    const nowIso = context.clock.now().toISOString();
    const updatedInner = {
      ...extractSubscription(existing),
      status: nextStatus,
      updatedAt: nowIso,
    };
    const updated: SignalSubscriptionStoreRecord = {
      ...existing,
      status: nextStatus,
      updatedAt: nowIso,
      subscription: updatedInner,
    };
    const saved = await store.saveSignalSubscription(updated);
    await appendSignalsAuditEvent(
      context,
      auditTypeFor(action),
      subscriptionId,
      {
        subscriptionId,
        feedId: existing.feedId,
        followerWallet: wallet,
        previousStatus: existing.status,
        nextStatus,
      },
    );
    writeJsonNoStore(res, 200, { subscription: extractSubscription(saved) });
  } catch (err) {
    writeSignalsError(res, err);
  }
}

function nextStatusFor(action: SubscriptionTransition): SignalSubscriptionStatus {
  if (action === 'pause') return 'paused';
  if (action === 'resume') return 'active';
  return 'revoked';
}

function validPriorStatuses(action: SubscriptionTransition): Set<SignalSubscriptionStatus> {
  if (action === 'pause') return new Set(['active']);
  if (action === 'resume') return new Set(['paused']);
  return new Set(['active', 'paused']);
}

function auditTypeFor(action: SubscriptionTransition): string {
  if (action === 'pause') return 'signals.subscription.paused';
  if (action === 'resume') return 'signals.subscription.resumed';
  return 'signals.subscription.revoked';
}

function parseCreateFeedBody(body: unknown): {
  name: string;
  description: string;
  metadata?: JsonObject;
} {
  const obj = requireJsonObject(body, '$');
  rejectForbiddenAuthorityKeys(obj, '$');
  const name = requireString(obj.name, '$.name');
  if (name.length === 0 || name.length > MAX_FEED_NAME_LEN) {
    throw new WorkflowValidationError(
      'invalid_feed_name',
      `name must be a non-empty string of at most ${MAX_FEED_NAME_LEN} characters.`,
      '$.name',
    );
  }
  const description = requireString(obj.description, '$.description');
  if (description.length > MAX_FEED_DESCRIPTION_LEN) {
    throw new WorkflowValidationError(
      'invalid_feed_description',
      `description must be at most ${MAX_FEED_DESCRIPTION_LEN} characters.`,
      '$.description',
    );
  }
  const metadata = obj.metadata === undefined
    ? undefined
    : requireJsonObject(obj.metadata, '$.metadata');
  return metadata === undefined ? { name, description } : { name, description, metadata };
}

function parseCreateEmissionBody(body: unknown, feedId: string): {
  sourceTxid: string;
  actionTemplate: JsonObject;
  metadata?: JsonObject;
} {
  const obj = requireJsonObject(body, '$');
  rejectForbiddenAuthorityKeys(obj, '$');
  const sourceTxid = requireString(obj.sourceTxid, '$.sourceTxid');
  if (sourceTxid.length < MIN_SOURCE_TXID_LEN) {
    throw new WorkflowValidationError(
      'invalid_source_txid',
      `sourceTxid must be at least ${MIN_SOURCE_TXID_LEN} characters.`,
      '$.sourceTxid',
    );
  }
  const actionTemplate = requireJsonObject(obj.actionTemplate, '$.actionTemplate');
  const metadata = obj.metadata === undefined
    ? undefined
    : requireJsonObject(obj.metadata, '$.metadata');
  // Run the shared validator against the normalized route body.
  DevLayer1.signals.validateCreateSignalEmissionRequest({
    feedId,
    sourceTxid,
    actionTemplate,
  });
  return metadata === undefined
    ? { sourceTxid, actionTemplate }
    : { sourceTxid, actionTemplate, metadata };
}

function parseCreateSubscriptionBody(body: unknown): {
  feedId: string;
  caps: JsonObject;
  metadata?: JsonObject;
} {
  const obj = requireJsonObject(body, '$');
  rejectForbiddenAuthorityKeys(obj, '$');
  const feedId = requireString(obj.feedId, '$.feedId');
  if (feedId.length === 0) {
    throw new WorkflowValidationError('invalid_feed_id', 'feedId must be a non-empty string.', '$.feedId');
  }
  const capsRaw = requireJsonObject(obj.caps, '$.caps');
  const caps = parseCaps(capsRaw);
  const metadata = obj.metadata === undefined
    ? undefined
    : requireJsonObject(obj.metadata, '$.metadata');
  return metadata === undefined ? { feedId, caps } : { feedId, caps, metadata };
}

function parseCaps(raw: JsonObject): JsonObject {
  const perRunMaxAmount = requireString(raw.perRunMaxAmount, '$.caps.perRunMaxAmount');
  if (!isDecimalString(perRunMaxAmount)) {
    throw new WorkflowValidationError(
      'invalid_caps',
      'caps.perRunMaxAmount must be a non-empty decimal string.',
      '$.caps.perRunMaxAmount',
    );
  }
  const lifetimeMaxAmount = requireString(raw.lifetimeMaxAmount, '$.caps.lifetimeMaxAmount');
  if (!isDecimalString(lifetimeMaxAmount)) {
    throw new WorkflowValidationError(
      'invalid_caps',
      'caps.lifetimeMaxAmount must be a non-empty decimal string.',
      '$.caps.lifetimeMaxAmount',
    );
  }
  const allowlistedTokens = raw.allowlistedTokens;
  if (!Array.isArray(allowlistedTokens) || allowlistedTokens.length === 0) {
    throw new WorkflowValidationError(
      'invalid_caps',
      'caps.allowlistedTokens must be a non-empty array of strings.',
      '$.caps.allowlistedTokens',
    );
  }
  for (let i = 0; i < allowlistedTokens.length; i += 1) {
    const token = allowlistedTokens[i];
    if (typeof token !== 'string' || token.length === 0) {
      throw new WorkflowValidationError(
        'invalid_caps',
        'caps.allowlistedTokens entries must be non-empty strings.',
        `$.caps.allowlistedTokens[${i}]`,
      );
    }
  }

  const caps: JsonObject = {
    perRunMaxAmount,
    lifetimeMaxAmount,
    allowlistedTokens: [...allowlistedTokens],
  };

  if (raw.allowlistedRecipients !== undefined) {
    const recipients = raw.allowlistedRecipients;
    if (!Array.isArray(recipients)) {
      throw new WorkflowValidationError(
        'invalid_caps',
        'caps.allowlistedRecipients must be an array of strings.',
        '$.caps.allowlistedRecipients',
      );
    }
    for (let i = 0; i < recipients.length; i += 1) {
      const r = recipients[i];
      if (typeof r !== 'string' || r.length === 0) {
        throw new WorkflowValidationError(
          'invalid_caps',
          'caps.allowlistedRecipients entries must be non-empty strings.',
          `$.caps.allowlistedRecipients[${i}]`,
        );
      }
    }
    caps.allowlistedRecipients = [...recipients];
  }

  if (raw.expiresAt !== undefined) {
    const expiresAt = raw.expiresAt;
    if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
      throw new WorkflowValidationError(
        'invalid_caps',
        'caps.expiresAt must be an ISO-8601 timestamp.',
        '$.caps.expiresAt',
      );
    }
    caps.expiresAt = expiresAt;
  }

  if (raw.maxExecutions !== undefined) {
    const max = raw.maxExecutions;
    if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) {
      throw new WorkflowValidationError(
        'invalid_caps',
        'caps.maxExecutions must be a positive integer.',
        '$.caps.maxExecutions',
      );
    }
    caps.maxExecutions = max;
  }

  return caps;
}

function isDecimalString(value: string): boolean {
  if (value.length === 0) return false;
  return /^[0-9]+(\.[0-9]+)?$/.test(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', `${path} must be a string.`, path);
  }
  return value;
}

function requireJsonObject(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_object', `${path} must be a JSON object.`, path);
  }
  return value as JsonObject;
}

function rejectForbiddenAuthorityKeys(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      rejectForbiddenAuthorityKeys(value[i], `${path}[${i}]`);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(key)) {
      throw new WorkflowValidationError(
        'forbidden_authority_field',
        `Field "${key}" is not permitted on signal payloads.`,
        `${path}.${key}`,
      );
    }
    if (key === 'approvalAuthority' || key === 'authority') {
      const v = obj[key];
      if (v === 'unlimited') {
        throw new WorkflowValidationError(
          'forbidden_authority_field',
          'approvalAuthority "unlimited" is not permitted.',
          `${path}.${key}`,
        );
      }
    }
    rejectForbiddenAuthorityKeys(obj[key], `${path}.${key}`);
  }
}

function extractFeed(record: SignalFeedStoreRecord): JsonObject {
  return jsonObjectFrom(record.feed);
}

function extractSubscription(record: SignalSubscriptionStoreRecord): JsonObject {
  return jsonObjectFrom(record.subscription);
}

function extractEmission(record: SignalEmissionStoreRecord): JsonObject {
  return jsonObjectFrom(record.emission);
}

function jsonObjectFrom(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

function requireSignalsStore(store: unknown): SignalsStore {
  if (!isSignalsStore(store)) {
    throw new WorkflowValidationError(
      'signals_store_unavailable',
      'Signal storage is not configured for this deployment.',
      '$',
    );
  }
  return store;
}

async function appendSignalsAuditEvent(
  context: DevApiHandlerContext,
  type: string,
  recordId: string,
  metadata: JsonObject,
): Promise<void> {
  if (!context.walletAddress) return;
  const record: AuditEventRecord = {
    id: `audit_${randomUUID()}`,
    walletAddress: context.walletAddress,
    type,
    createdAt: context.clock.now().toISOString(),
    actor: 'user',
    recordType: signalRecordTypeFor(type),
    recordId,
    metadata,
  };
  await context.workflowStore.appendAuditEvent(context.walletAddress, record);
}

function signalRecordTypeFor(type: string): AuditEventRecord['recordType'] {
  if (type.includes('.feed.')) return 'signal_feed';
  if (type.includes('.emission.')) return 'signal_emission';
  return 'signal_subscription';
}

function writeSignalsError(res: ServerResponse, err: unknown): void {
  if (err instanceof BodyTooLargeError) {
    writeJsonNoStore(res, 413, { error: 'body_too_large', message: err.message });
    return;
  }
  if (err instanceof InvalidJsonError) {
    writeJsonNoStore(res, 400, { error: 'invalid_json', message: err.message });
    return;
  }
  if (err instanceof WorkflowValidationError) {
    if (err.code === 'signals_store_unavailable') {
      writeJsonNoStore(res, 500, {
        error: err.code,
        message: err.message,
        ...(err.path ? { path: err.path } : {}),
      });
      return;
    }
    const payload: JsonObject = { error: err.code ?? 'invalid_input', message: err.message };
    if (err.path) payload.path = err.path;
    writeJsonNoStore(res, 400, payload);
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[signalsRoutes] internal error', err);
  writeJsonNoStore(res, 500, {
    error: 'internal_error',
    message: err instanceof Error ? err.message : 'Unexpected server error.',
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError();
  }
}

function writeJsonNoStore(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

const signalsHandler: DevApiHandler = {
  prefix: PREFIX,
  methods: ['GET', 'POST'],
  handle: handleSignalsRequest,
};

registerDevApiHandler(signalsHandler);
