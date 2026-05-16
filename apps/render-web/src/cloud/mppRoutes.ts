// Phase 0 scaffolding — Phase 1 will implement the MPP HTTP-402 handler flow:
//   POST /api/mpp/challenge → parse + verify, build approval params, return approvalId
//   POST /api/mpp/settle    → finalize evidence receipt (kind: 'mpp_session')
//   GET  /api/mpp/config    → return wallet_preferences row for namespace='mpp-config'
//
// Auth gating mirrors AP2/ACP (dev-layer-1 + allowlisted wallet via the
// registry's session resolver).

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  registerDevApiHandler,
  type DevApiHandler,
  type DevApiHandlerContext,
} from './devApiRegistry.js';

const PREFIX = '/api/mpp/';
const CHALLENGE_PATH = '/api/mpp/challenge';
const SETTLE_PATH = '/api/mpp/settle';
const CONFIG_PATH = '/api/mpp/config';

function writeJsonNoStore(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function handleMppRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: DevApiHandlerContext,
): Promise<boolean> {
  if (
    url.pathname !== CHALLENGE_PATH &&
    url.pathname !== SETTLE_PATH &&
    url.pathname !== CONFIG_PATH
  ) {
    return false;
  }

  if (url.pathname === CONFIG_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJsonNoStore(res, 405, { error: 'method_not_allowed' });
      return true;
    }
  } else if (req.method !== 'POST') {
    writeJsonNoStore(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  writeJsonNoStore(res, 501, {
    error: 'not_implemented',
    message: 'MPP handler is Phase 1; this scaffolding returns 501 until then.',
    phase: 'phase_0_scaffolding',
    path: url.pathname,
  });
  return true;
}

const mppHandler: DevApiHandler = {
  prefix: PREFIX,
  methods: ['GET', 'HEAD', 'POST'],
  handle: handleMppRequest,
};

registerDevApiHandler(mppHandler);
