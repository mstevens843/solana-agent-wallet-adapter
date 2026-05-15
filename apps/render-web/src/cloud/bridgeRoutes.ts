import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { PublicKey } from '@solana/web3.js';

import { registerDevApiHandler, type DevApiHandler } from './devApiRegistry.js';

// TODO: Replace with import from `@solana-agent-wallet-adapter/bridge-router`
// once Agent 4 ships router.ts. At that point also add the workspace dep
// to apps/render-web/package.json.
interface SettlementRequest {
  amountUsd: number;
  recipient: string;
  targetMint?: string;
  allowOffCurveRecipient?: boolean;
}

interface SettlementRoute {
  quoteId: string;
  source: 'placeholder';
  inputUsd: number;
  outputAmount: string;
  outputMint: string;
  slippageBps: number;
  estimatedFeeLamports: number;
  hops: readonly unknown[];
  expiresAt: string;
  note: string;
}

const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const QUOTE_TTL_MS = 60_000;

function findOptimalSettlement(request: SettlementRequest): SettlementRoute {
  const outputMint = request.targetMint ?? USDC_MAINNET_MINT;
  // USDC has 6 decimals. Placeholder math: 1 USD == 1 USDC (no FX adjustment).
  const outputAmount = Math.round(request.amountUsd * 1_000_000).toString();
  return {
    quoteId: randomUUID(),
    source: 'placeholder',
    inputUsd: request.amountUsd,
    outputAmount,
    outputMint,
    slippageBps: 50,
    estimatedFeeLamports: 5000,
    hops: [],
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    note: 'Placeholder route — Agent 4 (bridge-router) not yet implemented.',
  };
}

const QUOTE_PREFIX = '/api/agents/settlement/quote';
const MAX_JSON_BYTES = 16 * 1024;
const MAX_AMOUNT_USD = 100_000;

class ValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large.');
    this.name = 'BodyTooLargeError';
  }
}

const quoteHandler: DevApiHandler = {
  prefix: QUOTE_PREFIX,
  methods: ['POST'],
  async handle(req, res, _url, _context) {
    try {
      const raw = await readJsonBody(req);
      const parsed = parseSettlementRequest(raw);
      const route = findOptimalSettlement(parsed);
      writeJsonNoStore(res, 200, { route });
    } catch (err) {
      if (err instanceof ValidationError) {
        writeJsonNoStore(res, 400, { error: err.code, message: err.message });
        return true;
      }
      if (err instanceof BodyTooLargeError) {
        writeJsonNoStore(res, 413, { error: 'body_too_large', message: err.message });
        return true;
      }
      writeJsonNoStore(res, 500, { error: 'internal_error' });
    }
    return true;
  },
};

function parseSettlementRequest(body: unknown): SettlementRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('invalid_input', 'Request body must be a JSON object.');
  }
  const o = body as Record<string, unknown>;

  const amountUsd = o.amountUsd;
  if (
    typeof amountUsd !== 'number' ||
    !Number.isFinite(amountUsd) ||
    amountUsd <= 0 ||
    amountUsd > MAX_AMOUNT_USD
  ) {
    throw new ValidationError(
      'invalid_amount',
      `amountUsd must be a finite number greater than 0 and at most ${MAX_AMOUNT_USD}.`,
    );
  }

  const recipient = o.recipient;
  if (typeof recipient !== 'string' || recipient.length === 0) {
    throw new ValidationError('invalid_recipient', 'recipient must be a non-empty string.');
  }

  const allowOffCurveRecipient = o.allowOffCurveRecipient === true;

  let recipientKey: PublicKey;
  try {
    recipientKey = new PublicKey(recipient);
  } catch {
    throw new ValidationError('invalid_recipient', 'recipient must be a valid Solana public key.');
  }
  if (!allowOffCurveRecipient && !PublicKey.isOnCurve(recipientKey.toBuffer())) {
    throw new ValidationError(
      'invalid_recipient',
      'recipient must be a wallet public key (on-curve). Set allowOffCurveRecipient to opt into off-curve recipients.',
    );
  }

  let targetMint: string | undefined;
  if (o.targetMint !== undefined && o.targetMint !== null) {
    if (typeof o.targetMint !== 'string') {
      throw new ValidationError('invalid_target_mint', 'targetMint must be a string.');
    }
    try {
      new PublicKey(o.targetMint);
    } catch {
      throw new ValidationError(
        'invalid_target_mint',
        'targetMint must be a valid Solana mint address.',
      );
    }
    targetMint = o.targetMint;
  }

  const result: SettlementRequest = {
    amountUsd,
    recipient,
  };
  if (targetMint !== undefined) {
    result.targetMint = targetMint;
  }
  if (allowOffCurveRecipient) {
    result.allowOffCurveRecipient = true;
  }
  return result;
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
  if (!raw.trim()) {
    throw new ValidationError('invalid_input', 'Request body must be a JSON object.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('invalid_json', 'Request body must be valid JSON.');
  }
}

function writeJsonNoStore(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

registerDevApiHandler(quoteHandler);
