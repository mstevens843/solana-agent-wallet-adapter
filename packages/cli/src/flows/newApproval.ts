import { spawn } from 'node:child_process';

import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';
import { errorMessage } from '../shared/util.js';
import { badge, confirm, divider, header, kv } from '../tui/index.js';
import { friendlyBridgeError, type PreparedActionResult } from './_shared.js';

type PreparedActionTxStatus = 'pending' | 'confirmed' | 'failed';

interface PreparedActionEnvelope {
  preparedAction?: unknown;
  action?: unknown;
  result?: unknown;
}

export interface PrepareAndPromptApprovalOptions {
  // Skip the "Send for approval now?" confirm and go straight to the wallet
  // approval flow. Used by callers (the new agent-review picker) that already
  // collected the user's intent to send and don't want a second confirm.
  autoApprove?: boolean;
  // Save the prepared action to /inbox without ever prompting or executing.
  // Used by the agent-review "Save to inbox without sending" choice.
  skipApprovalPrompt?: boolean;
}

export async function prepareAndPromptApproval(
  options: GlobalOptions,
  title: string,
  prepare: () => Promise<unknown>,
  opts: PrepareAndPromptApprovalOptions = {},
): Promise<void> {
  let result: unknown;
  try {
    result = await prepare();
  } catch (err) {
    throw new Error(inboxSaveError(err, options));
  }
  await promptApprovalAfterSave(options, title, result, opts);
}

export async function promptApprovalAfterSave(
  options: GlobalOptions,
  title: string,
  result: unknown,
  opts: PrepareAndPromptApprovalOptions = {},
): Promise<void> {
  const action = preparedActionFromPrepareResult(result);
  renderSavedToInbox(title, action);
  if (!action?.id) return;

  if (opts.skipApprovalPrompt) {
    console.log(badge('Saved to inbox. Approve it later when you are ready.', 'muted'));
    console.log(`Next: ${badge('/inbox', 'info')} or ${badge(`/approve ${action.id}`, 'info')}`);
    console.log(divider());
    return;
  }

  const approveNow = opts.autoApprove
    ? true
    : await confirm({
        message: 'Send for approval now?',
        default: true,
      });
  if (!approveNow) {
    console.log(badge('Saved to inbox. Approve it later when you are ready.', 'muted'));
    console.log(`Next: ${badge('/inbox', 'info')} or ${badge(`/approve ${action.id}`, 'info')}`);
    console.log(divider());
    return;
  }

  await approvePreparedActionNow(options, action);
}

export function preparedActionFromPrepareResult(raw: unknown): PreparedActionResult | null {
  const envelope = asRecord(raw) as PreparedActionEnvelope | null;
  const candidate = asRecord(envelope?.preparedAction)
    ?? asRecord(envelope?.action)
    ?? asRecord(raw);
  if (!candidate) return null;

  const id = stringField(candidate.id);
  if (!id) return null;
  const params = asRecord(candidate.params) ?? undefined;
  const action: PreparedActionResult = {
    id,
    summary: stringField(candidate.summary),
    status: stringField(candidate.status),
    walletAddress: stringField(candidate.walletAddress),
    cluster: stringField(candidate.cluster),
    ...(params ? { params } : {}),
  };
  const dueAt = stringField(candidate.dueAt);
  if (dueAt) action.dueAt = dueAt;
  const txid = stringField(candidate.txid);
  if (txid) action.txid = txid;
  return action;
}

export function inboxSaveError(err: unknown, options: GlobalOptions): string {
  if (friendlyBridgeError(err, options)) {
    return 'Could not save to inbox because the local runtime is offline. Run /connect or /doctor.';
  }
  return errorMessage(err);
}

async function approvePreparedActionNow(options: GlobalOptions, action: PreparedActionResult): Promise<void> {
  if (!action.id) return;
  const approvalUrl = walletHostApprovalUrl(options, action.id);
  const openError = await tryOpenUrl(approvalUrl);
  if (openError) {
    console.log(`Open manually: ${approvalUrl}`);
    console.log(`Browser open failed: ${openError}`);
  } else {
    console.log('Opened: Agentic Approval');
  }
  console.log(badge('Use the browser wallet popup to complete signing.', 'muted'));

  const result = await bridgeRequest(options, '/bridge/prepared-actions/execute', {
    method: 'POST',
    body: JSON.stringify({ actionId: action.id }),
  });
  renderApprovalResult(result, action);

  const tx = await waitForPreparedActionTxStatus(options, action.id, 10_000).catch(() => 'timeout' as const);
  if (tx === 'confirmed') {
    console.log(badge('On-chain: confirmed. The item is in /done.', 'ok'));
  } else if (tx === 'failed') {
    console.log(badge('On-chain: failed. Re-open /inbox for details.', 'err'));
  } else if (tx === 'timeout') {
    console.log(badge('Still pending. Re-run /done or /inbox to refresh status.', 'muted'));
  }
}

function renderSavedToInbox(title: string, action: PreparedActionResult | null): void {
  console.log();
  console.log(header(`Saved to inbox - ${title}`));
  if (!action) {
    console.log(badge('Saved, but the local runtime did not return an action id.', 'warn'));
    console.log(divider());
    return;
  }
  const rows: Array<[string, string]> = [];
  rows.push(['ID', action.id ?? '(missing)']);
  if (action.summary) rows.push(['Summary', action.summary]);
  if (action.status) rows.push(['Status', action.status === 'ready' ? badge(action.status, 'ok') : action.status]);
  if (action.walletAddress) rows.push(['Wallet', action.walletAddress]);
  if (action.cluster) rows.push(['Network', action.cluster]);
  console.log(kv(rows));
  console.log(divider());
}

function renderApprovalResult(raw: unknown, action: PreparedActionResult): void {
  const result = asRecord(raw);
  const innerAction = asRecord(result?.preparedAction);
  const innerResult = asRecord(result?.result);
  const txid = stringField(innerAction?.txid)
    ?? stringField(innerResult?.txid)
    ?? action.txid;
  const explorer = stringField(innerResult?.explorerUrl)
    ?? (txid ? explorerTxUrl(txid, action.cluster) : undefined);

  console.log();
  console.log(header('Approval submitted'));
  const rows: Array<[string, string]> = [];
  if (action.id) rows.push(['Action', action.id]);
  if (txid) rows.push(['Txid', txid]);
  if (explorer) rows.push(['Solscan', explorer]);
  const status = stringField(innerAction?.status) ?? action.status;
  const txStatus = stringField(innerAction?.txStatus);
  if (status) rows.push(['Status', `${status}${txStatus ? ` (${txStatus})` : ''}`]);
  console.log(kv(rows));
  console.log(divider());
}

async function waitForPreparedActionTxStatus(
  options: GlobalOptions,
  actionId: string,
  timeoutMs: number,
): Promise<PreparedActionTxStatus | 'timeout'> {
  const start = Date.now();
  const pollIntervalMs = 1500;
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await bridgeRequest<{ actions?: Array<Record<string, unknown>> }>(
        options,
        '/bridge/prepared-actions/tx-status',
        { method: 'POST', body: JSON.stringify({ actionId }) },
      );
      const action = status.actions?.find((candidate) => candidate.id === actionId);
      const tx = action ? stringField(action.txStatus) : undefined;
      if (tx === 'confirmed' || tx === 'failed') {
        return tx;
      }
    } catch {
      // transient - keep polling
    }
    await sleep(pollIntervalMs);
  }
  return 'timeout';
}

function walletHostApprovalUrl(options: GlobalOptions, actionId: string): string {
  const url = new URL(options.walletHostUrl);
  url.pathname = '/approve';
  url.searchParams.set('bridgeUrl', options.bridgeUrl);
  url.searchParams.set('token', options.token);
  url.searchParams.set('mode', 'cli');
  url.searchParams.set('intent', 'approve');
  url.searchParams.set('actionId', actionId);
  return url.toString();
}

async function tryOpenUrl(url: string): Promise<string | null> {
  try {
    await openUrl(url);
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

async function openUrl(url: string): Promise<void> {
  if (process.env.AGENT_WALLET_SKIP_OPEN === '1') return;
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/C', 'start', '', url] : [url];
  await new Promise<void>((resolveOpen, rejectOpen) => {
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) rejectOpen(err);
      else resolveOpen();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true });
    } catch (err) {
      settle(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    child.once('error', (err) => settle(err));
    child.once('exit', (code, signal) => {
      if (code && code !== 0) {
        settle(new Error(`${command} exited with code ${code}${signal ? ` (${signal})` : ''}`));
      }
    });
    child.unref();
    settle();
  });
}

function explorerTxUrl(txid: string, cluster?: string): string {
  const clusterParam = !cluster || cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${txid}${clusterParam}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
