import type { AgentPlan } from '@solana-agent-wallet-adapter/workflow';

import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';
import { select, badge, confirm, spinner, header, kv, divider } from '../tui/index.js';
import { promptSendTokensForm, type SendTokensDraft, type SendTokensFormOptions } from '../forms/sendTokens.js';
import { promptSwapForm, type SwapDraft } from '../forms/swap.js';
import { formatSlippagePercent } from '../forms/validators.js';
import { promptConnectorForm } from '../forms/connectorForm.js';
import { listConnectors, listActions, humanizeActionKind, type ConnectorAction, type ActionTier } from '../forms/connectorMeta.js';
import { maybeReviewWithAgent, composeNoteWithReview, reviewPreparedTransactionWithAgent, type AgentReviewOutcome } from '../forms/agentReview.js';
import { fetchWalletAddress, removeUndefined, listInstalledConnectorKeys } from './_shared.js';
import { runConnectorsMenu } from './connectors.js';
import { connectorSecretsForRequest, enabledConnectorIds, loadConnectorState } from './connectorState.js';
import { runRepeatMenu } from './repeat.js';
import { confirmHighStakes, estimateFromDraft } from './safetyGate.js';
import { tryHostedSwapOrder } from '../swap/hosted.js';
import { prepareAndPromptApproval, type PrepareAndPromptApprovalOptions } from './newApproval.js';

export type NewRequestMode = 'one-time' | 'repeat';
export type NewSubcommand = 'tokens' | 'swap' | 'connector';

// `/new` mirrors the web app split between New Request and Repeat Payments.
export async function runNewMenu(options: GlobalOptions): Promise<void> {
  const mode = await select<NewRequestMode>({
    message: 'What kind of request?',
    choices: [
      { name: 'One-time', value: 'one-time', description: 'Create a one-time payment, swap, or connector action' },
      { name: 'Repeat',   value: 'repeat',   description: 'Set up a payment or action that repeats' },
    ],
  });
  if (mode === 'repeat') return runRepeatMenu(options);
  return runOneTimeMenu(options);
}

export async function runOneTimeMenu(options: GlobalOptions): Promise<void> {
  const pick = await select<NewSubcommand>({
    message: 'What kind of action?',
    choices: [
      { name: 'Send Tokens',        value: 'tokens',    description: 'Send native SOL or any SPL token' },
      { name: 'Swap',               value: 'swap',      description: 'Token swap via Jupiter' },
      { name: 'Connectors',         value: 'connector', description: 'Use a connected protocol' },
    ],
  });
  if (pick === 'tokens') return runNewTokens(options);
  if (pick === 'swap') return runNewSwap(options);
  return runNewConnector(options);
}

// Unified "Send Tokens" flow. The user picks the token (SOL or any SPL) in the
// form; we route to the native SOL endpoint when token is SOL, else to SPL.
export async function runNewTokens(options: GlobalOptions, formOptions: SendTokensFormOptions = {}): Promise<void> {
  return runNewTokensWithPrefill(options, {}, formOptions);
}

export async function runNewTokensWithPrefill(
  options: GlobalOptions,
  prefill: Partial<SendTokensDraft> = {},
  formOptions: SendTokensFormOptions = {},
): Promise<void> {
  const draft = await promptSendTokensForm(options, prefill, formOptions);
  if (!(await confirmSelfTransfer(options, draft.recipient, draft.token))) return;
  const description = `Send ${draft.amount} ${draft.token} to ${draft.recipient}${draft.note ? ` - ${draft.note}` : ''}`;
  const ok = await confirmHighStakes(options, description, estimateFromDraft(draft), null);
  if (!ok) {
    console.log(badge('Aborted.', 'muted'));
    return;
  }

  const isNativeSol = draft.token.trim().toUpperCase() === 'SOL';
  const plan = buildTransferAgentPlan(draft, isNativeSol);
  const review = await maybeReviewWithAgent(options, plan);
  if (review.choice === 'delete') {
    console.log(badge('Discarded.', 'muted'));
    return;
  }

  const note = noteForReview(draft.note, review);
  await prepareAndPromptApproval(options, 'Send Tokens', () => isNativeSol
    ? bridgeRequest(options, '/bridge/action/prepare-transfer-sol', {
        method: 'POST',
        body: JSON.stringify(removeUndefined({
          recipient: draft.recipient,
          amountSol: draft.amount,
          note,
        })),
      })
    : bridgeRequest(options, '/bridge/action/prepare-transfer-spl', {
        method: 'POST',
        body: JSON.stringify(removeUndefined({
          token: draft.token,
          recipient: draft.recipient,
          amount: draft.amount,
          note,
        })),
      }), reviewToApprovalOpts(options, plan, review));
}

// Backward-compat aliases for /new-send (SOL default) and /new-spl (USDC default).
export async function runNewSend(options: GlobalOptions): Promise<void> {
  return runNewTokens(options, { defaultToken: 'SOL' });
}

export async function runNewSpl(options: GlobalOptions): Promise<void> {
  return runNewTokens(options, { defaultToken: 'USDC' });
}

export async function runNewSwap(options: GlobalOptions): Promise<void> {
  return runNewSwapWithPrefill(options);
}

export async function runNewSwapWithPrefill(options: GlobalOptions, prefill: Partial<SwapDraft> = {}): Promise<void> {
  const draft = await promptSwapForm(options, prefill);
  if (draft.inputToken.trim().toUpperCase() === draft.outputToken.trim().toUpperCase()) {
    console.log(badge(`Input and output token are both ${draft.inputToken} - swap would be a no-op. Aborting.`, 'err'));
    return;
  }
  const quote = await previewSwapQuote(options, draft);
  if (quote === 'aborted') return;
  const description = `Swap ${draft.amount} ${draft.inputToken} → ${draft.outputToken}${draft.slippageBps !== undefined ? ` (slippage ${formatSlippagePercent(draft.slippageBps)})` : ''}`;
  const ok = await confirmHighStakes(options, description, estimateFromDraft(draft), null);
  if (!ok) {
    console.log(badge('Aborted.', 'muted'));
    return;
  }

  const plan = buildSwapAgentPlan(draft);
  const review = await maybeReviewWithAgent(options, plan);
  if (review.choice === 'delete') {
    console.log(badge('Discarded.', 'muted'));
    return;
  }

  const note = noteForReview(draft.note, review);
  await prepareAndPromptApproval(options, 'Swap', () => bridgeRequest(options, '/bridge/action/prepare-swap', {
    method: 'POST',
    body: JSON.stringify(removeUndefined({ ...draft, note })),
  }), reviewToApprovalOpts(options, plan, review));
}

// Build an AgentPlan from each /new draft. The `source: 'template'` field is
// critical: the post-LLM bypass-claim guardrail in workflow only fires when
// source === 'ai', so using 'template' (the user drafted this manually) lets
// the agent review the draft without tripping the false-positive that broke
// the old maybeEnhanceWithAi flow. See plan file for context.
function buildSwapAgentPlan(draft: { amount: string; inputToken: string; outputToken: string; slippageBps?: number; note?: string }): AgentPlan {
  const slippage = draft.slippageBps ?? 50;
  return {
    source: 'template',
    category: 'trading',
    actionType: 'swap',
    templateTitle: 'Swap tokens',
    intent: `Swap ${draft.amount} ${draft.inputToken} to ${draft.outputToken}`,
    route: `${draft.inputToken} → ${draft.outputToken}, max slippage ${formatSlippagePercent(slippage)}`,
    risk: 'Medium',
    approval: 'Wallet approval required before signing',
    parameters: {
      inputToken: draft.inputToken,
      outputToken: draft.outputToken,
      amount: draft.amount,
      slippageBps: String(slippage),
    },
    fields: [
      { label: 'Input token', value: draft.inputToken },
      { label: 'Output token', value: draft.outputToken },
      { label: 'Amount', value: draft.amount },
      { label: 'Slippage', value: formatSlippagePercent(slippage) },
    ],
    safeguards: ['Wallet approval required before signing.'],
    userNotes: draft.note ?? '',
  };
}

function buildTransferAgentPlan(
  draft: { amount: string; token: string; recipient: string; note?: string },
  isNativeSol: boolean,
): AgentPlan {
  const actionType = isNativeSol ? 'transfer_sol' : 'transfer_spl';
  return {
    source: 'template',
    category: 'payments',
    actionType,
    templateTitle: isNativeSol ? 'Send SOL' : `Send ${draft.token}`,
    intent: `Send ${draft.amount} ${draft.token} to ${draft.recipient}`,
    route: `${draft.token} → ${draft.recipient}`,
    risk: 'Medium',
    approval: 'Wallet approval required before signing',
    parameters: {
      token: draft.token,
      recipient: draft.recipient,
      amount: draft.amount,
    },
    fields: [
      { label: 'Token', value: draft.token },
      { label: 'Recipient', value: draft.recipient },
      { label: 'Amount', value: draft.amount },
    ],
    safeguards: ['Wallet approval required before signing.'],
    userNotes: draft.note ?? '',
  };
}

function buildConnectorAgentPlan(
  connectorId: string,
  actionKind: string,
  draft: { summary: string; params: Record<string, unknown>; reason?: string; note?: string },
): AgentPlan {
  const parameters: Record<string, string> = {};
  const fields: AgentPlan['fields'] = [];
  for (const [key, raw] of Object.entries(draft.params)) {
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : JSON.stringify(raw);
    parameters[key] = value;
    fields.push({ label: humanizeLabel(key), value });
  }
  return {
    source: 'template',
    category: 'connector',
    actionType: actionKind,
    templateTitle: draft.summary || `${connectorId}: ${actionKind}`,
    intent: draft.summary || `${connectorId}: ${actionKind}`,
    route: `${connectorId} → ${actionKind}`,
    risk: 'Medium',
    approval: 'Wallet approval required before signing',
    parameters,
    fields,
    safeguards: ['Wallet approval required before signing.'],
    userNotes: [draft.reason, draft.note].filter((p): p is string => Boolean(p?.trim())).join('\n'),
  };
}

function humanizeLabel(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Compose the prepared-action note. When the agent reviewed and the user
// chose Send-anyway despite a deny/needs_input, append the override line so
// the audit trail mirrors the /agent flow.
function noteForReview(baseNote: string | undefined, review: AgentReviewOutcome): string | undefined {
  if (!review.reviewed) return baseNote?.trim() || undefined;
  const decision = review.decision ?? '';
  const isOverride = review.choice === 'send' && (decision === 'deny' || decision === 'needs_input');
  const overrideLine = isOverride
    ? `Override: ${decision === 'deny' ? 'agent denied' : 'agent needed input'}`
    : undefined;
  return composeNoteWithReview(baseNote, review.reviewSummary, overrideLine);
}

function reviewToApprovalOpts(
  options: GlobalOptions,
  plan: AgentPlan,
  review: AgentReviewOutcome,
): PrepareAndPromptApprovalOptions {
  const approvalOpts: PrepareAndPromptApprovalOptions = {};
  if (review.reviewed) {
    if (review.choice === 'save') approvalOpts.skipApprovalPrompt = true;
    if (review.choice === 'send') approvalOpts.autoApprove = true;
  }
  if (review.needsPreparedTxReview) {
    approvalOpts.beforeApprovalPrompt = async (_result, action) => {
      const transactionBase64 = typeof action?.params?.transactionBase64 === 'string'
        ? action.params.transactionBase64
        : undefined;
      if (!transactionBase64) return undefined;
      const txReview = await reviewPreparedTransactionWithAgent(options, plan, review, transactionBase64);
      if (!txReview) return undefined;
      if (txReview.choice === 'delete') return { deleteAction: true };
      if (txReview.choice === 'save') return { approvalOptions: { skipApprovalPrompt: true, autoApprove: false } };
      if (txReview.choice === 'send') return { approvalOptions: { autoApprove: true, skipApprovalPrompt: false } };
      return undefined;
    };
  }
  return approvalOpts;
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
    const hosted = await tryHostedSwapOrder(options, draft);
    const quote = hosted.ok
      ? hosted.value
      : await bridgeRequest<Record<string, unknown>>(options, '/bridge/action/swap-quote', {
          method: 'POST',
          body: JSON.stringify(removeUndefined({
            amount: draft.amount,
            inputToken: draft.inputToken,
            outputToken: draft.outputToken,
            slippageBps: draft.slippageBps,
          })),
        });
    spin.succeed(hosted.ok ? 'Hosted Jupiter quote received.' : 'Quote received.');
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
    const proceed = await confirm({ message: 'Looks right - continue?', default: true });
    return proceed ? 'ok' : 'aborted';
  } catch (err) {
    spin.fail(`Quote failed: ${err instanceof Error ? err.message : String(err)}`);
    if (opts.preview) return 'ok';
    const proceed = await confirm({ message: 'Continue anyway?', default: false });
    return proceed ? 'ok' : 'aborted';
  }
}

function describeOutAmount(quote: Record<string, unknown>, outputToken: string): string {
  // Prefer the backend's pre-computed USD floats. The raw outAmount is in the
  // output token's base units (e.g. 843621 for 0.843621 USDC) — showing it as a
  // token amount without a decimals lookup would mislead the user, so anchor on
  // USD instead.
  const usd = pickField(quote, ['outUsdValue', 'swapUsdValue']);
  if (usd !== undefined) {
    const n = Number(usd);
    if (Number.isFinite(n) && n > 0) {
      return `~$${n.toFixed(2)} worth of ${outputToken}`;
    }
  }
  const raw = pickField(quote, ['outAmount', 'outputAmount', 'expectedOutput', 'amountOut']);
  if (raw === undefined) return `(check ${outputToken})`;
  return `${raw} (raw ${outputToken} base units)`;
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
  const connectorState = await loadConnectorState(options);
  const connectedIds = enabledConnectorIds(connectorState);
  while (true) {
    const pickedId = await pickConnector(options, installedKeys, connectedIds);
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
        console.log(badge('Run /new-connector again once the connector is connected.', 'muted'));
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

async function pickConnector(options: GlobalOptions, installedKeys: Set<string>, connectedIds: Set<string>): Promise<string | undefined> {
  const connectors = listConnectors().filter((connector) => connectedIds.has(connector.id));
  if (connectors.length === 0) {
    console.log(badge('No connectors are connected yet.', 'warn'));
    const setup = await confirm({ message: 'Open /connectors to connect one now?', default: true });
    if (setup) await runConnectorsMenu(options);
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
  const description = `${draft.summary} - params: ${JSON.stringify(draft.params)}`;
  const ok = await confirmHighStakes(options, description, estimateFromConnectorParams(draft.params), null);
  if (!ok) {
    console.log(badge('Aborted.', 'muted'));
    return;
  }

  const plan = buildConnectorAgentPlan(connectorId, action.actionKind, draft);
  const review = await maybeReviewWithAgent(options, plan);
  if (review.choice === 'delete') {
    console.log(badge('Discarded.', 'muted'));
    return;
  }

  const { address, cluster } = await fetchWalletAddress(options);
  const connectorSecrets = connectorSecretsForRequest(connectorId);
  const note = noteForReview(draft.note, review);
  const body = removeUndefined({
    kind: draft.actionKind,
    params: draft.params,
    walletAddress: address,
    cluster,
    summary: draft.summary,
    reason: draft.reason,
    note,
    connectorSecrets,
  });
  await prepareAndPromptApproval(options, draft.summary, () => bridgeRequest(options, '/bridge/connector/prepare-action', {
    method: 'POST',
    body: JSON.stringify(body),
  }), reviewToApprovalOpts(options, plan, review));
}

async function runConnectorReadOnly(options: GlobalOptions, connectorId: string, action: ConnectorAction): Promise<void> {
  // Read-only actions are evidence-only: collect the form, fetch the snapshot,
  // render the result, archive in /bridge/lab-artifacts. No prepared action is
  // queued; nothing hits chain. Mirrors the web's "EVIDENCE-ONLY" routing.
  console.log(badge('Evidence-only action - nothing will be queued for approval.', 'muted'));
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
      body: JSON.stringify({
        connectorId,
        capability,
        ...params,
        ...(connectorSecretsForRequest(connectorId) ? { connectorSecrets: connectorSecretsForRequest(connectorId) } : {}),
      }),
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
    console.log(badge(`Use /proof to sign formally - Round 4 prototype.  ID: ${id}`, 'muted'));
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
