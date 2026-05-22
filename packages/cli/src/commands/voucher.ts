/**
 * Streaming voucher sign + local verify.
 *
 * Endpoints (verified against apps/render-web/src/cloud/streamingRoutes.ts:181):
 *   POST /api/streaming/sessions/<id>/voucher  body {amount, recipient}      → server signs
 *   POST /api/streaming/sessions/<id>/voucher  body {voucher: <pre-signed>}  → server validates & accepts
 *
 * `session voucher verify <file.json>` runs a local schema check on the file
 * (no upstream verify endpoint exists — the only way to "verify" a voucher
 * against the live session is to attempt acceptance, which is destructive).
 */
import process from 'node:process';

import type { ParsedArgs } from '../shared/types.js';
import { optionValue, assertPositiveDecimal, isRecord, readJsonFile } from '../shared/util.js';
import { streamingRenderWebRequest } from '../http/index.js';

export async function dispatchVoucher(parsed: ParsedArgs): Promise<unknown> {
  // Called from session dispatcher with positionals: ['session', 'voucher', op, ...]
  const op = parsed.positionals[2];
  if (op === 'sign') {
    const sessionId = parsed.positionals[3];
    const amount = optionValue(parsed.positionals, '--amount') ?? parsed.positionals[4];
    const recipient = optionValue(parsed.positionals, '--recipient') ?? parsed.positionals[5];
    if (!sessionId || !amount || !recipient) {
      throw new Error('Usage: solana-agent-wallet session voucher sign <session-id> --amount <amt> --recipient <addr>');
    }
    assertPositiveDecimal(amount, 'amount');
    return streamingRenderWebRequest(parsed.options, `/api/streaming/sessions/${encodeURIComponent(sessionId)}/voucher`, {
      method: 'POST',
      body: JSON.stringify({ amount, recipient }),
    });
  }
  if (op === 'submit' || op === 'accept') {
    // Accept a pre-signed voucher and let the server validate + apply it.
    const sessionId = parsed.positionals[3];
    const file = parsed.positionals[4];
    if (!sessionId || !file) {
      throw new Error('Usage: solana-agent-wallet session voucher submit <session-id> <voucher.json>');
    }
    const voucher = await readJsonFile(file, 'voucher');
    return streamingRenderWebRequest(parsed.options, `/api/streaming/sessions/${encodeURIComponent(sessionId)}/voucher`, {
      method: 'POST',
      body: JSON.stringify({ voucher }),
    });
  }
  if (op === 'verify') {
    // Local schema validation; no destructive server call.
    const file = parsed.positionals[3];
    if (!file) {
      throw new Error('Usage: solana-agent-wallet session voucher verify <voucher.json>');
    }
    const voucher = await readJsonFile(file, 'voucher');
    const report = verifyVoucherShape(voucher);
    // Non-zero exit code on invalid voucher so `&&` chains work in CI scripts.
    if (!report.ok) {
      process.exitCode = 1;
    }
    return report;
  }
  throw new Error(`Unknown voucher subcommand: ${op}. Try: sign | submit | verify`);
}

interface VoucherShapeReport {
  ok: boolean;
  schema: string;
  fields: Record<string, boolean>;
  warnings: string[];
}

function verifyVoucherShape(voucher: unknown): VoucherShapeReport {
  const warnings: string[] = [];
  if (!isRecord(voucher)) {
    return { ok: false, schema: 'unknown', fields: {}, warnings: ['Voucher is not a JSON object.'] };
  }
  const fields = {
    sessionId: typeof voucher.sessionId === 'string',
    nonce: typeof voucher.nonce === 'string',
    amount: typeof voucher.amount === 'string',
    recipient: typeof voucher.recipient === 'string',
    issuedAt: typeof voucher.issuedAt === 'string',
    signature: typeof voucher.signature === 'string',
    schema: typeof voucher.schema === 'string',
  };
  const schema = typeof voucher.schema === 'string' ? voucher.schema : 'unknown';
  if (schema && !schema.startsWith('streaming/voucher')) {
    warnings.push(`Unexpected schema "${schema}" — expected "streaming/voucher/<version>".`);
  }
  const ok = Object.values(fields).every(Boolean);
  if (!ok) {
    warnings.push('Missing required field(s). The server will reject this on submit.');
  }
  return { ok, schema, fields, warnings };
}
