/**
 * AP2 / ACP inbound adapter readers.
 *
 * Endpoints (verified against apps/render-web/src/cloud/{ap2,acp}Routes.ts):
 *   GET  /api/ap2/inbound                — list inbound mandates
 *   GET  /api/ap2/inbound/<id>           — mandate detail
 *   GET  /api/ap2/inbound/<id>/receipt   — proof receipt
 *   POST /api/acp/cart/preview           — preview a cart payload
 *   POST /api/acp/cart/approve           — approve a previewed cart (wallet auth)
 *
 * For real approve/reject of an AP2 mandate, the inbox surface handles it once
 * the adapter materializes a prepared action. These CLI commands are inspectors.
 */
import type { ParsedArgs } from '../shared/types.js';
import { readJsonFile } from '../shared/util.js';
import { renderWebRequest } from '../http/index.js';

export async function dispatchAp2(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'list';
  if (sub === 'list' || sub === 'inbound') {
    return renderWebRequest(parsed.options, '/api/ap2/inbound', undefined, {
      label: 'Render-web AP2',
      requireAuth: true,
    });
  }
  if (sub === 'inspect' || sub === 'show') {
    const id = parsed.positionals[2];
    if (!id) {
      throw new Error('Usage: solana-agent-wallet ap2 inspect <mandate-id>');
    }
    return renderWebRequest(parsed.options, `/api/ap2/inbound/${encodeURIComponent(id)}`, undefined, {
      label: 'Render-web AP2',
      requireAuth: true,
    });
  }
  if (sub === 'receipt') {
    const id = parsed.positionals[2];
    if (!id) {
      throw new Error('Usage: solana-agent-wallet ap2 receipt <mandate-id>');
    }
    return renderWebRequest(parsed.options, `/api/ap2/inbound/${encodeURIComponent(id)}/receipt`, undefined, {
      label: 'Render-web AP2',
      requireAuth: true,
    });
  }
  throw new Error('Usage: solana-agent-wallet ap2 list | inspect <id> | receipt <id>');
}

export async function dispatchAcp(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'help';
  if (sub === 'preview' || sub === 'inspect') {
    const file = parsed.positionals[2];
    if (!file) {
      throw new Error('Usage: solana-agent-wallet acp preview <cart.json>');
    }
    const cart = await readJsonFile(file, 'cart');
    return renderWebRequest(parsed.options, '/api/acp/cart/preview', {
      method: 'POST',
      body: JSON.stringify({ cart }),
    }, { label: 'Render-web ACP' });
  }
  if (sub === 'approve') {
    const file = parsed.positionals[2];
    if (!file) {
      throw new Error('Usage: solana-agent-wallet acp approve <cart.json>');
    }
    const cart = await readJsonFile(file, 'cart');
    return renderWebRequest(parsed.options, '/api/acp/cart/approve', {
      method: 'POST',
      body: JSON.stringify({ cart }),
    }, { label: 'Render-web ACP', requireAuth: true });
  }
  throw new Error('Usage: solana-agent-wallet acp preview <cart.json> | approve <cart.json>');
}
