import type { GlobalOptions } from '../shared/types.js';
import { renderWebRequest } from '../http/index.js';
import { select, confirm, header, kv, badge, divider, spinner, input } from '../tui/index.js';

interface StreamingSession {
  id: string;
  status?: string;
  tokenMint?: string;
  tokenSymbol?: string;
  capAmount?: string;
  spentAmount?: string;
  expiresAt?: string;
  createdAt?: string;
  walletAddress?: string;
  delegate?: string;
  cluster?: string;
}

type Action = 'inspect' | 'revoke' | 'settle' | 'history' | 'back';

// `/sessions` — friendly menu over streaming-payment sessions. The legacy
// `/session list|create|spend|revoke|history|settle` subcommands still work for
// scripting; this is the interactive front door.
export async function runSessionsMenu(options: GlobalOptions): Promise<void> {
  while (true) {
    const list = await loadSessions(options);
    console.log();
    console.log(header('Streaming sessions'));
    if (list.length === 0) {
      console.log(badge('No streaming sessions found. Use /session create to open one.', 'muted'));
      return;
    }
    const counts = {
      active: list.filter((s) => (s.status ?? '').toLowerCase() === 'active').length,
      expired: list.filter((s) => (s.status ?? '').toLowerCase() === 'expired').length,
      revoked: list.filter((s) => (s.status ?? '').toLowerCase() === 'revoked').length,
    };
    console.log(badge(`${counts.active} active · ${counts.expired} expired · ${counts.revoked} revoked`, 'muted'));

    const choice = await select<string>({
      message: 'Pick a session',
      pageSize: Math.min(20, list.length + 1),
      choices: [
        ...list.map((s, i) => ({ name: rowLabel(i + 1, s), value: s.id })),
        { name: '← Back to main menu', value: '__back__' },
      ],
    });
    if (choice === '__back__') return;

    const session = list.find((s) => s.id === choice);
    if (!session) continue;

    const action = await pickAction(session);
    if (action === 'back') continue;
    if (action === 'inspect') {
      inspectSession(session);
      continue;
    }
    if (action === 'history') {
      await showHistory(options, session.id);
      continue;
    }
    if (action === 'revoke') {
      const yes = await confirm({
        message: `Revoke session ${session.id.slice(0, 12)}…? This stops all future spends.`,
        default: false,
      });
      if (yes) await revokeSession(options, session.id);
      continue;
    }
    if (action === 'settle') {
      await settleSession(options, session.id);
      continue;
    }
  }
}

async function loadSessions(options: GlobalOptions): Promise<StreamingSession[]> {
  try {
    const raw = await renderWebRequest<unknown>(options, '/api/streaming/sessions', undefined, {
      label: 'Render-web sessions',
      requireAuth: true,
    });
    return extractList(raw);
  } catch (err) {
    console.log(badge(`Could not load sessions: ${err instanceof Error ? err.message : String(err)}`, 'err'));
    console.log(badge('Tip: run /sign-in if you haven\'t connected to the cloud workspace yet.', 'muted'));
    return [];
  }
}

function extractList(raw: unknown): StreamingSession[] {
  if (Array.isArray(raw)) return raw as StreamingSession[];
  if (raw && typeof raw === 'object') {
    const sessions = (raw as { sessions?: unknown }).sessions;
    if (Array.isArray(sessions)) return sessions as StreamingSession[];
  }
  return [];
}

function rowLabel(n: number, s: StreamingSession): string {
  const row = String(n).padStart(2, ' ');
  const status = s.status?.toLowerCase() ?? 'unknown';
  const statusChip = status === 'active' ? badge(status, 'ok')
    : status === 'expired' || status === 'revoked' ? badge(status, 'muted')
    : badge(status, 'warn');
  const cap = s.capAmount && s.tokenSymbol ? `${s.capAmount} ${s.tokenSymbol}` : (s.capAmount ?? '?');
  const spent = s.spentAmount ? ` · spent ${s.spentAmount}` : '';
  return `${row}.  ${statusChip}  cap ${cap}${spent}  ${s.id.slice(0, 16)}…`;
}

async function pickAction(s: StreamingSession): Promise<Action> {
  const choices: Array<{ name: string; value: Action }> = [
    { name: 'Inspect', value: 'inspect' },
    { name: 'View spend history', value: 'history' },
  ];
  const status = s.status?.toLowerCase();
  if (status === 'active') {
    choices.push({ name: 'Settle (sweep remaining)', value: 'settle' });
    choices.push({ name: 'Revoke (close session)', value: 'revoke' });
  }
  choices.push({ name: '← Back to session list', value: 'back' });
  return select<Action>({ message: 'What next?', choices });
}

function inspectSession(s: StreamingSession): void {
  console.log();
  console.log(header(`Session ${s.id}`));
  const rows: Array<[string, string]> = [];
  if (s.status) rows.push(['Status', s.status === 'active' ? badge(s.status, 'ok') : badge(s.status, 'muted')]);
  if (s.tokenSymbol || s.tokenMint) rows.push(['Token', `${s.tokenSymbol ?? ''} ${s.tokenMint ?? ''}`.trim()]);
  if (s.capAmount) rows.push(['Cap', s.capAmount]);
  if (s.spentAmount) rows.push(['Spent', s.spentAmount]);
  if (s.expiresAt) rows.push(['Expires', shortDate(s.expiresAt)]);
  if (s.walletAddress) rows.push(['Wallet', s.walletAddress]);
  if (s.delegate) rows.push(['Delegate', s.delegate]);
  if (s.cluster) rows.push(['Network', s.cluster]);
  if (s.createdAt) rows.push(['Created', shortDate(s.createdAt)]);
  console.log(kv(rows));
  console.log(divider());
}

async function showHistory(options: GlobalOptions, sessionId: string): Promise<void> {
  const spin = spinner('Loading history…');
  try {
    const raw = await renderWebRequest<unknown>(
      options,
      `/api/streaming/sessions/${encodeURIComponent(sessionId)}/voucher-history`,
      undefined,
      { label: 'Render-web sessions', requireAuth: true },
    );
    spin.succeed('History loaded.');
    console.log(JSON.stringify(raw, null, 2));
    console.log(divider());
  } catch (err) {
    spin.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function revokeSession(options: GlobalOptions, sessionId: string): Promise<void> {
  const spin = spinner('Revoking…');
  try {
    await renderWebRequest(options, `/api/streaming/sessions/${encodeURIComponent(sessionId)}/revoke`, {
      method: 'POST',
      body: '{}',
    }, { label: 'Render-web sessions', requireAuth: true });
    spin.succeed('Session revoked.');
  } catch (err) {
    spin.fail(`Revoke failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function settleSession(options: GlobalOptions, sessionId: string): Promise<void> {
  const note = await input({ message: 'Optional settle note (blank to skip)', default: '' });
  const spin = spinner('Settling…');
  try {
    const body = note.trim() ? JSON.stringify({ note: note.trim() }) : '{}';
    await renderWebRequest(options, `/api/streaming/sessions/${encodeURIComponent(sessionId)}/settle`, {
      method: 'POST',
      body,
    }, { label: 'Render-web sessions', requireAuth: true });
    spin.succeed('Session settled.');
  } catch (err) {
    spin.fail(`Settle failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
