// Phase 0 scaffolding — Phase 2B will implement streaming session CRUD,
// voucher acceptance, revoke flow, and settlement receipt retrieval:
//   POST   /api/streaming/sessions                       → createSession()
//   POST   /api/streaming/sessions/:id/grant-signed      → recordGrantSigned()
//   GET    /api/streaming/sessions                       → listSessions()
//   GET    /api/streaming/sessions/:id                   → getSession()
//   POST   /api/streaming/sessions/:id/voucher           → acceptVoucher()
//   POST   /api/streaming/sessions/:id/revoke            → revokeSession()
//   POST   /api/streaming/sessions/:id/revoke-signed     → recordRevokeSigned()
//   GET    /api/streaming/sessions/:id/receipt           → settlement receipt(s)

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  registerDevApiHandler,
  type DevApiHandler,
  type DevApiHandlerContext,
} from './devApiRegistry.js';

const PREFIX = '/api/streaming/';
const SESSIONS_COLLECTION = '/api/streaming/sessions';
const SESSION_ITEM_RE =
  /^\/api\/streaming\/sessions\/([A-Za-z0-9_-]+)(?:\/(voucher|revoke|revoke-signed|grant-signed|receipt))?\/?$/;

function writeJsonNoStore(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function handleStreamingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: DevApiHandlerContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(PREFIX)) return false;

  const isCollection = url.pathname === SESSIONS_COLLECTION;
  const itemMatch = url.pathname.match(SESSION_ITEM_RE);
  if (!isCollection && !itemMatch) {
    writeJsonNoStore(res, 404, { error: 'not_found' });
    return true;
  }

  const method = req.method ?? 'GET';
  if (
    (isCollection && method !== 'GET' && method !== 'POST') ||
    (itemMatch && method !== 'GET' && method !== 'POST')
  ) {
    writeJsonNoStore(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  writeJsonNoStore(res, 501, {
    error: 'not_implemented',
    message: 'Streaming session handler is Phase 2B; this scaffolding returns 501 until then.',
    phase: 'phase_0_scaffolding',
    path: url.pathname,
    sessionId: itemMatch?.[1],
    subResource: itemMatch?.[2],
  });
  return true;
}

const streamingHandler: DevApiHandler = {
  prefix: PREFIX,
  methods: ['GET', 'HEAD', 'POST'],
  handle: handleStreamingRequest,
};

registerDevApiHandler(streamingHandler);
