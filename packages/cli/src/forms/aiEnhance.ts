import { confirm, spinner, header, badge, divider, kv, multilineInput } from '../tui/index.js';
import type { GlobalOptions } from '../shared/types.js';
import { renderPolicyBundle, type PolicyReviewVerdict } from './policyBundleRender.js';
import { isMultiReviewerEnabled } from '../flows/agent.js';
import { generateAgentPlan, resolveAgentAiRoute, reviewAgentPlan } from '../ai/hosted.js';

export interface AiAdvice {
  summary?: string;
  templateId?: string;
  route?: string;
  riskLevel?: string;
  findings?: string[];
  warnings?: string[];
  parameters?: Record<string, unknown>;
}

export interface EnhanceResult {
  advice: AiAdvice | null;
  verdict: PolicyReviewVerdict | null;
}

// Asks "Enhance with AI?" and, if yes, posts a natural-language description of
// the draft to /bridge/ai/generate-plan plus an optional policy NOTE that gets
// resolved into atoms. When a NOTE is provided, also follows up with
// /bridge/ai/review-plan and renders the structured policyBundle verdict.
// Returns { advice, verdict } so callers can gate the queue on DENY or
// hasBlockingFailure outcomes.
export async function maybeEnhanceWithAi(
  options: GlobalOptions,
  naturalDescription: string,
): Promise<EnhanceResult | null> {
  const yes = await confirm({
    message: 'Enhance with AI before saving to inbox?',
    default: false,
  });
  if (!yes) return null;

  console.log(badge('Add policy NOTE? (constraints to enforce, e.g. "Only approve if SOL > $80")', 'muted'));
  const policyNote = await multilineInput({
    message: 'Policy NOTE (blank to skip)',
    default: '',
  });

  const spin = spinner('Thinking…');
  let advice: AiAdvice = {};
  let plan: Record<string, unknown> | null = null;
  const route = await resolveAgentAiRoute(options);
  try {
    plan = (await generateAgentPlan<unknown>(options, route, {
        prompt: naturalDescription,
        userNotes: policyNote.trim() || naturalDescription,
      })) as Record<string, unknown> | null;
    spin.succeed('AI responded.');
    advice = parseAdvice(plan);
    renderAdvice(advice);
  } catch (err) {
    spin.fail(`AI unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { advice: null, verdict: null };
  }

  let verdict: PolicyReviewVerdict | null = null;
  if (policyNote.trim() && plan) {
    const reviewSpin = spinner('Resolving policy atoms…');
    try {
      const multi = await isMultiReviewerEnabled(options);
      const body: Record<string, unknown> = { plan, instruction: policyNote };
      if (multi) body.mode = 'multi';
      const review = await reviewAgentPlan<unknown>(options, route, body);
      reviewSpin.succeed('Policy review complete.');
      verdict = renderPolicyBundle(review as Record<string, unknown>);
    } catch (err) {
      reviewSpin.fail(`Review failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { advice, verdict };
}

function parseAdvice(raw: Record<string, unknown> | null): AiAdvice {
  if (!raw) return {};
  const advice: AiAdvice = {};
  if (typeof raw.summary === 'string') advice.summary = raw.summary;
  if (typeof raw.templateId === 'string') advice.templateId = raw.templateId;
  if (typeof raw.route === 'string') advice.route = raw.route;
  if (typeof raw.riskLevel === 'string') advice.riskLevel = raw.riskLevel;
  const findings = raw.findings;
  if (Array.isArray(findings)) {
    advice.findings = findings.filter((f) => typeof f === 'string') as string[];
  }
  const warnings = raw.warnings;
  if (Array.isArray(warnings)) {
    advice.warnings = warnings.filter((w) => typeof w === 'string') as string[];
  }
  if (raw.parameters && typeof raw.parameters === 'object') {
    advice.parameters = raw.parameters as Record<string, unknown>;
  }
  // Some endpoints return the plan under a `plan` envelope.
  const plan = raw.plan;
  if (plan && typeof plan === 'object') {
    return { ...advice, ...parseAdvice(plan as Record<string, unknown>) };
  }
  return advice;
}

// AI refill: when AI returns adjusted parameters, optionally apply them to the
// user's draft. Shows a diff and confirms before swapping in the new values.
// Returns the resolved draft (either original or AI-merged).
export async function maybeApplyAdvice<T>(
  draft: T,
  advice: AiAdvice | null,
  applyFn: (params: Record<string, unknown>) => Partial<T>,
): Promise<T> {
  if (!advice?.parameters) return draft;
  const partial = applyFn(advice.parameters);
  const draftRecord = draft as unknown as Record<string, unknown>;
  const partialRecord = partial as unknown as Record<string, unknown>;
  const diffRows: Array<[string, string]> = [];
  for (const key of Object.keys(partialRecord)) {
    const aiValue = partialRecord[key];
    if (aiValue === undefined) continue;
    const userValue = draftRecord[key];
    if (userValue === aiValue) continue;
    diffRows.push([key, `${formatVal(userValue)}  →  ${formatVal(aiValue)}`]);
  }
  if (diffRows.length === 0) return draft;

  console.log();
  console.log(header('AI suggests these adjustments'));
  console.log(kv(diffRows));
  console.log(divider());

  const apply = await confirm({
    message: 'Apply AI\'s tweaks?',
    default: true,
  });
  if (!apply) return draft;
  return { ...draft, ...partial } as T;
}

function formatVal(v: unknown): string {
  if (v === undefined || v === null) return badge('(unset)', 'muted');
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 37)}…` : v;
  return String(v);
}

function renderAdvice(advice: AiAdvice): void {
  console.log();
  console.log(header('AI review'));
  const rows: Array<[string, string]> = [];
  if (advice.summary) rows.push(['Summary', advice.summary]);
  if (advice.templateId) rows.push(['Template', advice.templateId]);
  if (advice.route) rows.push(['Route', advice.route]);
  if (advice.riskLevel) {
    const riskBadge = advice.riskLevel === 'high'
      ? badge(advice.riskLevel, 'err')
      : advice.riskLevel === 'medium'
        ? badge(advice.riskLevel, 'warn')
        : badge(advice.riskLevel, 'ok');
    rows.push(['Risk', riskBadge]);
  }
  if (rows.length > 0) console.log(kv(rows));
  if (advice.findings?.length) {
    console.log('\n' + badge('Findings', 'info'));
    for (const f of advice.findings) console.log(`  • ${f}`);
  }
  if (advice.warnings?.length) {
    console.log('\n' + badge('Warnings', 'warn'));
    for (const w of advice.warnings) console.log(`  • ${w}`);
  }
  if (rows.length === 0 && !advice.findings?.length && !advice.warnings?.length) {
    console.log(badge('AI returned no structured advice.', 'muted'));
  }
  console.log(divider());
}
