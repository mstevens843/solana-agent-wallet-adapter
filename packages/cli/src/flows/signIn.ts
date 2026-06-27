import type { GlobalOptions } from '../shared/types.js';
import { header, kv, badge, spinner, isExitPromptError } from '../tui/index.js';
import { loadSession, sessionStatusSummary, clearSession } from '../auth/sessionStore.js';
import { runLogin } from '../auth/nonceFlow.js';
import { bridgeRequest, renderWebRequest } from '../http/index.js';
import { loadWorkspaceSummary, renderWorkspaceSummary } from './workspaceSummary.js';

interface BridgeWalletStatus {
  connected?: boolean;
  address?: string;
  walletAddress?: string;
}

// `/sign-in` — friendly wrapper around the existing SIWS flow. Mirrors the web
// app's "Sign in with cloud workspace" action. Stores a session token that
// gates /approvals, /completed, /plans, /evidence, /cloud-workspace, etc.
export async function runSignIn(options: GlobalOptions, ctlOpts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  console.log(header('Sign in to your cloud workspace'));
  console.log(badge('Cloud Storage sign-in uses your connected wallet as identity only. It does not grant spending authority.', 'muted'));

  const existing = await loadSession(options).catch(() => null);
  const summary = sessionStatusSummary(existing);
  if (summary.authenticated) {
    console.log(badge(`Already signed in as ${summary.walletAddress ?? '(no address)'}`, 'ok'));
    renderWorkspaceSummary(await loadWorkspaceSummaryWithSpinner(options));
    return;
  }

  const walletAddress = await connectedWalletAddress(options);
  if (!walletAddress) {
    console.log(badge('Connect your wallet first with /connect, then run /sign-in again.', 'warn'));
    return;
  }

  const spin = spinner('Waiting for browser signature…');
  try {
    const result = await runLogin(options, {
      walletAddress,
      ...(ctlOpts.signal ? { signal: ctlOpts.signal } : {}),
      ...(ctlOpts.timeoutMs !== undefined ? { timeoutMs: ctlOpts.timeoutMs } : {}),
    });
    spin.succeed('Signed in.');
    console.log(kv([
      ['Wallet', String((result as { walletAddress?: string }).walletAddress ?? '(unknown)')],
      ['Workspace', 'synced'],
    ]));
    const summary = await loadWorkspaceSummaryWithSpinner(options);
    renderWorkspaceSummary(summary);
  } catch (err) {
    if (isExitPromptError(err)) {
      spin.stop();
      throw err;
    }
    spin.fail(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadWorkspaceSummaryWithSpinner(options: GlobalOptions) {
  const spin = spinner('Loading workspace…');
  try {
    return await loadWorkspaceSummary(options);
  } finally {
    spin.stop();
  }
}

async function connectedWalletAddress(options: GlobalOptions): Promise<string | null> {
  try {
    const status = await bridgeRequest<BridgeWalletStatus>(options, '/bridge/action/status');
    if (status.connected === false) {
      return null;
    }
    return status.address || status.walletAddress || null;
  } catch {
    return null;
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
    ['Wallet', summary.walletAddress ?? '-'],
    ['Expires', summary.expiresAt ?? '-'],
  ]));
}
