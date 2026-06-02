import { BridgeAiPlanner, type AiPlan, type AiReviewRequest, type AiReviewResult } from '@solana-agent-wallet-adapter/mcp-server';
import type { JsonObject } from '@solana-agent-wallet-adapter/workflow';

import type { RecurringService } from './recurringService.js';
import { redactSecrets } from './redaction.js';
import type { AgentBackgroundReviewContext } from './scheduler.js';
import type { WorkflowService } from './workflowService.js';

interface CreateAgentBackgroundWatchOptions {
  workflowService: WorkflowService;
  recurringService: RecurringService;
}

const REVIEW_AGE_THRESHOLD_MS = 30 * 60 * 1000;
const PER_PLAN_THROTTLE_MS = 60 * 60 * 1000;
const PER_TICK_CAP = 4;

interface PlanWithMetadata {
  id: string;
  walletAddress: string;
  plan: AiPlan;
  metadata: Record<string, unknown> | undefined;
  agentReview: Record<string, unknown> | undefined;
}

interface BackgroundReviewResult {
  decision: AiReviewResult['decision'];
  reason: string;
}

export function createAgentBackgroundWatch(
  options: CreateAgentBackgroundWatchOptions,
): ((context: AgentBackgroundReviewContext) => Promise<void>) | undefined {
  const apiKey = process.env.AGENTIC_AI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const provider = process.env.AGENTIC_AI_PROVIDER?.trim() || 'openai';
  const apiFormat = process.env.AGENTIC_AI_API_FORMAT?.trim() || (provider === 'anthropic' || /claude/i.test(provider) ? 'anthropic' : 'openai-compatible');
  const baseUrl = process.env.AGENTIC_AI_BASE_URL?.trim() || '';
  const model = process.env.AGENTIC_AI_MODEL?.trim() || '';

  const planner = new BridgeAiPlanner();
  try {
    planner.setSessionKey({
      apiKey,
      provider,
      apiFormat,
      baseUrl: baseUrl || undefined,
      model: model || undefined,
    });
  } catch (err) {
    process.stderr.write(`[agent-background-watch] failed to initialize: ${redactErrorMessage(err)}\n`);
    return undefined;
  }

  const throttle = new Map<string, number>();

  return async function tick(context: AgentBackgroundReviewContext): Promise<void> {
    try {
      await runBackgroundReviewsForWallet(context.walletAddress, {
        planner,
        workflowService: options.workflowService,
        recurringService: options.recurringService,
        throttle,
        now: Date.parse(context.ranAt) || Date.now(),
      });
    } catch (err) {
      process.stderr.write(`[agent-background-watch] tick failed for ${context.walletAddress}: ${redactErrorMessage(err)}\n`);
    }
  };
}

interface RunOptions {
  planner: BridgeAiPlanner;
  workflowService: WorkflowService;
  recurringService: RecurringService;
  throttle: Map<string, number>;
  now: number;
}

async function runBackgroundReviewsForWallet(walletAddress: string, options: RunOptions): Promise<void> {
  const candidates = await collectEligiblePlans(walletAddress, options);
  if (!candidates.length) return;
  let processed = 0;
  for (const candidate of candidates) {
    if (processed >= PER_TICK_CAP) break;
    const lastChecked = options.throttle.get(candidate.id) ?? 0;
    if (options.now - lastChecked < PER_PLAN_THROTTLE_MS) continue;
    options.throttle.set(candidate.id, options.now);
    processed += 1;
    try {
      const reviewRequest: AiReviewRequest = {
        plan: candidate.plan,
        instruction: 'Background re-check before this draft becomes due. Decide approve, deny, or needs_input.',
        walletAddress: candidate.walletAddress,
        context: {
          backgroundCheck: true,
          previousAgentReview: candidate.agentReview ?? null,
        },
      };
      const result = await options.planner.reviewPlan(reviewRequest);
      const changed = decisionChanged(candidate.agentReview, result);
      if (!changed) continue;
      await persistUpdatedReview(walletAddress, candidate, result, options);
    } catch (err) {
      process.stderr.write(`[agent-background-watch] review failed for ${candidate.id}: ${redactErrorMessage(err)}\n`);
    }
  }
}

async function collectEligiblePlans(
  walletAddress: string,
  options: RunOptions,
): Promise<PlanWithMetadata[]> {
  const session = { walletAddress, sessionId: `background:${walletAddress}` };
  const candidates: PlanWithMetadata[] = [];
  try {
    const plans = await options.workflowService.listPlans(session);
    for (const planRecord of plans) {
      if (planRecord.status !== 'draft' && planRecord.status !== 'queued') continue;
      const metadata = isJsonRecord(planRecord.metadata) ? planRecord.metadata : undefined;
      const agentReview = metadata && isJsonRecord(metadata.agentReview) ? metadata.agentReview : undefined;
      if (!agentReview || !planRecord.plan) continue;
      const checkedAt = typeof agentReview.checkedAt === 'string' ? Date.parse(agentReview.checkedAt) : NaN;
      if (!Number.isFinite(checkedAt)) continue;
      if (options.now - checkedAt < REVIEW_AGE_THRESHOLD_MS) continue;
      const aiPlan = planRecordToAiPlan(planRecord.plan);
      if (!aiPlan) continue;
      candidates.push({
        id: planRecord.id,
        walletAddress,
        plan: aiPlan,
        metadata,
        agentReview,
      });
    }
  } catch {
    return [];
  }
  return candidates;
}

async function persistUpdatedReview(
  walletAddress: string,
  candidate: PlanWithMetadata,
  result: AiReviewResult,
  options: RunOptions,
): Promise<void> {
  try {
    const session = { walletAddress, sessionId: `background:${walletAddress}` };
    const nextMetadata = {
      ...(candidate.metadata ?? {}),
      agentReview: {
        ...(candidate.agentReview ?? {}),
        status: result.decision === 'approve' ? 'approved' : result.decision === 'needs_input' ? 'needs_input' : 'denied',
        decision: result.decision,
        reason: result.reason,
        summary: result.summary,
        checkedAt: result.checkedAt,
        evidence: result.evidence,
        ...(result.questions?.length ? { questions: result.questions } : {}),
        ...(result.reviewers?.length ? { reviewers: result.reviewers } : {}),
        backgroundCheck: true,
        source: 'background_watch',
        effect: 'review_context_only',
        approvalBoundary: 'review_context_only',
      },
    };
    await options.workflowService.updatePlan(session, candidate.id, { metadata: nextMetadata as unknown as JsonObject });
  } catch (err) {
    process.stderr.write(`[agent-background-watch] persist failed for ${candidate.id}: ${redactErrorMessage(err)}\n`);
  }
}

function decisionChanged(prevReview: Record<string, unknown> | undefined, next: BackgroundReviewResult): boolean {
  if (!prevReview) return true;
  if (typeof prevReview.decision === 'string' && prevReview.decision !== next.decision) return true;
  if (typeof prevReview.reason === 'string' && prevReview.reason !== next.reason) return true;
  return false;
}

function planRecordToAiPlan(plan: unknown): AiPlan | undefined {
  if (!isJsonRecord(plan)) return undefined;
  const required: Array<keyof AiPlan> = ['intent', 'route', 'risk', 'approval', 'source', 'category', 'actionType', 'templateTitle'];
  for (const key of required) {
    if (typeof plan[key] !== 'string') return undefined;
  }
  if (!plan.parameters || typeof plan.parameters !== 'object' || Array.isArray(plan.parameters)) return undefined;
  if (!Array.isArray(plan.fields)) return undefined;
  if (!Array.isArray(plan.safeguards)) return undefined;
  return plan as unknown as AiPlan;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactSecrets(message);
}
