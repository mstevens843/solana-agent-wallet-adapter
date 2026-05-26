import type { AgentPlan } from '@solana-agent-wallet-adapter/workflow';

import { confirm, spinner, badge, multilineInput, select, input } from '../tui/index.js';
import type { GlobalOptions } from '../shared/types.js';
import { reviewAgentPlan, resolveAgentAiRoute, type AgentAiRoute } from '../ai/hosted.js';
import { isMultiReviewerEnabled } from '../flows/agent.js';
import { renderAgentReview, reviewSummaryLine, type AgentReviewResponse } from './agentReviewRender.js';

export type AgentReviewChoice = 'send' | 'save' | 'delete';

export interface AgentReviewOutcome {
  // Whether the agent was actually consulted. When false (route not configured
  // or user said no to "Draft with AI?"), the caller continues with the
  // existing flow as if the AI step never existed.
  reviewed: boolean;
  choice: AgentReviewChoice;
  // 1-line audit string suitable for the prepared action `note` field.
  // Present only when `reviewed === true`.
  reviewSummary?: string;
  // 'approve' | 'deny' | 'needs_input' from the final review. Present only
  // when `reviewed === true`. Callers use this to decide whether to record an
  // override note when the user picks Send for approval despite a deny.
  decision?: string;
}

// Asks "Draft with AI? (y/N)" after the user has built and confirmed their
// draft. If the user opts in, prompts for a free-text instruction, runs the
// review against the existing draft (NOT a generated plan — the user already
// drafted it), renders the verdict + sectioned findings, and offers the
// post-verdict next-step picker.
//
// Critical: the plan is built with source: 'template'. That distinction
// matters because the post-LLM bypass-claim regex in
// packages/workflow/src/index.ts is only enforced when source === 'ai'; using
// 'template' (the user drafted it) means the regex never runs, eliminating
// the "AI drafts cannot bypass wallet approval or signing." false positive
// that fired for /new swap before this change.
export async function maybeReviewWithAgent(
  options: GlobalOptions,
  plan: AgentPlan,
): Promise<AgentReviewOutcome> {
  const route = await resolveAgentAiRoute(options);
  if (route.kind === 'none') {
    // No agent configured — skip the whole step. Don't mention the agent.
    return { reviewed: false, choice: 'send' };
  }

  const draftWithAi = await confirm({
    message: 'Draft with AI? (y/N)',
    default: false,
  });
  if (!draftWithAi) return { reviewed: false, choice: 'send' };

  return reviewLoop(options, route, plan);
}

async function reviewLoop(
  options: GlobalOptions,
  route: AgentAiRoute,
  plan: AgentPlan,
): Promise<AgentReviewOutcome> {
  let instruction = '';
  let lastResponse: AgentReviewResponse | null = null;
  let lastError: string | null = null;
  let answers: Record<string, unknown> = {};

  // First turn: prompt for the instruction.
  instruction = await promptInstruction('Anything to ask or check? (ex: Only approve if sol is above $70 and f&g above 20)');

  while (true) {
    const spin = spinner(instruction.trim() ? 'Agent thinking…' : 'Agent reviewing…');
    const multi = await isMultiReviewerEnabled(options).catch(() => false);
    try {
      const body: Record<string, unknown> = { plan, instruction };
      if (multi) body.mode = 'multi';
      if (Object.keys(answers).length > 0) body.context = { answers };
      lastResponse = await reviewAgentPlan<AgentReviewResponse>(options, route, body);
      spin.succeed('Review complete.');
      lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spin.fail(`Agent review failed: ${message}`);
      lastError = message;
      lastResponse = null;
    }

    if (lastResponse) {
      renderAgentReview(lastResponse);
    }

    // Q&A loop: when the agent asked clarifying questions and the user hasn't
    // already answered them, gather answers and re-run instead of forcing the
    // user to type a new instruction. Mirrors flows/agent.ts:runReviewLoop.
    const needsInputQuestions = lastResponse?.decision === 'needs_input'
      ? Array.isArray(lastResponse.questions) ? lastResponse.questions : []
      : [];
    if (needsInputQuestions.length > 0) {
      console.log();
      console.log(badge('Agent needs more information to decide.', 'warn'));
      answers = await gatherAnswers(needsInputQuestions);
      continue;
    }

    const choice = await pickNextStep(lastResponse, lastError);
    if (choice === 'ask_again') {
      instruction = await promptInstruction('Anything else to ask or change? (blank to re-run as-is)');
      // New instruction is its own conversation — drop previous answers.
      answers = {};
      continue;
    }

    const outcome: AgentReviewOutcome = {
      reviewed: true,
      choice,
    };
    if (lastResponse) {
      outcome.reviewSummary = reviewSummaryLine(lastResponse);
      outcome.decision = (lastResponse.decision ?? '').toLowerCase();
    }
    return outcome;
  }
}

async function promptInstruction(message: string): Promise<string> {
  const raw = await multilineInput({
    message,
    default: '',
  });
  return raw.trim();
}

type NextStep = AgentReviewChoice | 'ask_again';

async function pickNextStep(
  response: AgentReviewResponse | null,
  lastError: string | null,
): Promise<NextStep> {
  const decision = (response?.decision ?? '').toLowerCase();
  const sendLabel = decision === 'deny'
    ? 'Send for approval anyway (overrides agent denial)'
    : decision === 'needs_input'
      ? 'Send for approval anyway (overrides agent needs-input)'
      : 'Send for approval now';

  const choices: Array<{ name: string; value: NextStep; description?: string }> = [
    { name: sendLabel, value: 'send', description: 'Goes to your wallet for signing now.' },
  ];

  // Don't offer "Ask agent again" when the review path itself failed — no
  // point letting the user iterate against a broken connection.
  if (!lastError) {
    choices.push({
      name: 'Ask agent again',
      value: 'ask_again',
      description: 'Re-run the review with a different question or constraint.',
    });
  }

  choices.push(
    { name: 'Save to inbox without sending', value: 'save', description: 'Queues the prepared action; sign later via /inbox.' },
    { name: 'Delete (discard this draft)', value: 'delete', description: 'Drops the draft. Nothing is queued or sent.' },
  );

  const defaultChoice: NextStep = decision === 'approve' ? 'send' : 'save';

  return select<NextStep>({
    message: 'What next?',
    choices,
    default: defaultChoice,
  });
}

async function gatherAnswers(
  questions: NonNullable<AgentReviewResponse['questions']>,
): Promise<Record<string, unknown>> {
  const answers: Record<string, unknown> = {};
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i]!;
    const key = q.id?.trim() || q.label?.trim() || `q${i + 1}`;
    const label = (q.prompt ?? q.label ?? `Question ${key}`).trim();
    const options = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0) : [];

    if (options.length > 0) {
      const picked = await select<string>({
        message: label,
        choices: options.map((o) => ({ name: o, value: o })),
      });
      answers[key] = picked;
      continue;
    }

    const value = await input({ message: label });
    if (value.trim()) answers[key] = value.trim();
  }
  return answers;
}

// Helper for callers that want to inject the review summary into the
// prepared-action `note` field. Mirrors the composeNote helper in
// flows/agent.ts (same 500-char budget), but tailored for the simpler
// /new flows where there's no policy NOTE separate from the AI instruction.
export function composeNoteWithReview(
  baseNote: string | undefined,
  reviewSummary: string | undefined,
  override: string | undefined,
): string | undefined {
  const NOTE_LIMIT = 500;
  const SEPARATOR = ' | ';
  const parts = [baseNote?.trim(), reviewSummary?.trim(), override?.trim()].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return undefined;
  const combined = parts.join(SEPARATOR);
  if (combined.length <= NOTE_LIMIT) return combined;
  // Overflow: keep the override + review summary verbatim, trim the base.
  const tail = [reviewSummary?.trim(), override?.trim()].filter(Boolean).join(SEPARATOR);
  if (!baseNote?.trim()) return tail.slice(0, NOTE_LIMIT);
  if (tail.length + SEPARATOR.length >= NOTE_LIMIT) return tail.slice(0, NOTE_LIMIT);
  const headBudget = NOTE_LIMIT - tail.length - SEPARATOR.length;
  const head = baseNote.trim().length > headBudget
    ? `${baseNote.trim().slice(0, Math.max(headBudget - 1, 0))}…`
    : baseNote.trim();
  return `${head}${SEPARATOR}${tail}`;
}
