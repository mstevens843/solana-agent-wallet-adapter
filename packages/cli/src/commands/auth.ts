import process from 'node:process';

import type { ParsedArgs } from '../shared/types.js';
import { optionValue, resolveWalletAddress } from '../shared/util.js';
import { renderWebRequest } from '../http/index.js';
import { runLogin } from '../auth/nonceFlow.js';
import { clearSession, loadSession, sessionStatusSummary } from '../auth/sessionStore.js';

export async function dispatchAuth(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'status';

  if (sub === 'status') {
    const session = await loadSession(parsed.options);
    const summary = sessionStatusSummary(session);
    const envOverride = process.env.AGENTIC_SESSION_TOKEN ?? process.env.AGENTIC_BEARER_TOKEN;
    return {
      ...summary,
      ...(envOverride ? { envOverride: true, hint: 'AGENTIC_SESSION_TOKEN / AGENTIC_BEARER_TOKEN env var is set and takes precedence over the on-disk session.' } : {}),
    };
  }

  if (sub === 'login') {
    const walletAddress = resolveWalletAddress(parsed.positionals);
    const timeoutRaw = optionValue(parsed.positionals, '--timeout-ms');
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error('--timeout-ms must be a positive number.');
    }
    const result = await runLogin(parsed.options, {
      ...(walletAddress ? { walletAddress } : {}),
      noOpen: parsed.positionals.includes('--no-open'),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return { signedIn: true, ...result };
  }

  if (sub === 'logout') {
    const removed = await clearSession(parsed.options);
    if (removed) {
      try {
        await renderWebRequest(parsed.options, '/api/auth/logout', { method: 'POST' }, {
          useBearer: false,
          label: 'Render-web auth',
        });
      } catch {
        // Server may already consider us signed out; local clear is what matters.
      }
    }
    return { signedOut: removed };
  }

  if (sub === 'nonce') {
    const walletAddress = resolveWalletAddress(parsed.positionals);
    return renderWebRequest(parsed.options, '/api/auth/nonce', {
      method: 'POST',
      body: JSON.stringify(walletAddress ? { walletAddress } : {}),
    }, { useBearer: false, label: 'Render-web auth' });
  }

  if (sub === 'session') {
    return renderWebRequest(parsed.options, '/api/session', undefined, { label: 'Render-web session' });
  }

  throw new Error(`Unknown auth subcommand: ${sub}. Try: status | login | logout | nonce | session`);
}
