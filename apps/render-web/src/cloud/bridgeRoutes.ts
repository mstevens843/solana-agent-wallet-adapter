import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  createDirectStablecoinSource,
  findOptimalSettlement,
  type PayerHolding,
  type SettlementRequest,
  type SupportedCluster,
} from '@solana-agent-wallet-adapter/bridge-router';
import { PublicKey } from '@solana/web3.js';

import { registerDevApiHandler, type DevApiHandler } from './devApiRegistry.js';

const QUOTE_PREFIX = '/api/agents/settlement/quote';
const MAX_JSON_BYTES = 16 * 1024;
const MAX_AMOUNT_USD = 100_000;
const MAX_SLIPPAGE_BPS = 10_000;
const MAX_HOLDINGS = 50;
const MAX_DECIMALS = 18;
const PER_SOURCE_TIMEOUT_MS = 5_000;

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

interface ParsedQuoteInput {
  amountUsd: number;
  recipient: string;
  targetMint?: string;
  allowOffCurveRecipient?: boolean;
  cluster?: SupportedCluster;
  payerHoldings?: PayerHolding[];
  maxSlippageBps?: number;
}

const quoteHandler: DevApiHandler = {
  prefix: QUOTE_PREFIX,
  methods: ['POST'],
  async handle(req, res, _url, context) {
    try {
      const raw = await readJsonBody(req);
      const parsed = parseSettlementRequest(raw);
      const settlementRequest = buildSettlementRequest(parsed, context.walletAddress);
      const sources = [createDirectStablecoinSource()];
      const result = await findOptimalSettlement(settlementRequest, sources, {
        perSourceTimeoutMs: PER_SOURCE_TIMEOUT_MS,
      });
      writeJsonNoStore(res, 200, { result });
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

function parseSettlementRequest(body: unknown): ParsedQuoteInput {
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

  let cluster: SupportedCluster | undefined;
  if (o.cluster !== undefined && o.cluster !== null) {
    if (o.cluster !== 'mainnet-beta' && o.cluster !== 'devnet') {
      throw new ValidationError(
        'invalid_cluster',
        'cluster must be "mainnet-beta" or "devnet".',
      );
    }
    cluster = o.cluster;
  }

  let payerHoldings: PayerHolding[] | undefined;
  if (o.payerHoldings !== undefined && o.payerHoldings !== null) {
    payerHoldings = parsePayerHoldings(o.payerHoldings);
  }

  let maxSlippageBps: number | undefined;
  if (o.maxSlippageBps !== undefined && o.maxSlippageBps !== null) {
    const value = o.maxSlippageBps;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > MAX_SLIPPAGE_BPS
    ) {
      throw new ValidationError(
        'invalid_max_slippage',
        `maxSlippageBps must be an integer between 0 and ${MAX_SLIPPAGE_BPS}.`,
      );
    }
    maxSlippageBps = value;
  }

  const parsed: ParsedQuoteInput = { amountUsd, recipient };
  if (targetMint !== undefined) parsed.targetMint = targetMint;
  if (allowOffCurveRecipient) parsed.allowOffCurveRecipient = true;
  if (cluster !== undefined) parsed.cluster = cluster;
  if (payerHoldings !== undefined) parsed.payerHoldings = payerHoldings;
  if (maxSlippageBps !== undefined) parsed.maxSlippageBps = maxSlippageBps;
  return parsed;
}

function parsePayerHoldings(raw: unknown): PayerHolding[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError('invalid_payer_holdings', 'payerHoldings must be an array.');
  }
  if (raw.length > MAX_HOLDINGS) {
    throw new ValidationError(
      'invalid_payer_holdings',
      `payerHoldings may not contain more than ${MAX_HOLDINGS} entries.`,
    );
  }
  return raw.map((entry, index) => parsePayerHolding(entry, index));
}

function parsePayerHolding(entry: unknown, index: number): PayerHolding {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ValidationError(
      'invalid_payer_holdings',
      `payerHoldings[${index}] must be a JSON object.`,
    );
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.mint !== 'string' || e.mint.length === 0) {
    throw new ValidationError(
      'invalid_payer_holdings',
      `payerHoldings[${index}].mint must be a non-empty string.`,
    );
  }
  try {
    new PublicKey(e.mint);
  } catch {
    throw new ValidationError(
      'invalid_payer_holdings',
      `payerHoldings[${index}].mint must be a valid Solana mint address.`,
    );
  }

  if (typeof e.amountRaw !== 'string' || !/^\d+$/.test(e.amountRaw)) {
    throw new ValidationError(
      'invalid_payer_holdings',
      `payerHoldings[${index}].amountRaw must be a digit-only string.`,
    );
  }

  if (
    typeof e.decimals !== 'number' ||
    !Number.isInteger(e.decimals) ||
    e.decimals < 0 ||
    e.decimals > MAX_DECIMALS
  ) {
    throw new ValidationError(
      'invalid_payer_holdings',
      `payerHoldings[${index}].decimals must be an integer between 0 and ${MAX_DECIMALS}.`,
    );
  }

  const holding: PayerHolding = {
    mint: e.mint,
    amountRaw: e.amountRaw,
    decimals: e.decimals,
  };

  if (e.usdPrice !== undefined && e.usdPrice !== null) {
    if (typeof e.usdPrice !== 'string' || !/^\d+(\.\d+)?$/.test(e.usdPrice)) {
      throw new ValidationError(
        'invalid_payer_holdings',
        `payerHoldings[${index}].usdPrice must be a decimal string.`,
      );
    }
    holding.usdPrice = e.usdPrice;
  }

  return holding;
}

function buildSettlementRequest(
  parsed: ParsedQuoteInput,
  walletAddress: string | undefined,
): SettlementRequest {
  // USDC has 6 decimals; toFixed(6) bounds JS float precision without scientific
  // notation, and stripping trailing zeros keeps responses readable ('50' vs '50.000000').
  const request: SettlementRequest = {
    usdAmount: parsed.amountUsd.toFixed(6).replace(/\.?0+$/, ''),
    recipient: parsed.recipient,
  };
  if (walletAddress !== undefined) request.payerWallet = walletAddress;
  if (parsed.targetMint !== undefined) request.targetMint = parsed.targetMint;
  if (parsed.cluster !== undefined) request.cluster = parsed.cluster;
  if (parsed.payerHoldings !== undefined) request.payerHoldings = parsed.payerHoldings;
  if (parsed.maxSlippageBps !== undefined) request.maxSlippageBps = parsed.maxSlippageBps;
  return request;
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
