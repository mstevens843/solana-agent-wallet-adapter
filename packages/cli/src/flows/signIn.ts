import type { GlobalOptions } from '../shared/types.js';
import { header, kv, badge, spinner } from '../tui/index.js';
import { loadSession, sessionStatusSummary, clearSession } from '../auth/sessionStore.js';
import { runLogin } from '../auth/nonceFlow.js';
import { renderWebRequest } from '../http/index.js';

// `/sign-in` — friendly wrapper around the existing SIWS flow. Mirrors the web
// app's "Sign in with cloud workspace" action. Stores a session token that
// gates /approvals, /completed, /plans, /evidence, /cloud-workspace, etc.
export async function runSignIn(options: GlobalOptions): Promise<void> {
  console.log(header('Sign in to your cloud workspace'));
  console.log(badge('Signing With Solana (SIWS) — opens a browser tab to sign a one-time challenge.', 'muted'));

  const existing = await loadSession(options).catch(() => null);
  const summary = sessionStatusSummary(existing);
  if (summary.authenticated) {
    console.log(badge(`Already signed in as ${summary.walletAddress ?? '(no address)'}`, 'ok'));
    return;
  }

  const spin = spinner('Waiting for browser signature…');
  try {
    const result = await runLogin(options, {});
    spin.succeed('Signed in.');
    console.log(kv([
      ['Wallet', String((result as { walletAddress?: string }).walletAddress ?? '(unknown)')],
      ['Workspace', 'synced'],
    ]));
  } catch (err) {
    spin.fail(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runSignOut(options: GlobalOptions): Promise<void> {
  console.log(header('Sign out'));
  const removed = await clearSession(options);
  if (!removed) {
    console.log(badge('No active session.', 'muted'));
    return;
  }
  try {
    await renderWebRequest(options, '/api/auth/logout', { method: 'POST' }, {
      useBearer: false,
      label: 'Render-web auth',
    });
  } catch {
    // Server may already consider us signed out; local clear is what matters.
  }
  console.log(badge('Signed out.', 'ok'));
}

export async function showSignInStatus(options: GlobalOptions): Promise<void> {
  const session = await loadSession(options).catch(() => null);
  const summary = sessionStatusSummary(session);
  console.log(header('Sign-in status'));
  console.log(kv([
    ['Signed in', summary.authenticated ? badge('yes', 'ok') : badge('no', 'muted')],
    ['Wallet', summary.walletAddress ?? '—'],
    ['Expires', summary.expiresAt ?? '—'],
  ]));
}
