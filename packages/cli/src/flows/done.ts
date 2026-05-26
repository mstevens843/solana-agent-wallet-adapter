import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest, renderWebRequest } from '../http/index.js';
import { header, kv, badge, divider } from '../tui/index.js';

export type DoneFilter = 'all' | 'one-time' | 'repeats' | 'proofs' | 'receipts';

interface ReceiptRow {
  actionId?: string;
  status?: string;
  txStatus?: string;
  txid?: string;
  summary?: string;
  amount?: string;
  token?: string;
  recipient?: string;
  recurringId?: string;
  completedAt?: string;
  cluster?: string;
  error?: string;
}

interface CloudCompletedRow {
  id?: string;
  actionId?: string;
  kind?: string;
  status?: string;
  txid?: string;
  txStatus?: string;
  summary?: string;
  recurringId?: string;
  completedAt?: string;
  createdAt?: string;
  cluster?: string;
  amount?: string;
  token?: string;
}

interface LabArtifactRow {
  id: string;
  title?: string;
  kind?: string;
  createdAt?: string;
  walletAddress?: string | null;
  cluster?: string;
  signature?: string;
  category?: string;
}

export interface DoneRow {
  kind: 'receipt' | 'proof' | 'completed';
  category: 'one-time' | 'repeats' | 'proofs' | 'receipts';
  id: string;
  title: string;
  summary?: string;
  amount?: string;
  token?: string;
  recipient?: string;
  txid?: string;
  cluster?: string;
  completedAt: string;
  status?: string;
  txStatus?: string;
  recurringId?: string;
  signature?: string;
  error?: string;
}

export async function runDoneList(options: GlobalOptions, filter: DoneFilter = 'all'): Promise<void> {
  const rows = await loadDoneRows(options);
  const filtered = filter === 'all' ? rows : rows.filter((r) => r.category === filter);
  const counts = countByCategory(rows);

  console.log();
  console.log(header('Done'));
  console.log(
    `${badge('All', 'muted')}: ${rows.length}`
    + `  ·  ${badge('One-time', 'info')}: ${counts['one-time']}`
    + `  ·  ${badge('Repeats', 'warn')}: ${counts['repeats']}`
    + `  ·  ${badge('Proofs', 'ok')}: ${counts['proofs']}`
    + `  ·  ${badge('Receipts', 'info')}: ${counts['receipts']}`,
  );
  console.log(`Filter: ${filter}  ·  ${filtered.length} shown / ${rows.length} total`);
  console.log();

  if (filtered.length === 0) {
    console.log(badge('Nothing here yet.', 'muted'));
    return;
  }

  filtered.forEach((row, i) => {
    renderDoneRow(i + 1, row);
    if (i < filtered.length - 1) console.log('');
  });

  console.log();
  console.log(badge('Tip: /done [all | one-time | repeats | proofs | receipts]', 'muted'));
}

function countByCategory(rows: DoneRow[]): Record<Exclude<DoneFilter, 'all'>, number> {
  return {
    'one-time': rows.filter((r) => r.category === 'one-time').length,
    'repeats':  rows.filter((r) => r.category === 'repeats').length,
    'proofs':   rows.filter((r) => r.category === 'proofs').length,
    'receipts': rows.filter((r) => r.category === 'receipts').length,
  };
}

export function renderDoneRow(n: number, row: DoneRow): void {
  const chip =
    row.category === 'proofs'   ? badge('Proof', 'ok')
    : row.category === 'repeats' ? badge('Repeat', 'warn')
    : row.category === 'receipts' ? badge('Receipt', 'info')
    : badge('One-time', 'info');
  const statusChip =
    row.status === 'approved' || row.txStatus === 'confirmed' ? badge('confirmed', 'ok')
    : row.status === 'rejected' || row.txStatus === 'failed' ? badge(row.status ?? 'failed', 'err')
    : row.status ? badge(row.status, 'muted')
    : '';

  console.log(`[${n}] ${chip}  ${row.title}  ${statusChip}`);
  if (row.summary) console.log(`    ${row.summary}`);
  const moneyLine = [
    row.amount ? `${row.amount}${row.token ? ` ${row.token}` : ''}` : '',
    row.recipient ? `→ ${row.recipient}` : '',
  ].filter(Boolean).join('  ');
  if (moneyLine) console.log(`    ${moneyLine}`);
  if (row.txid) {
    console.log(`    Txid:     ${row.txid}`);
    console.log(`    Explorer: ${explorerUrl(row.txid, row.cluster)}`);
  }
  if (row.signature) console.log(`    Signature: ${row.signature.slice(0, 22)}…`);
  if (row.error) console.log(`    ${badge(`Error: ${row.error}`, 'err')}`);
  console.log(`    ${badge(`Completed ${row.completedAt}`, 'muted')}  ·  ${badge(`id ${row.id}`, 'muted')}`);
}

export async function loadDoneRows(options: GlobalOptions): Promise<DoneRow[]> {
  const [receipts, artifacts, cloud] = await Promise.all([
    safe(bridgeRequest<{ receipts?: ReceiptRow[] }>(options, '/bridge/receipts')),
    safe(bridgeRequest<{ artifacts?: LabArtifactRow[] }>(options, '/bridge/lab-artifacts')),
    safe(renderWebRequest<{ completed?: CloudCompletedRow[]; items?: CloudCompletedRow[] }>(
      options,
      '/api/completed',
      undefined,
      { label: 'Render-web completed', requireAuth: true },
    )),
  ]);

  const rows: DoneRow[] = [];

  for (const r of receipts?.receipts ?? []) {
    rows.push({
      kind: 'receipt',
      category: r.recurringId ? 'repeats' : (r.txid ? 'receipts' : 'one-time'),
      id: r.actionId ?? `receipt_${rows.length}`,
      title: r.summary ?? 'Approval receipt',
      ...(r.summary !== undefined ? { summary: r.summary } : {}),
      ...(r.amount !== undefined ? { amount: r.amount } : {}),
      ...(r.token !== undefined ? { token: r.token } : {}),
      ...(r.recipient !== undefined ? { recipient: r.recipient } : {}),
      ...(r.txid !== undefined ? { txid: r.txid } : {}),
      ...(r.cluster !== undefined ? { cluster: r.cluster } : {}),
      completedAt: r.completedAt ?? new Date(0).toISOString(),
      ...(r.status !== undefined ? { status: r.status } : {}),
      ...(r.txStatus !== undefined ? { txStatus: r.txStatus } : {}),
      ...(r.recurringId !== undefined ? { recurringId: r.recurringId } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
    });
  }

  for (const a of artifacts?.artifacts ?? []) {
    rows.push({
      kind: 'proof',
      category: 'proofs',
      id: a.id,
      title: a.title ?? a.kind ?? 'Proof',
      ...(a.cluster !== undefined ? { cluster: a.cluster } : {}),
      completedAt: a.createdAt ?? new Date(0).toISOString(),
      ...(a.signature !== undefined ? { signature: a.signature } : {}),
    });
  }

  const cloudList = (cloud?.completed ?? cloud?.items ?? []);
  for (const c of cloudList) {
    // Skip cloud rows that already appear as bridge receipts (same actionId).
    const dup = rows.some((r) => r.kind === 'receipt' && r.id && c.actionId === r.id);
    if (dup) continue;
    rows.push({
      kind: 'completed',
      category: c.recurringId ? 'repeats' : (c.txid ? 'receipts' : 'one-time'),
      id: c.id ?? c.actionId ?? `cloud_${rows.length}`,
      title: c.summary ?? c.kind ?? 'Completed action',
      ...(c.summary !== undefined ? { summary: c.summary } : {}),
      ...(c.amount !== undefined ? { amount: c.amount } : {}),
      ...(c.token !== undefined ? { token: c.token } : {}),
      ...(c.txid !== undefined ? { txid: c.txid } : {}),
      ...(c.cluster !== undefined ? { cluster: c.cluster } : {}),
      completedAt: c.completedAt ?? c.createdAt ?? new Date(0).toISOString(),
      ...(c.status !== undefined ? { status: c.status } : {}),
      ...(c.txStatus !== undefined ? { txStatus: c.txStatus } : {}),
      ...(c.recurringId !== undefined ? { recurringId: c.recurringId } : {}),
    });
  }

  rows.sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  return rows;
}

export async function deleteDoneRow(options: GlobalOptions, row: DoneRow): Promise<void> {
  if (row.kind === 'proof') {
    await bridgeRequest(options, '/bridge/lab-artifacts/delete', {
      method: 'POST',
      body: JSON.stringify({ artifactId: row.id }),
    });
    return;
  }
  if (row.kind === 'completed') {
    await renderWebRequest(options, `/api/completed/${encodeURIComponent(row.id)}`, {
      method: 'DELETE',
    }, { label: 'Render-web completed', requireAuth: true });
    return;
  }
  await bridgeRequest(options, '/bridge/prepared-actions/delete', {
    method: 'POST',
    body: JSON.stringify({ actionId: row.id }),
  });
}

async function safe<T>(p: Promise<T>): Promise<T | undefined> {
  try { return await p; } catch { return undefined; }
}

function explorerUrl(txid: string, cluster?: string): string {
  const network = cluster && cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : '';
  return `https://solscan.io/tx/${txid}${network}`;
}
