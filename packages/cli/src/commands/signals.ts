/**
 * Signals (copy-trading) — list feeds, subscribe, pause/resume/revoke.
 *
 * Endpoints (verified against apps/render-web/src/cloud/signalsRoutes.ts):
 *   GET  /api/signals/feeds                          — list public feeds
 *   GET  /api/signals/feeds/:feedId                  — feed detail
 *   POST /api/signals/feeds                          — create a feed (publisher only)
 *   POST /api/signals/feeds/:feedId/emissions        — emit a signal (publisher only)
 *   GET  /api/signals/subscriptions                  — list MY subscriptions
 *   POST /api/signals/subscriptions                  — subscribe to a feed
 *   POST /api/signals/subscriptions/:id/(pause|resume|revoke)
 */
import type { ParsedArgs } from '../shared/types.js';
import { optionValue, readJsonFile, removeUndefined } from '../shared/util.js';
import { renderWebRequest } from '../http/index.js';

export async function dispatchSignals(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'list';

  if (sub === 'list' || sub === 'feeds') {
    return renderWebRequest(parsed.options, '/api/signals/feeds', undefined, {
      label: 'Render-web signals',
      requireAuth: true,
    });
  }
  if (sub === 'feed') {
    const id = parsed.positionals[2];
    if (!id) throw new Error('Usage: solana-agent-wallet signals feed <feed-id>');
    return renderWebRequest(parsed.options, `/api/signals/feeds/${encodeURIComponent(id)}`, undefined, {
      label: 'Render-web signals',
      requireAuth: true,
    });
  }
  if (sub === 'subscriptions') {
    return renderWebRequest(parsed.options, '/api/signals/subscriptions', undefined, {
      label: 'Render-web signals',
      requireAuth: true,
    });
  }
  if (sub === 'subscribe') {
    const feedId = parsed.positionals[2];
    if (!feedId) {
      throw new Error('Usage: solana-agent-wallet signals subscribe <feed-id> [--caps <caps.json>]');
    }
    const capsFile = optionValue(parsed.positionals, '--caps');
    const caps = capsFile ? await readJsonFile(capsFile, 'caps') : {};
    return renderWebRequest(parsed.options, '/api/signals/subscriptions', {
      method: 'POST',
      body: JSON.stringify(removeUndefined({ feedId, caps })),
    }, { label: 'Render-web signals', requireAuth: true });
  }
  if (sub === 'pause' || sub === 'resume' || sub === 'unsubscribe' || sub === 'revoke') {
    const id = parsed.positionals[2];
    if (!id) {
      throw new Error(`Usage: solana-agent-wallet signals ${sub} <subscription-id>`);
    }
    // unsubscribe is an alias for revoke (the destructive transition).
    const transition = sub === 'unsubscribe' ? 'revoke' : sub;
    return renderWebRequest(parsed.options, `/api/signals/subscriptions/${encodeURIComponent(id)}/${transition}`, {
      method: 'POST',
      body: '{}',
    }, { label: 'Render-web signals', requireAuth: true });
  }
  throw new Error(`Unknown signals subcommand: ${sub}. Try: list | feed <id> | subscriptions | subscribe <feed-id> | pause/resume/revoke <subscription-id>`);
}
