import {
  defaultTemplateFieldValues,
  inferTemplateIdForPrompt,
  inferredTemplateParameters,
  templateById,
  type AgentChatMessage,
  type AgentChatSection,
  type AiPlanRequest,
} from '@solana-agent-wallet-adapter/workflow';

import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest, renderWebRequest } from '../http/index.js';
import { input, confirm, select, spinner, header, kv, badge, divider, multilineInput } from '../tui/index.js';
import { loadSession, sessionStatusSummary } from '../auth/sessionStore.js';
import { removeUndefined, printQueuedAction, fetchWalletAddress } from './_shared.js';
import { renderPolicyBundle, verdictBlocksQueue, type ReviewResponse, type PolicyReviewVerdict } from '../forms/policyBundleRender.js';
import { friendlyBridgeError } from './_shared.js';
import {
  agentAiRouteLabel,
  agentAiSetupHint,
  askAgentPlan,
  chatAgent,
  generateAgentPlan,
  resolveAgentAiRoute,
  reviewAgentPlan,
  type AgentAiRoute,
} from '../ai/hosted.js';
import { runNewConnector, runNewMenu, runNewSwapWithPrefill, runNewTokensWithPrefill } from './new.js';
import { runRepeatMenu, runRepeatScheduledWithPrefill, type ScheduledTransferPrefill } from './repeat.js';

// `runAgent` accepts an optional plan-proof signer so it can offer to sign the
// AI's plan as off-chain evidence (separate from queueing). The signer lives
// in index.ts (it needs `state` for the wallet-host handshake); flow modules
// can't import from index.ts, so we wire it via this callback.
export interface AgentPlanArtifact {
  id: string;
  payloadHash: string;
}
export type SignPlanFn = (plan: AgentPlan, policyNote: string) => Promise<AgentPlanArtifact | null>;

// Cached across `/agent` and `/ask` calls so follow-up questions reuse the
// last plan as context. Cleared when /agent generates a new one.
let LAST_PLAN: AgentPlan | null = null;

export function getLastPlan(): AgentPlan | null {
  return LAST_PLAN;
}

// `/agent` — chat-first agent mode. Users can investigate freely, then type
// /plan, /new, or /prepare to hand the transcript into the normal /new flow.
export async function runAgent(options: GlobalOptions, signPlanFn?: SignPlanFn): Promise<void> {
  void signPlanFn;
  await runAgentChat(options);
}

export interface AgentChatResponse {
  answer?: string;
  sections?: AgentChatSection[];
  next?: string;
  citations?: Array<{ kind?: string; ref?: string; title?: string }>;
}

async function runAgentChat(options: GlobalOptions): Promise<void> {
  console.log(header('Agent Chat'));
  console.log(badge('Chat freely. Type /plan, /new, or /prepare to turn this into a wallet request. Type /exit to return.', 'muted'));

  const route = await resolveAgentAiRoute(options);
  if (route.kind === 'none') {
    console.log(badge(agentAiSetupHint(route), 'warn'));
    return;
  }
  console.log(badge(`AI route: ${agentAiRouteLabel(route)}`, 'muted'));

  const messages: AgentChatMessage[] = [];
  while (true) {
    const raw = await multilineInput({ message: 'You' });
    const text = raw.trim();
    if (!text) continue;

    const command = parseAgentChatCommand(text);
    if (command.kind === 'exit') {
      console.log(badge('Leaving agent chat.', 'muted'));
      return;
    }
    if (command.kind === 'help') {
      printAgentChatHelp();
      continue;
    }
    if (command.kind === 'prepare') {
      if (command.extra) messages.push({ role: 'user', content: command.extra });
      await preparePlanFromAgentChat(options, route, messages);
      return;
    }

    messages.push({ role: 'user', content: text });
    const spin = spinner('Agent thinking...');
    try {
      const response = await chatAgent<AgentChatResponse>(options, route, { messages });
      spin.succeed('Agent answered.');
      const answer = renderChatAnswer(response);
      if (answer) messages.push({ role: 'assistant', content: answer });
    } catch (err) {
      const friendly = friendlyBridgeError(err, options);
      spin.fail(friendly ?? `Agent chat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

type AgentChatCommand =
  | { kind: 'chat' }
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'prepare'; extra: string };

function parseAgentChatCommand(text: string): AgentChatCommand {
  const match = text.match(/^\/([a-z-]+)(?:\s+([\s\S]*))?$/i);
  if (!match) return { kind: 'chat' };
  const name = match[1]?.toLowerCase() ?? '';
  const extra = match[2]?.trim() ?? '';
  if (name === 'exit' || name === 'quit' || name === 'back') return { kind: 'exit' };
  if (name === 'help' || name === '?') return { kind: 'help' };
  if (name === 'plan' || name === 'new' || name === 'prepare') return { kind: 'prepare', extra };
  return { kind: 'chat' };
}

function printAgentChatHelp(): void {
  console.log();
  console.log(header('Agent chat commands'));
  console.log('/plan      Prepare a wallet request from this chat');
  console.log('/new       Same as /plan');
  console.log('/prepare   Same as /plan');
  console.log('/exit      Return to the main CLI');
  console.log(divider());
}

function renderChatAnswer(raw: AgentChatResponse): string {
  const display = buildAgentChatDisplay(raw);
  console.log(display.output);
  return display.transcript;
}

export interface AgentChatDisplay {
  output: string;
  transcript: string;
}

const AGENT_CHAT_SOURCE_LIMIT = 6;
const AGENT_CHAT_NEXT_HINT = 'Type /plan, /new, or /prepare to turn this into a wallet request. Type /exit to leave agent chat.';

export function buildAgentChatDisplay(raw: AgentChatResponse): AgentChatDisplay {
  const answer = cleanDisplayBlock(typeof raw.answer === 'string' ? raw.answer : JSON.stringify(raw, null, 2));
  const sections = normalizeDisplaySections(raw.sections);
  const next = cleanDisplayLine(raw.next) || AGENT_CHAT_NEXT_HINT;
  const citations = normalizeDisplayCitations(raw.citations);

  const lines: string[] = ['', header('Agent'), '', header('Answer')];
  lines.push(...displayParagraph(answer));
  for (const section of sections) {
    lines.push('', header(section.title));
    for (const bullet of section.bullets) {
      lines.push(`  • ${bullet}`);
    }
  }
  lines.push('', header('Next'), `  ${next}`);
  if (citations.length > 0) {
    lines.push('', header('Sources'));
    const shown = citations.slice(0, AGENT_CHAT_SOURCE_LIMIT);
    shown.forEach((citation, index) => {
      lines.push(`  [${index + 1}] ${formatDisplayCitation(citation)}`);
    });
    if (citations.length > shown.length) {
      lines.push(`  ${badge(`and ${citations.length - shown.length} more`, 'muted')}`);
    }
  }
  lines.push(divider());

  const transcript = [
    answer,
    ...sections.flatMap((section) => [
      `${section.title}:`,
      ...section.bullets.map((bullet) => `- ${bullet}`),
    ]),
    next,
  ].filter(Boolean).join('\n');

  return {
    output: lines.join('\n'),
    transcript,
  };
}

function normalizeDisplaySections(value: unknown): AgentChatSection[] {
  if (!Array.isArray(value)) return [];
  const sections: AgentChatSection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const title = cleanDisplayLine(record.title);
    const bullets = Array.isArray(record.bullets)
      ? record.bullets
          .map((bullet) => cleanDisplayLine(bullet))
          .filter(Boolean)
          .slice(0, 5)
      : [];
    if (!title || bullets.length === 0) continue;
    sections.push({ title, bullets });
    if (sections.length >= 4) break;
  }
  return sections;
}

function normalizeDisplayCitations(value: unknown): Array<{ kind?: string; ref?: string; title?: string }> {
  if (!Array.isArray(value)) return [];
  const citations: Array<{ kind?: string; ref?: string; title?: string }> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const ref = cleanDisplayLine(record.ref);
    const title = cleanDisplayLine(record.title);
    const kind = cleanDisplayLine(record.kind);
    if (!ref && !title) continue;
    const key = (ref || title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      ...(kind ? { kind } : {}),
      ...(ref ? { ref } : {}),
      ...(title ? { title } : {}),
    });
  }
  return citations;
}

function formatDisplayCitation(citation: { kind?: string; ref?: string; title?: string }): string {
  const title = citation.title || citation.ref || '?';
  const ref = citation.ref ?? '';
  const label = citation.kind === 'url' || /^https?:\/\//i.test(ref) ? domainOrRef(ref) : (citation.kind || domainOrRef(ref));
  return label && label !== title ? `${title} - ${badge(label, 'muted')}` : title;
}

function domainOrRef(value: string): string {
  if (!value) return '';
  try {
    return new URL(value).hostname.replace(/^www\./i, '');
  } catch {
    return value;
  }
}

function displayParagraph(value: string): string[] {
  const lines = value.split('\n');
  return lines.length ? lines.map((line) => (line ? `  ${line}` : '')) : [''];
}

function cleanDisplayBlock(value: string): string {
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanDisplayLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

async function preparePlanFromAgentChat(
  options: GlobalOptions,
  route: AgentAiRoute,
  messages: AgentChatMessage[],
): Promise<void> {
  if (messages.length === 0) {
    const firstRequest = await multilineInput({ message: 'What should the wallet prepare?' });
    if (!firstRequest.trim()) {
      console.log(badge('No wallet request provided.', 'muted'));
      return;
    }
    messages.push({ role: 'user', content: firstRequest.trim() });
  }

  const transcript = agentChatTranscript(messages);
  const request = agentChatPlanRequest(transcript);
  const spin = spinner('Preparing draft from chat...');
  let plan: AgentPlan | null = null;
  try {
    plan = (await generateAgentPlan<AgentPlan>(options, route, request as unknown as Record<string, unknown>)) ?? null;
    spin.succeed('Draft prepared.');
  } catch (err) {
    const friendly = friendlyBridgeError(err, options);
    spin.fail(friendly ?? `Plan preparation failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  renderPlan(plan);
  LAST_PLAN = plan;
  if (!plan) return;
  await runNewFromAgentPlan(options, plan, transcript);
}

function agentChatTranscript(messages: AgentChatMessage[]): string {
  return messages
    .map((message) => `${message.role === 'assistant' ? 'Agent' : 'User'}: ${message.content}`)
    .join('\n')
    .slice(-8_000);
}

function agentChatPlanRequest(transcript: string): AiPlanRequest {
  const prompt = [
    'Prepare the concrete wallet request implied by this agent chat.',
    'Use only details the user supplied or explicitly accepted.',
    'If key fields are missing, leave them for the normal CLI form to ask.',
    '',
    transcript,
  ].join('\n');
  const template = templateById(inferTemplateIdForPrompt(transcript, 'custom-request'));
  const parameters = inferredTemplateParameters(
    template,
    transcript,
    defaultTemplateFieldValues(template),
  );
  return {
    prompt,
    userNotes: `Prepared from /agent chat.\n${transcript}`.slice(0, 4_000),
    template: {
      id: template.id,
      category: template.category,
      title: template.title,
      description: template.description,
      actionType: template.actionType,
      risk: template.risk,
    },
    parameters,
  };
}

async function runNewFromAgentPlan(options: GlobalOptions, plan: AgentPlan, transcript: string): Promise<void> {
  const merged: AgentPlan = plan.plan ? { ...plan, ...plan.plan } : plan;
  const template = templateById(inferTemplateIdForPrompt(transcript, 'custom-request'));
  const defaults = defaultTemplateFieldValues(template);
  const params = merged.parameters ?? {};
  const note = agentPlanNote(merged, transcript);

  const param = (key: string): string | undefined => {
    const raw = params[key];
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!value) return undefined;
    const fallback = defaults[key]?.trim();
    if (fallback && value === fallback && !transcript.toLowerCase().includes(value.toLowerCase())) {
      return undefined;
    }
    return value;
  };

  if (merged.actionType === 'transfer_sol' || merged.actionType === 'transfer_spl' || merged.templateId === 'send-tokens') {
    await runNewTokensWithPrefill(options, removeUndefined({
      token: param('token') ?? (merged.actionType === 'transfer_sol' ? 'SOL' : undefined),
      recipient: param('recipient'),
      amount: param('amount') ?? param('amountSol') ?? param('amountSpl'),
      note,
    }));
    return;
  }

  if (merged.actionType === 'swap' || merged.templateId === 'swap') {
    const slippageRaw = param('slippageBps');
    const slippageBps = slippageRaw !== undefined && Number.isFinite(Number(slippageRaw)) ? Number(slippageRaw) : undefined;
    await runNewSwapWithPrefill(options, removeUndefined({
      inputToken: param('inputToken'),
      outputToken: param('outputToken'),
      amount: param('amount'),
      slippageBps,
      note,
    }));
    return;
  }

  if (merged.actionType === 'recurring_payment' || merged.templateId === 'subscription') {
    const cadence = normalizeScheduledCadence(param('cadence'));
    const prefill: ScheduledTransferPrefill = removeUndefined({
      token: param('token'),
      recipient: param('recipient'),
      amount: param('amount'),
      note,
      cadence,
    });
    await runRepeatScheduledWithPrefill(options, prefill);
    return;
  }

  if (template.id === 'dca') {
    console.log(badge('The agent inferred a DCA or recurring swap. Opening the repeat flow so you can choose the exact recurring engine.', 'muted'));
    await runRepeatMenu(options);
    return;
  }

  if (merged.actionType === 'blink_action') {
    console.log(badge('The agent inferred a connector/Blink action. Opening the connector flow so you can pick the exact protocol action.', 'muted'));
    await runNewConnector(options);
    return;
  }

  console.log(badge('The chat did not resolve to a concrete transfer, swap, repeat payment, or connector action. Opening /new.', 'warn'));
  await runNewMenu(options);
}

function agentPlanNote(plan: AgentPlan, transcript: string): string | undefined {
  const params = plan.parameters ?? {};
  const explicit = typeof params.note === 'string' ? params.note : typeof params.memo === 'string' ? params.memo : '';
  if (explicit.trim()) return explicit.trim().slice(0, 500);
  const lastUser = transcript
    .split('\n')
    .reverse()
    .find((line) => line.startsWith('User: '))
    ?.replace(/^User:\s*/, '')
    .trim();
  return lastUser ? `Agent chat: ${lastUser}`.slice(0, 500) : undefined;
}

function normalizeScheduledCadence(value: string | undefined): ScheduledTransferPrefill['cadence'] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'weekly' || normalized === 'monthly' || normalized === 'interval_days' || normalized === 'interval_hours' || normalized === 'interval_minutes') {
    return normalized;
  }
  if (normalized === 'days') return 'interval_days';
  if (normalized === 'hours') return 'interval_hours';
  if (normalized === 'minutes') return 'interval_minutes';
  return undefined;
}

// Legacy plan-first body retained for tests and future direct-plan entrypoints.
// The public /agent command now starts in chat mode above.
async function runAgentPlanFirst(options: GlobalOptions, signPlanFn?: SignPlanFn): Promise<void> {
  console.log(header('Agent — natural language to wallet plan'));

  const session = await loadSession(options).catch(() => null);
  const auth = sessionStatusSummary(session);
  if (!auth.authenticated) {
    console.log(badge('You are not signed in. Agentic hosted AI and cloud sync require sign-in; local bridge AI can still work if configured.', 'muted'));
    const proceed = await confirm({ message: 'Continue without sign-in?', default: true });
    if (!proceed) {
      console.log(badge('Tip: run /sign-in to authenticate.', 'muted'));
      return;
    }
  }

  let prompt = await multilineInput({
    message: 'What should the wallet do? (e.g. "stake 0.01 SOL on Marinade")',
  });
  if (!prompt.trim()) {
    console.log(badge('Empty intent — try again, or Ctrl+C to cancel.', 'muted'));
    prompt = await multilineInput({
      message: 'What should the wallet do?',
    });
    if (!prompt.trim()) {
      console.log(badge('Still empty — aborted.', 'warn'));
      return;
    }
  }

  console.log(badge('Add policy NOTE? (constraints that must hold, e.g. "Only approve if SOL > $80 AND mint authority disabled")', 'muted'));
  const policyNote = await multilineInput({
    message: 'Policy NOTE (blank to skip)',
    default: '',
  });

  const aiRoute = await resolveAgentAiRoute(options);
  console.log(badge(`AI route: ${agentAiRouteLabel(aiRoute)}`, 'muted'));

  const spin = spinner('Thinking…');
  let plan: AgentPlan | null = null;
  try {
    plan = (await generateAgentPlan<AgentPlan>(options, aiRoute, removeUndefined({
      prompt,
      userNotes: policyNote.trim() ? policyNote : prompt,
    }))) ?? null;
    spin.succeed('AI returned a plan.');
  } catch (err) {
    const friendly = friendlyBridgeError(err, options);
    const message = err instanceof Error ? err.message : String(err);
    const setupHint = aiRoute.kind === 'none'
      ? agentAiSetupHint(aiRoute)
      : /Bridge AI is not configured|AGENTIC_AI_API_KEY|session key/i.test(message)
      ? 'Agent is not configured. Run /agent-setup to use hosted AI or add a local provider key.'
      : null;
    spin.fail(friendly ?? setupHint ?? `AI failed: ${message}`);
    return;
  }

  renderPlan(plan);
  LAST_PLAN = plan;

  if (!plan) return;

  let verdict: PolicyReviewVerdict | null = null;
  if (policyNote.trim()) {
    verdict = await runReviewLoop(options, aiRoute, plan, policyNote);
  }

  const blocked = verdictBlocksQueue(verdict);
  const needsInput = verdict?.decision === 'needs_input';
  // Policy NOTE was provided but the review loop returned no verdict (bridge
  // error, empty response, or 5-attempt exhaustion — see runReviewLoop). We
  // can't claim approval, so treat it like the user's needs-input path and
  // make the override available with an honest label.
  const reviewIndeterminate = Boolean(policyNote.trim()) && verdict === null;
  const requiresOverride = blocked || needsInput || reviewIndeterminate;

  if (blocked) {
    console.log();
    console.log(badge('Plan was denied by policy review.', 'err'));
    console.log(badge('You can still send it to the approval inbox if you want to proceed — an override entry will be saved in the note.', 'muted'));
  } else if (needsInput) {
    console.log();
    console.log(badge('Agent review did not reach a conclusive verdict.', 'warn'));
    console.log(badge('You can still send it to the approval inbox if you want to proceed — an override entry will be saved in the note.', 'muted'));
  } else if (reviewIndeterminate) {
    console.log();
    console.log(badge("Policy review didn't finish — verdict unknown.", 'warn'));
    console.log(badge('You can still send it to the approval inbox if you want to proceed — an override entry will be saved in the note.', 'muted'));
  }

  const choices = buildAgentActionChoices({ blocked, needsInput, reviewIndeterminate });
  const action = await select<AgentAction>({
    message: 'What next?',
    choices,
    // After a DENY / needs_input / failed review, default to the non-destructive
    // proof option so an accidental Enter doesn't commit the override. The
    // override path is still one keystroke away.
    default: requiresOverride ? 'proof' : 'queue',
  });

  if (action === 'done') {
    console.log(badge('Plan kept locally. Use /ask <question> to drill in, or /agent to refine.', 'muted'));
    return;
  }

  if (action === 'proof' || action === 'both') {
    if (!signPlanFn) {
      console.log(badge('Proof signing isn\'t wired into this entry point. Use the REPL /agent for full proof support.', 'warn'));
    } else {
      try {
        const artifact = await signPlanFn(plan, policyNote.trim());
        if (artifact) {
          console.log();
          console.log(badge(`Proof signed. ID: ${artifact.id}`, 'ok'));
          console.log(badge('Visible in /proof-list and /done --filter proofs.', 'muted'));
        }
      } catch (err) {
        console.log(badge(`Proof signing failed: ${err instanceof Error ? err.message : String(err)}`, 'err'));
      }
    }
  }

  if (action === 'queue' || action === 'both') {
    let overrideContext: string[] | undefined;
    if (requiresOverride) {
      const rawReason = await input({
        message: 'Why are you sending anyway? (Optional, saved in the action note)',
        default: '',
      });
      const userReason = rawReason.trim() || undefined;
      const agentStatus: AgentOverrideStatus = blocked
        ? 'denied'
        : needsInput
          ? 'needs_input'
          : 'indeterminate';
      overrideContext = [
        buildReviewLine(agentStatus, verdict?.reason),
        buildOverrideNote(agentStatus, userReason),
      ];
    }
    const result = await queuePlan(options, plan, overrideContext);
    if (result) printQueuedAction(plan.summary ?? 'Agent plan', result);
  }
}

type AgentAction = 'proof' | 'queue' | 'both' | 'done';

export interface AgentActionChoiceContext {
  blocked: boolean;
  needsInput: boolean;
  reviewIndeterminate?: boolean;
}

// Exported for unit testing — builds the action picker for runAgent so the
// override path stays available even when the agent denies, asks for input,
// or fails to produce a verdict at all. The user can always queue (with an
// override note recorded); the picker just rephrases the labels so they
// understand they're overriding the verdict.
export function buildAgentActionChoices(
  ctx: AgentActionChoiceContext,
): Array<{ name: string; value: AgentAction; description?: string }> {
  const { blocked, needsInput, reviewIndeterminate = false } = ctx;
  const requiresOverride = blocked || needsInput || reviewIndeterminate;
  const overrideKind = blocked
    ? 'denial'
    : needsInput
      ? 'questions'
      : 'unfinished review';

  return [
    {
      name: 'Sign as off-chain proof (no transaction sent)',
      value: 'proof',
      description: 'Saves a wallet-signed evidence record to /proof-list. Useful for audit / accountability.',
    },
    {
      name: requiresOverride
        ? `Queue anyway — send to /inbox (overrides agent ${overrideKind})`
        : 'Queue as a prepared approval (sends to /inbox)',
      value: 'queue',
      description: requiresOverride
        ? 'Bypasses the agent verdict; records an override entry in the action note.'
        : 'Prepared action awaits your wallet signature in the inbox.',
    },
    {
      name: requiresOverride
        ? 'Both — sign the off-chain proof first, then queue anyway (override)'
        : 'Both — sign the off-chain proof first, then queue the prepared approval',
      value: 'both',
    },
    {
      name: 'Done — keep the plan locally',
      value: 'done',
      description: 'Use /ask <question> to drill in, or /agent to refine.',
    },
  ];
}

// Mirrors apps/browser-demo/src/main.ts:overrideShortLabel + the "Override:"
// prefix it gets in queuePlanThroughBridge (main.ts:37954-37957) so override
// notes look the same regardless of which surface queued them.
export type AgentOverrideStatus = 'denied' | 'needs_input' | 'indeterminate';

export function buildOverrideNote(
  agentStatus: AgentOverrideStatus,
  userReason: string | undefined,
): string {
  const verdict = agentStatus === 'denied'
    ? 'agent denied'
    : agentStatus === 'needs_input'
      ? 'agent needed input'
      : 'agent review unfinished';
  const reason = userReason?.trim();
  return reason ? `Override: ${verdict}; user: ${reason}` : `Override: ${verdict}`;
}

// Mirrors browser-demo's `Agent ${status}: ${reason}` line that gets joined into
// the note alongside the Override entry (main.ts:37951-37957). Returns
// undefined when no review context exists, so composeNote can drop it.
export function buildReviewLine(
  agentStatus: AgentOverrideStatus,
  verdictReason: string | undefined,
): string {
  const status = agentStatus === 'denied'
    ? 'denied'
    : agentStatus === 'needs_input'
      ? 'needs input'
      : 'review unfinished';
  const reason = verdictReason?.trim();
  return reason ? `Agent ${status}: ${reason}` : `Agent ${status}`;
}

// `/ask` — follow-up Q&A about the most recent /agent plan.
export async function runAsk(options: GlobalOptions, question?: string): Promise<void> {
  if (!LAST_PLAN) {
    console.log(badge('No active plan. Run /agent first; then /ask <question>.', 'warn'));
    return;
  }
  const q = (question ?? '').trim() || (await multilineInput({
    message: 'What do you want to ask about the last plan?',
  })).trim();
  if (!q) {
    console.log(badge('Empty question — aborted.', 'muted'));
    return;
  }
  const spin = spinner('Thinking…');
  try {
    const route = await resolveAgentAiRoute(options);
    const raw = await askAgentPlan<Record<string, unknown>>(options, route, { plan: LAST_PLAN, question: q });
    spin.succeed('Answer received.');
    renderAnswer(raw);
  } catch (err) {
    const friendly = friendlyBridgeError(err, options);
    const message = err instanceof Error ? err.message : String(err);
    spin.fail(friendly ?? `Ask failed: ${message}`);
  }
}

function renderAnswer(raw: Record<string, unknown>): void {
  console.log();
  console.log(header('Answer'));
  const answer = typeof raw.answer === 'string' ? raw.answer : JSON.stringify(raw, null, 2);
  console.log(answer);
  const citations = Array.isArray(raw.citations) ? raw.citations : [];
  if (citations.length > 0) {
    console.log();
    console.log(header('Citations'));
    for (const c of citations) {
      if (c && typeof c === 'object') {
        const o = c as Record<string, unknown>;
        console.log(`  · ${o.title ?? o.ref ?? '?'}  ${badge(String(o.kind ?? '—'), 'muted')}`);
      }
    }
  }
  console.log(divider());
}

// review-plan loop: handles needs_input by re-prompting + re-submitting until
// the LLM settles on approve/deny or the user cancels. Returns the final
// verdict so the caller (runAgent) can gate the queue prompt on a DENY or
// blocking-failure outcome.
async function runReviewLoop(options: GlobalOptions, route: AgentAiRoute, plan: AgentPlan, instruction: string): Promise<PolicyReviewVerdict | null> {
  const answers: Record<string, unknown> = {};
  const multi = await isMultiReviewerEnabled(options);
  if (multi) console.log(badge('Multi-reviewer mode is on (preferences → AI Drafting).', 'muted'));
  let attempt = 0;
  while (attempt < 5) {
    attempt += 1;
    const spin = spinner(attempt === 1 ? 'Resolving policy atoms…' : 'Re-reviewing with your answers…');
    let response: ReviewResponse | null = null;
    try {
      response = await reviewAgentPlan<ReviewResponse>(options, route, removeUndefined({
          plan,
          instruction,
          mode: multi ? 'multi' : undefined,
          context: Object.keys(answers).length > 0 ? { answers } : undefined,
        }));
      spin.succeed('Review complete.');
    } catch (err) {
      const friendly = friendlyBridgeError(err, options);
      spin.fail(friendly ?? `Review failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (!response) return null;

    const verdict = renderPolicyBundle(response);

    if (response.decision !== 'needs_input' || !response.questions?.length) {
      return verdict;
    }

    console.log();
    console.log(header('AI needs clarifying input'));
    for (const q of response.questions) {
      const key = q.id ?? q.label ?? `q${Object.keys(answers).length + 1}`;
      const label = q.prompt ?? q.label ?? `Question ${key}`;
      const inputKind = (q as { inputKind?: string }).inputKind ?? (q.options && q.options.length > 0 ? 'select' : 'text');

      if (inputKind === 'select' && q.options && q.options.length > 0) {
        const picked = await select<string>({
          message: label,
          choices: q.options.map((opt) => ({ name: opt, value: opt })),
        });
        answers[key] = picked;
        continue;
      }
      if (inputKind === 'number') {
        const value = await input({
          message: label,
          validate: (v) => /^-?\d+(\.\d+)?$/.test(v.trim()) || 'Must be a number.',
        });
        const trimmed = value.trim();
        if (trimmed) answers[key] = Number(trimmed);
        continue;
      }
      if (inputKind === 'boolean') {
        const yes = await confirm({ message: label, default: false });
        answers[key] = yes;
        continue;
      }
      // default: text
      const value = await input({ message: label });
      if (value.trim()) answers[key] = value.trim();
    }
  }
  console.log(badge('Review loop exceeded 5 attempts — stopping.', 'warn'));
  return null;
}

interface AgentPlan {
  summary?: string;
  templateId?: string;
  route?: string;
  riskLevel?: string;
  risk?: string;
  source?: string;
  category?: string;
  actionType?: string;
  templateTitle?: string;
  userNotes?: string;
  fields?: Array<{ label: string; value: string }>;
  safeguards?: string[];
  findings?: string[];
  warnings?: string[];
  parameters?: Record<string, unknown>;
  intent?: string;
  plan?: AgentPlan;
}

function renderPlan(plan: AgentPlan | null): void {
  if (!plan) {
    console.log(badge('AI returned no plan.', 'warn'));
    return;
  }
  const merged: AgentPlan = plan.plan ? { ...plan, ...plan.plan } : plan;
  console.log();
  console.log(header('Plan'));
  const rows: Array<[string, string]> = [];
  if (merged.intent) rows.push(['Intent', merged.intent]);
  if (merged.summary) rows.push(['Summary', merged.summary]);
  if (merged.templateId ?? merged.templateTitle) rows.push(['Template', merged.templateId ?? merged.templateTitle ?? '']);
  if (merged.actionType) rows.push(['Action', merged.actionType]);
  if (merged.route) rows.push(['Route', merged.route]);
  const riskText = merged.riskLevel ?? merged.risk;
  if (riskText) {
    const normalizedRisk = riskText.toLowerCase();
    const colored = normalizedRisk.includes('high')
      ? badge(riskText, 'err')
      : normalizedRisk.includes('medium')
        ? badge(riskText, 'warn')
        : badge(riskText, 'ok');
    rows.push(['Risk', colored]);
  }
  if (merged.parameters && Object.keys(merged.parameters).length > 0) {
    for (const [k, v] of Object.entries(merged.parameters)) {
      rows.push([`· ${k}`, String(v)]);
    }
  }
  console.log(kv(rows));
  if (merged.findings?.length) {
    console.log('\n' + badge('Findings', 'info'));
    for (const f of merged.findings) console.log(`  • ${f}`);
  }
  if (merged.warnings?.length) {
    console.log('\n' + badge('Warnings', 'warn'));
    for (const w of merged.warnings) console.log(`  • ${w}`);
  }
  console.log(divider());
}

async function queuePlan(
  options: GlobalOptions,
  plan: AgentPlan,
  overrideContext?: string | string[],
): Promise<unknown> {
  const merged: AgentPlan = plan.plan ? { ...plan, ...plan.plan } : plan;
  const templateId = merged.templateId ?? '';
  const params = merged.parameters ?? {};
  const baseNote = (params.note ?? merged.summary) as string | undefined;
  const noteWithOverride = composeNote(baseNote, overrideContext);

  // Map the AI's templateId → bridge prepare endpoint.
  // 'send-tokens' is the unified template; legacy 'transfer-sol' / 'transfer-token'
  // template ids are still accepted for older AI responses and persisted drafts.
  const isSendTokens = templateId === 'send-tokens' || templateId === 'transfer_tokens';
  const isLegacySol = templateId === 'transfer-sol' || templateId === 'transfer_sol';
  const isLegacySpl = templateId === 'transfer-token' || templateId === 'transfer_spl';
  if (isSendTokens || isLegacySol || isLegacySpl) {
    const tokenRaw = (params.token as string | undefined) ?? (isLegacySol ? 'SOL' : undefined);
    const token = (tokenRaw || '').trim();
    const isNativeSol = isLegacySol || token.toUpperCase() === 'SOL';
    if (isNativeSol) {
      const body = removeUndefined({
        recipient: params.recipient as string | undefined,
        amountSol: (params.amountSol ?? params.amount) as string | undefined,
        note: noteWithOverride,
      });
      if (!body.recipient || !body.amountSol) {
        console.log(badge('Plan is missing recipient or amount. Use /new-send and copy the values from above.', 'warn'));
        return null;
      }
      return bridgeRequest(options, '/bridge/action/prepare-transfer-sol', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
    const body = removeUndefined({
      token,
      recipient: params.recipient as string | undefined,
      amount: (params.amount ?? params.amountSpl) as string | undefined,
      note: noteWithOverride,
    });
    return bridgeRequest(options, '/bridge/action/prepare-transfer-spl', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  if (templateId === 'swap') {
    const body = removeUndefined({
      amount: params.amount as string | undefined,
      inputToken: params.inputToken as string | undefined,
      outputToken: params.outputToken as string | undefined,
      slippageBps: params.slippageBps as number | undefined,
      note: noteWithOverride,
    });
    return bridgeRequest(options, '/bridge/action/prepare-swap', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  if (templateId.startsWith('protocol-') || templateId.includes('connector') || templateId.includes('_')) {
    // Connector / blink action. Fall back to the generic connector endpoint.
    // `summary` is its own field on this endpoint; the user's free-text `note`
    // (params.note when present) plus any override-context lines flow through
    // composeNote so an override receipt is preserved like the other paths.
    const kind = (merged.route ?? templateId).replace(/^protocol-/, '');
    const connectorBaseNote = params.note as string | undefined;
    const connectorNote = composeNote(connectorBaseNote, overrideContext);
    const { address, cluster } = await fetchWalletAddress(options);
    return bridgeRequest(options, '/bridge/connector/prepare-transaction', {
      method: 'POST',
      body: JSON.stringify(removeUndefined({
        kind,
        params,
        walletAddress: address,
        cluster,
        summary: merged.summary,
        note: connectorNote,
      })),
    });
  }

  console.log(badge(`Don't know how to queue templateId "${templateId}" yet. Use /new-connector to drive it manually.`, 'warn'));
  return null;
}

// Joins a base note with one or more "override-context" pieces (review line,
// override entry) into a single ≤500-char string. The bridge's `note` field
// is hard-capped at 500 chars (see browser-demo main.ts:37957), so when the
// combined string overflows we preserve the override block in full and trim
// the base head with an ellipsis. Losing the user's typed note is acceptable;
// losing the audit/override breadcrumb is not.
export function composeNote(
  baseNote: string | undefined,
  override: string | Array<string | undefined> | undefined,
): string | undefined {
  const NOTE_LIMIT = 500;
  const SEPARATOR = ' | ';

  const base = baseNote?.trim() ?? '';
  const overridePieces = (Array.isArray(override) ? override : [override])
    .map((piece) => piece?.trim() ?? '')
    .filter(Boolean);
  const overridePart = overridePieces.join(SEPARATOR);

  if (!base && !overridePart) return undefined;
  if (!base) return overridePart.slice(0, NOTE_LIMIT);
  if (!overridePart) return base.slice(0, NOTE_LIMIT);

  const combined = `${base}${SEPARATOR}${overridePart}`;
  if (combined.length <= NOTE_LIMIT) return combined;

  // Combined overflows: keep override verbatim, ellipsize the base.
  if (overridePart.length + SEPARATOR.length >= NOTE_LIMIT) {
    return overridePart.slice(0, NOTE_LIMIT);
  }
  const headBudget = NOTE_LIMIT - overridePart.length - SEPARATOR.length;
  const headTrim = base.length > headBudget
    ? `${base.slice(0, Math.max(headBudget - 1, 0))}…`
    : base;
  return `${headTrim}${SEPARATOR}${overridePart}`;
}

// Reads the user's `multiReviewer` preference from /api/preferences/ai-settings
// and returns true when the toggle is on. Silently false when the user isn't
// signed in or the namespace is empty — matches the web's default.
export async function isMultiReviewerEnabled(options: GlobalOptions): Promise<boolean> {
  try {
    const raw = await renderWebRequest<unknown>(options, '/api/preferences/ai-settings', undefined, {
      label: 'Render-web preferences',
      requireAuth: true,
    });
    if (raw && typeof raw === 'object') {
      const payload = (raw as { payload?: unknown }).payload;
      const source = payload && typeof payload === 'object' ? payload : raw;
      const v = (source as Record<string, unknown>).multiReviewer;
      return Boolean(v);
    }
    return false;
  } catch {
    return false;
  }
}
