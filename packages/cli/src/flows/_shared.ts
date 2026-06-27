import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';
import { header, kv, badge, divider } from '../tui/index.js';
import { listInstalledConnectorKeys as listInstalledConnectorKeysFromState } from './connectorState.js';

export interface PreparedActionResult {
  id?: string;
  summary?: string;
  status?: string;
  walletAddress?: string;
  dueAt?: string;
  cluster?: string;
  txid?: string;
  params?: Record<string, unknown>;
  recurringId?: string;
}

export async function fetchWalletAddress(options: GlobalOptions): Promise<{ address: string; cluster: string }> {
  const status = await bridgeRequest<{
    connected?: boolean;
    address?: string | null;
    cluster?: string;
  }>(options, '/bridge/action/status');
  if (!status.connected || !status.address) {
    throw new Error('No wallet connected. Run /connect first.');
  }
  return { address: status.address, cluster: status.cluster ?? 'mainnet-beta' };
}

export function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as T;
}

export function printQueuedAction(title: string, result: unknown): void {
  console.log();
  console.log(header(`Queued - ${title}`));
  const r = (result && typeof result === 'object' ? result : {}) as PreparedActionResult;
  const rows: Array<[string, string]> = [];
  if (r.id) rows.push(['ID', r.id]);
  if (r.summary) rows.push(['Summary', r.summary]);
  if (r.status) rows.push(['Status', r.status === 'ready' ? badge(r.status, 'ok') : r.status]);
  if (r.dueAt) rows.push(['Due', r.dueAt]);
  if (r.walletAddress) rows.push(['Wallet', r.walletAddress]);
  if (r.cluster) rows.push(['Network', r.cluster]);
  if (r.recurringId) rows.push(['Schedule', r.recurringId]);
  if (r.txid) rows.push(['Txid', r.txid]);
  console.log(kv(rows));
  if (r.id) {
    console.log();
    console.log(`Next: ${badge(`/approve ${r.id}`, 'info')} to sign in browser, or ${badge('/inspect ' + r.id, 'info')} to review.`);
  }
  console.log(divider());
}

export function printAgentHint(label: string): void {
  console.log(divider());
  console.log(badge(label, 'muted'));
}

// Returns a clean one-line recovery message when the error looks like the
// bridge is offline (ECONNREFUSED, fetch failed, socket hang up, etc.). Returns
// null for unrelated errors so callers can fall back to the raw message.
export function friendlyBridgeError(err: unknown, options: GlobalOptions): string | null {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const looksLikeBridgeDown = lower.includes('econnrefused')
    || lower.includes('fetch failed')
    || lower.includes('socket hang up')
    || lower.includes('bridge unreachable')
    || lower.includes('network request failed');
  if (!looksLikeBridgeDown) return null;
  return `Bridge offline at ${options.bridgeUrl}.  Run /bridge start to launch it, or /doctor for diagnostics.`;
}

// Returns connector IDs that have a BYO key in cloud storage or in the current
// CLI session. The caller decides what to do with "missing".
export async function listInstalledConnectorKeys(options: GlobalOptions): Promise<Set<string>> {
  return listInstalledConnectorKeysFromState(options);
}
