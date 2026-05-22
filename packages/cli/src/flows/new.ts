import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';
import { select, badge, confirm, spinner, header, kv, divider } from '../tui/index.js';
import { promptSendSolForm } from '../forms/sendSol.js';
import { promptSendSplForm } from '../forms/sendSpl.js';
import { promptSwapForm } from '../forms/swap.js';
import { promptConnectorForm } from '../forms/connectorForm.js';
import { listConnectors, listActions, humanizeActionKind, type ConnectorAction, type ActionTier } from '../forms/connectorMeta.js';
import { maybeEnhanceWithAi, maybeApplyAdvice } from '../forms/aiEnhance.js';
import { verdictBlocksQueue } from '../forms/policyBundleRender.js';
import { fetchWalletAddress, removeUndefined, printQueuedAction, listInstalledConnectorKeys } from './_shared.js';
import { runConnectorsMenu } from './connectors.js';
import { confirmHighStakes, estimateFromDraft } from './safetyGate.js';

export type NewSubcommand = 'send' | 'spl' | 'swap' | 'connector';

// `/new` — pick a kind, then route. Mirrors the web app's template picker.
export async function runNewMenu(options: GlobalOptions): Promise<void> {
  const pick = await select<NewSubcommand>({
    message: 'What kind of action?',
    choices: [
      { name: 'Send SOL',           value: 'send',      description: 'Native SOL transfer to an address' },
      { name: 'Send SPL token',     value: 'spl',       description: 'USDC, USDT, JUP, BONK, custom mint…' },
      { name: 'Swap (Jupiter)',     value: 'swap',      description: 'Token swap via Jupiter' },
      { name: 'Connector action',   value: 'connector', description: '19 protocols, ~80 actions' },
    ],
  });
  if (pick === 'send') return runNewSend(options);
  if (pick === 'spl') return runNewSpl(options);
  if (pick === 'swap') return runNewSwap(options);
  return runNewConnector(options);
}

export async function runNewSend(options: GlobalOptions): Promise<void> {
  let draft = await promptSendSolForm(options);
  if (!(await confirmSelfTransfer(options, draft.recipient, 'SOL'))) return;
  const description = `Send ${draft.amountSol} SOL to ${draft.recipient}${draft.note ? ` — ${draft.note}` : ''}`;
  const enhanced = await maybeEnhanceWithAi(options, description);
  if (verdictBlocksQueue(enhanced?.verdict)) {
    console.log(badge('AI denied this plan — not queueing.', 'err'));
    return;
  }
  const advice = enhanced?.advice ?? null;
  draft = await maybeApplyAdvice(draft, advice, (p) => ({
    recipient: pickString(p, ['recipient']),
    amountSol: pickString(p, ['amountSol', 'amount']),
    note: pickString(p, ['note', 'memo']),
  }) as Partial<typeof draft>);
  const ok = await confirmHighStakes(options, description, estimateFromDraft(draft), advice);
  if (!ok) {
    console.log(badge('Aborted.', 'muted'));
    return;
  }
  const result = await bridgeRequest(options, '/bridge/action/prepare-transfer-sol', {
    method: 'POST',
    body: JSON.stringify(removeUndefined({ ...draft })),
  });
  printQueuedAction('Send SOL', result);
}

export async function runNewSpl(options: GlobalOptions): Promise<void> {
  let draft = await promptSendSplForm(options);
  if (!(await confirmSelfTransfer(options, draft.recipient, draft.token))) return;
  const description = `Send ${draft.amount} ${draft.token} to ${draft.recipient}${draft.note ? ` — ${draft.note}` : ''}`;
  const enhanced = await maybeEnhanceWithAi(options, description);
  if (verdictBlocksQueue(enhanced?.verdict)) {
    console.log(badge('AI denied this plan — not queueing.', 'err'));
    return;
  }
  const advice = enhanced?.advice ?? null;
  draft = await maybeApplyAdvice(draft, advice, (p) => ({
    token: pickString(p, ['token', 'symbol']),
    recipient: pickString(p, ['recipient']),
    amount: pickString(p, ['amount']),
    note: pickString(p, ['note', 'memo']),
  }) as Partial<typeof draft>);
  const ok = await confirmHighStakes(options, description, estimateFromDraft(draft), advice);
  if (!ok) {
    console.log(badge('Aborted.', 'muted'));
    return;
  }
  const result = await bridgeRequest(options, '/bridge/action/prepare-transfer-spl', {
    method: 'POST',
    body: JSON.stringify(removeUndefined({ ...draft })),
  });
  printQueuedAction('Send SPL', result);
}

export async function runNewSwap(options: GlobalOptions): Promise<void> {
  let draft = await promptSwapForm(options);
  if (draft.inputToken.trim().toUpperCase() === draft.outputToken.trim().toUpperCase()) {
    console.log(badge(`Input and output token are both ${draft.inputToken} — swap would be a no-op. Aborting.`, 'err'));
    return;
  }
  const quote = await previewSwapQuote(options, draft);
  if (quote === 'aborted') return;
  const description = `Swap ${draft.amount} ${draft.inputToken} → ${draft.outputToken}${draft.slippageBps !== undefined ? ` (slippage ${draft.slippageBps}bps)` : ''}`;
  const enhanced = await maybeEnhanceWithAi(options, description);
  if (verdictBlocksQueue(enhanced?.verdict)) {
    console.log(badge('AI denied this plan — not queueing.', 'err'));
    return;
  }
  const advice = enhanced?.advice ?? null;
  draft = await maybeApplyAdvice(draft, advice, (p) => ({
    amount: pickString(p, ['amount', 'inputAmount']),
    inputToken: pickString(p, ['inputToken', 'fromToken']),
    outputToken: pickString(p, ['outputToken', 'toToken']),
    slippageBps: pickNumber(p, ['slippageBps']),
    note: pickString(p, ['note', 'memo']),
  }) as Partial<typeof draft>);
  const ok = await confirmHighStakes(options, description, estimateFromDraft(draft), advice);
  if (!ok) {
    console.log(badge('Aborted.', 'muted'));
    return;
  }
  const result = await bridgeRequest(options, '/bridge/action/prepare-swap', {
    method: 'POST',
    body: JSON.stringify(removeUndefined({ ...draft })),
  });
  printQueuedAction('Swap', result);
}

function pickString(p: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

function pickNumber(p: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v);
  }
  return undefined;
}

// Standalone preview-only flow: form -> quote -> done. Used by /swap-quote.
export async function runSwapQuote(options: GlobalOptions): Promise<void> {
  const draft = await promptSwapForm(options);
  await previewSwapQuote(options, draft, { preview: true });
}

async function previewSwapQuote(
  options: GlobalOptions,
  draft: { amount: string; inputToken: string; outputToken: string; slippageBps?: number },
  opts: { preview?: boolean } = {},
): Promise<'ok' | 'aborted'> {
  const spin = spinner('Fetching Jupiter quote…');
  try {
    const quote = await bridgeRequest<Record<string, unknown>>(options, '/bridge/action/swap-quote', {
      method: 'POST',
      body: JSON.stringify(removeUndefined({
        amount: draft.amount,
        inputToken: draft.inputToken,
        outputToken: draft.outputToken,
        slippageBps: draft.slippageBps,
      })),
    });
    spin.succeed('Quote received.');
    console.log();
    console.log(header('Swap quote'));
    const rows: Array<[string, string]> = [
      ['Pay', `${draft.amount} ${draft.inputToken}`],
      ['Receive', describeOutAmount(quote, draft.outputToken)],
    ];
    const priceImpact = pickField(quote, ['priceImpactPct', 'priceImpact']);
    if (priceImpact !== undefined) rows.push(['Price impact', `${priceImpact}%`]);
    const route = describeRoute(quote);
    if (route) rows.push(['Route', route]);
    const slip = draft.slippageBps ?? pickField(quote, ['slippageBps']);
    if (slip !== undefined) rows.push(['Slippage', `${slip} bps`]);
    console.log(kv(rows));
    console.log(divider());
    if (opts.preview) return 'ok';
    const proceed = await confirm({ message: 'Looks right — queue this swap?', default: true });
    return proceed ? 'ok' : 'aborted';
  } catch (err) {
    spin.fail(`Quote failed: ${err instanceof Error ? err.message : String(err)}`);
    if (opts.preview) return 'ok';
    const proceed = await confirm({ message: 'Queue anyway?', default: false });
    return proceed ? 'ok' : 'aborted';
  }
}

function describeOutAmount(quote: Record<string, unknown>, outputToken: string): string {
  const raw = pickField(quote, ['outAmount', 'outputAmount', 'expectedOutput', 'amountOut']);
  if (raw === undefined) return `(check ${outputToken})`;
  return `${raw} ${outputToken}`;
}

function describeRoute(quote: Record<string, unknown>): string | null {
  const route = (quote as { route?: unknown }).route ?? (quote as { routePlan?: unknown }).routePlan;
  if (!Array.isArray(route) || route.length === 0) {
    const market = pickField(quote, ['marketName', 'venue', 'amm', 'dex']);
    return market !== undefined ? String(market) : null;
  }
  const hops = route
    .map((hop) => {
      if (typeof hop !== 'object' || hop === null) return null;
      const swap = (hop as { swapInfo?: { label?: string } }).swapInfo;
      if (swap?.label) return swap.label;
      const label = (hop as { label?: string }).label;
      return typeof label === 'string' ? label : null;
    })
    .filter((label): label is string => Boolean(label));
  return hops.length > 0 ? hops.join(' → ') : null;
}

function pickField(obj: Record<string, unknown>, keys: string[]): string | number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number') return value;
  }
  return undefined;
}

export async function runNewConnector(options: GlobalOptions): Promise<void> {
  const installedKeys = await listInstalledConnectorKeys(options);
  while (true) {
    const pickedId = await pickConnector(options, installedKeys);
    if (!pickedId) return;

    const connectors = listConnectors();
    const pickedConnector = connectors.find((c) => c.id === pickedId);
    if (pickedConnector?.needsKey && !installedKeys.has(pickedConnector.id)) {
      console.log(badge(`${pickedConnector.name} needs a ${pickedConnector.keyLabel ?? 'BYO key'} before agents can act.`, 'warn'));
      const setup = await confirm({
        message: 'Open /connectors to set up the key now?',
        default: true,
      });
      if (setup) {
        await runConnectorsMenu(options);
        console.log(badge('Run /new-connector again once the key is in place.', 'muted'));
        return;
      }
      const proceed = await confirm({
        message: 'Continue anyway? The bridge will likely reject the action at queue time.',
        default: false,
      });
      if (!proceed) continue;
    }

    const actions = listActions(pickedId);
    if (actions.length === 0) {
      console.log(badge(`No implemented actions for ${pickedId}.`, 'warn'));
      continue;
    }

    const actionValue = await pickAction(pickedId, actions);
    if (actionValue === '__back__') continue;

    const action = actions.find((a) => a.actionKind === actionValue);
    if (!action) continue;

    if (action.tier === 'read_only') {
      return runConnectorReadOnly(options, pickedId, action);
    }
    return runConnectorWrite(options, pickedId, action);
  }
}

async function pickConnector(options: GlobalOptions, installedKeys: Set<string>): Promise<string | undefined> {
  const connectors = listConnectors();
  if (connectors.length === 0) {
    console.log(badge('No connectors found. Reinstall or rebuild the CLI.', 'err'));
    return undefined;
  }
  return select<string>({
    message: 'Which connector?',
    pageSize: 14,
    choices: connectors.map((c) => ({
      name: `${c.name}${connectorChip(c, installedKeys.has(c.id))}  ·  ${c.actionCount} actions`,
      value: c.id,
      description: c.needsKey ? `BYO ${c.keyLabel}` : undefined,
    })),
  });
}

async function pickAction(connectorId: string, actions: ConnectorAction[]): Promise<string> {
  const firstClass = actions.filter((a) => a.tier === 'first_class');
  const blinks = actions.filter((a) => a.tier === 'blink');
  const readOnly = actions.filter((a) => a.tier === 'read_only');

  const choices: Array<{ name: string; value: string; description?: string }> = [
    { name: '← Pick a different connector', value: '__back__' },
  ];
  for (const a of firstClass) choices.push(actionChoice(a, connectorId));
  for (const a of blinks)     choices.push(actionChoice(a, connectorId));
  for (const a of readOnly)   choices.push(actionChoice(a, connectorId));

  return select<string>({
    message: 'Which action?',
    pageSize: Math.min(20, choices.length + 1),
    choices,
  });
}

function actionChoice(a: ConnectorAction, connectorId: string): { name: string; value: string; description?: string } {
  const built: { name: string; value: string; description?: string } = {
    name: `${tierBadge(a.tier)}  ${humanizeActionKind(a.actionKind, connectorId)}`,
    value: a.actionKind,
  };
  if (a.summary) built.description = a.summary.slice(0, 120);
  return built;
}

function tierBadge(tier: ActionTier): string {
  if (tier === 'first_class') return badge('FIRST-CLASS', 'info');
  if (tier === 'blink')       return badge('BLINK',       'muted');
  return badge('READ-ONLY',   'warn');
}

async function runConnectorWrite(options: GlobalOptions, connectorId: string, action: ConnectorAction): Promise<void> {
  const draft = await promptConnectorForm(connectorId, action.actionKind, options);
  const description = `${draft.summary} — params: ${JSON.stringify(draft.params)}`;
  const enhanced = await maybeEnhanceWithAi(options, description);
  if (verdictBlocksQueue(enhanced?.verdict)) {
    console.log(badge('AI denied this plan — not queueing.', 'err'));
    return;
  }
  const advice = enhanced?.advice ?? null;
  const ok = await confirmHighStakes(options, description, estimateFromConnectorParams(draft.params), advice);
  if (!ok) {
    console.log(badge('Aborted.', 'muted'));
    return;
  }

  const { address, cluster } = await fetchWalletAddress(options);
  const body = removeUndefined({
    kind: draft.actionKind,
    params: draft.params,
    walletAddress: address,
    cluster,
    summary: draft.summary,
    reason: draft.reason,
    note: draft.note,
  });
  const result = await bridgeRequest(options, '/bridge/connector/prepare-transaction', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  printQueuedAction(draft.summary, result);
}

async function runConnectorReadOnly(options: GlobalOptions, connectorId: string, action: ConnectorAction): Promise<void> {
  // Read-only actions are evidence-only: collect the form, fetch the snapshot,
  // render the result, archive in /bridge/lab-artifacts. No prepared action is
  // queued; nothing hits chain. Mirrors the web's "EVIDENCE-ONLY" routing.
  console.log(badge('Evidence-only action — nothing will be queued for approval.', 'muted'));
  const draft = await promptConnectorForm(connectorId, action.actionKind, options);

  const snapshot = await safeReadFacts(options, connectorId, action, draft.params);
  renderEvidenceSnapshot(action, snapshot);

  const evidence = {
    connectorId,
    actionKind: action.actionKind,
    toolName: action.toolName ?? action.actionKind,
    params: draft.params,
    reason: draft.reason ?? null,
    note: draft.note ?? null,
    snapshot,
    createdAt: new Date().toISOString(),
  };
  await postEvidenceProof(options, action, draft.summary, evidence);
}

function renderEvidenceSnapshot(action: ConnectorAction, snapshot: unknown): void {
  console.log();
  console.log(header('Snapshot'));
  console.log(kv([
    ['Action', action.label],
    ['Tool',   action.toolName ?? action.actionKind],
  ]));
  if (snapshot === null || snapshot === undefined) {
    console.log(badge('Bridge did not return snapshot data; archiving the form as evidence.', 'muted'));
  } else {
    const json = JSON.stringify(snapshot, null, 2);
    console.log(json.length > 2000 ? `${json.slice(0, 2000)}\n…(truncated)` : json);
  }
  console.log(divider());
}

async function safeReadFacts(
  options: GlobalOptions,
  connectorId: string,
  action: ConnectorAction,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    const capability = inferReadCapability(action.toolName ?? action.actionKind);
    if (!capability) return null;
    return await bridgeRequest(options, '/bridge/action/connector-read-facts', {
      method: 'POST',
      body: JSON.stringify({ connectorId, capability, ...params }),
    });
  } catch {
    return null;
  }
}

function inferReadCapability(toolOrAction: string): string | null {
  const t = toolOrAction.toLowerCase();
  if (t.includes('positions') || t.includes('wallet'))        return 'positions';
  if (t.includes('vault') || t.includes('snapshot') || t.includes('pool')) return 'markets';
  if (t.includes('history'))                                   return 'history';
  return 'markets';
}

async function postEvidenceProof(
  options: GlobalOptions,
  action: ConnectorAction,
  title: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  // Defer signing to the existing /proof helpers via a thin envelope. The
  // bridge accepts arbitrary artifact JSON; here we pass through evidence + a
  // hash-style id so the artifact looks right in /proof-list.
  const id = `proof_${cryptoHex(16)}`;
  const artifact = {
    version: 'terminal-research-v1' as const,
    id,
    title,
    kind: action.toolName ?? action.actionKind,
    concept: action.summary || 'Connector read-only evidence',
    input: JSON.stringify(evidence, null, 2),
    walletAddress: null,
    cluster: 'mainnet-beta' as const,
    createdAt: evidence.createdAt as string,
    payloadHash: '',
    category: 'advanced' as const,
  };
  try {
    await bridgeRequest(options, '/bridge/lab-artifacts', {
      method: 'POST',
      body: JSON.stringify({ artifact }),
    });
    console.log(badge('Evidence archived (unsigned).', 'ok'));
    console.log(badge(`Use /proof to sign formally — Round 4 prototype.  ID: ${id}`, 'muted'));
  } catch (err) {
    console.log(badge(`Could not archive evidence: ${err instanceof Error ? err.message : String(err)}`, 'err'));
  }
}

function cryptoHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function connectorChip(c: { needsKey: boolean }, keyInstalled: boolean): string {
  if (!c.needsKey) return '';
  return keyInstalled ? '  (key set)' : '  (needs key)';
}

// Warns when the user is about to send to their own address — usually a
// fee-wasting mistake. Returns true to proceed, false to cancel.
async function confirmSelfTransfer(options: GlobalOptions, recipient: string, label: string): Promise<boolean> {
  try {
    const { address } = await fetchWalletAddress(options);
    if (recipient.trim() === address) {
      console.log(badge(`Recipient is your own connected wallet (${address.slice(0, 8)}…). The ${label} transfer would just pay network fees.`, 'warn'));
      return confirm({ message: 'Proceed anyway?', default: false });
    }
  } catch {
    // No wallet connected → skip the check; the queue step will fail more clearly later.
  }
  return true;
}

// Best-effort: connector params have many shapes. We look for the common
// `<token>Amount` / `amount` patterns and pair with a sibling token field. If
// we can't pull anything sensible, the safety gate just shows "value unknown".
function estimateFromConnectorParams(params: Record<string, unknown>): { amount: string; token: string } | null {
  const amountAndToken = (amountKey: string, token: string) => {
    const v = params[amountKey];
    return typeof v === 'string' && v.trim().length > 0 ? { amount: v, token } : null;
  };
  return (
    amountAndToken('solAmount', 'SOL')
    ?? amountAndToken('amountSol', 'SOL')
    ?? amountAndToken('msolAmount', 'mSOL')
    ?? amountAndToken('jitoSolAmount', 'JitoSOL')
    ?? amountAndToken('lstAmount', 'LST')
    ?? amountAndToken('priceSol', 'SOL')
    ?? amountAndToken('maxPriceSol', 'SOL')
    ?? amountAndToken('bidPriceSol', 'SOL')
    ?? amountAndToken('maxEscrowSol', 'SOL')
    ?? amountAndToken('maxTotalSol', 'SOL')
    // Generic 'amount' falls back to USDC for SPL flows that don't include a token.
    ?? (typeof params['amount'] === 'string'
      ? { amount: String(params['amount']), token: typeof params['token'] === 'string' ? params['token'] as string : 'USDC' }
      : null)
  );
}
