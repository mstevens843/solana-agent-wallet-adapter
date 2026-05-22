import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest, renderWebRequest } from '../http/index.js';
import { input, confirm, select, spinner, header, kv, badge, divider, multilineInput } from '../tui/index.js';
import { loadSession, sessionStatusSummary } from '../auth/sessionStore.js';
import { removeUndefined, printQueuedAction, fetchWalletAddress } from './_shared.js';
import { renderPolicyBundle, verdictBlocksQueue, type ReviewResponse, type PolicyReviewVerdict } from '../forms/policyBundleRender.js';
import { friendlyBridgeError } from './_shared.js';

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

// `/agent` — the AI front door. Sign-in → free-text intent → optional policy
// NOTE → bridge AI thinks → review-plan with atom resolution → 4-choice
// picker (sign proof · queue · both · done). Bridge default, device-agent
// honored via prefs.
export async function runAgent(options: GlobalOptions, signPlanFn?: SignPlanFn): Promise<void> {
  console.log(header('Agent — natural language to wallet plan'));

  const session = await loadSession(options).catch(() => null);
  const auth = sessionStatusSummary(session);
  if (!auth.authenticated) {
    console.log(badge('You are not signed in. AI plans work without cloud sign-in, but cross-device sync is disabled.', 'muted'));
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

  const aiMode = await resolveAiMode(options);
  console.log(badge(`AI route: ${aiMode}`, 'muted'));

  const spin = spinner('Thinking…');
  let plan: AgentPlan | null = null;
  try {
    plan = (await bridgeRequest<AgentPlan>(options, '/bridge/ai/generate-plan', {
      method: 'POST',
      body: JSON.stringify(removeUndefined({
        prompt,
        userNotes: policyNote.trim() ? policyNote : prompt,
        mode: aiMode,
      })),
    })) ?? null;
    spin.succeed('AI returned a plan.');
  } catch (err) {
    const friendly = friendlyBridgeError(err, options);
    spin.fail(friendly ?? `AI failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  renderPlan(plan);
  LAST_PLAN = plan;

  if (!plan) return;

  let verdict: PolicyReviewVerdict | null = null;
  if (policyNote.trim()) {
    verdict = await runReviewLoop(options, plan, policyNote);
  }

  const blocked = verdictBlocksQueue(verdict);
  if (blocked) {
    console.log();
    console.log(badge('Plan was denied by policy review — queue is disabled.', 'err'));
    console.log(badge('You can still sign the plan as off-chain proof if you want a record.', 'muted'));
  }

  type AgentAction = 'proof' | 'queue' | 'both' | 'done';
  const choices: Array<{ name: string; value: AgentAction; description?: string }> = [];
  choices.push({
    name: 'Sign as off-chain proof (no transaction sent)',
    value: 'proof',
    description: 'Saves a wallet-signed evidence record to /proof-list. Useful for audit / accountability.',
  });
  if (!blocked) {
    choices.push({ name: 'Queue as a prepared approval (sends to /inbox)', value: 'queue', description: 'Prepared action awaits your wallet signature in the inbox.' });
    choices.push({ name: 'Both — sign the off-chain proof first, then queue the prepared approval', value: 'both' });
  }
  choices.push({ name: 'Done — keep the plan locally',                    value: 'done', description: 'Use /ask <question> to drill in, or /agent to refine.' });

  const action = await select<AgentAction>({
    message: 'What next?',
    choices,
    default: blocked ? 'proof' : 'queue',
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
    const result = await queuePlan(options, plan);
    if (result) printQueuedAction(plan.summary ?? 'Agent plan', result);
  }
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
    const raw = await bridgeRequest<Record<string, unknown>>(options, '/bridge/ai/ask-about-plan', {
      method: 'POST',
      body: JSON.stringify({ plan: LAST_PLAN, question: q }),
    });
    spin.succeed('Answer received.');
    renderAnswer(raw);
  } catch (err) {
    const friendly = friendlyBridgeError(err, options);
    spin.fail(friendly ?? `Ask failed: ${err instanceof Error ? err.message : String(err)}`);
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
async function runReviewLoop(options: GlobalOptions, plan: AgentPlan, instruction: string): Promise<PolicyReviewVerdict | null> {
  const answers: Record<string, unknown> = {};
  const multi = await isMultiReviewerEnabled(options);
  if (multi) console.log(badge('Multi-reviewer mode is on (preferences → AI Drafting).', 'muted'));
  let attempt = 0;
  while (attempt < 5) {
    attempt += 1;
    const spin = spinner(attempt === 1 ? 'Resolving policy atoms…' : 'Re-reviewing with your answers…');
    let response: ReviewResponse | null = null;
    try {
      response = await bridgeRequest<ReviewResponse>(options, '/bridge/ai/review-plan', {
        method: 'POST',
        body: JSON.stringify(removeUndefined({
          plan,
          instruction,
          mode: multi ? 'multi' : undefined,
          context: Object.keys(answers).length > 0 ? { answers } : undefined,
        })),
      });
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
  if (merged.templateId) rows.push(['Template', merged.templateId]);
  if (merged.route) rows.push(['Route', merged.route]);
  if (merged.riskLevel) {
    const colored = merged.riskLevel === 'high'
      ? badge(merged.riskLevel, 'err')
      : merged.riskLevel === 'medium'
        ? badge(merged.riskLevel, 'warn')
        : badge(merged.riskLevel, 'ok');
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

async function queuePlan(options: GlobalOptions, plan: AgentPlan): Promise<unknown> {
  const merged: AgentPlan = plan.plan ? { ...plan, ...plan.plan } : plan;
  const templateId = merged.templateId ?? '';
  const params = merged.parameters ?? {};

  // Map the AI's templateId → bridge prepare endpoint.
  if (templateId === 'transfer-sol' || templateId === 'transfer_sol') {
    const body = removeUndefined({
      recipient: params.recipient as string | undefined,
      amountSol: (params.amountSol ?? params.amount) as string | undefined,
      note: (params.note ?? merged.summary) as string | undefined,
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

  if (templateId === 'transfer-token' || templateId === 'transfer_spl') {
    const body = removeUndefined({
      token: params.token as string | undefined,
      recipient: params.recipient as string | undefined,
      amount: (params.amount ?? params.amountSpl) as string | undefined,
      note: (params.note ?? merged.summary) as string | undefined,
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
      note: (params.note ?? merged.summary) as string | undefined,
    });
    return bridgeRequest(options, '/bridge/action/prepare-swap', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  if (templateId.startsWith('protocol-') || templateId.includes('connector') || templateId.includes('_')) {
    // Connector / blink action. Fall back to the generic connector endpoint.
    const kind = (merged.route ?? templateId).replace(/^protocol-/, '');
    const { address, cluster } = await fetchWalletAddress(options);
    return bridgeRequest(options, '/bridge/connector/prepare-transaction', {
      method: 'POST',
      body: JSON.stringify(removeUndefined({
        kind,
        params,
        walletAddress: address,
        cluster,
        summary: merged.summary,
      })),
    });
  }

  console.log(badge(`Don't know how to queue templateId "${templateId}" yet. Use /new-connector to drive it manually.`, 'warn'));
  return null;
}

async function resolveAiMode(options: GlobalOptions): Promise<string> {
  try {
    const status = await bridgeRequest<{ mode?: string }>(options, '/bridge/ai/status');
    return status.mode ?? 'bridge';
  } catch {
    return 'bridge';
  }
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

