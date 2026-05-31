export const ASK_AGENT_CONVERSATION_ONLY_REASON = 'Ask-agent conversation only. No decision recorded.';

export const INTERRUPTED_AGENT_REVIEW_REASON =
  'The app closed before the agent returned. Ask the agent again to restart the check.';

export const INTERRUPTED_AGENT_ASK_REASON =
  'The app closed before the agent answered. Ask again to restart the conversation.';

export interface RecoverableAgentAskExchange {
  id: string;
  question: string;
  askedAt: string;
  pending?: boolean;
  error?: string;
  answeredAt?: string;
}

export interface RecoverableAgentReviewState {
  status?: string;
  reason?: string;
  checkedAt?: string;
  conversation?: RecoverableAgentAskExchange[];
}

export interface RecoverableGeneratedPlanRecord {
  updatedAt?: string;
  agentReview?: RecoverableAgentReviewState;
}

export interface AgentReviewRecoveryOptions {
  nowIso?: string;
  staleAfterMs?: number;
}

export function recoverInterruptedAgentReviews<T extends RecoverableGeneratedPlanRecord>(
  records: readonly T[],
  options: AgentReviewRecoveryOptions = {},
): { records: T[]; changed: boolean } {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const staleAfterMs = Math.max(0, options.staleAfterMs ?? 0);
  let changed = false;

  const recovered = records.map((record) => {
    const review = record.agentReview;
    if (!review) return record;

    let nextReview = review;
    let reviewChanged = false;
    const pendingConversation = Array.isArray(review.conversation)
      ? review.conversation.filter((entry) => entry.pending === true)
      : [];

    if (
      review.status === 'checking' &&
      shouldRecoverTimestamp(review.checkedAt ?? record.updatedAt, nowMs, staleAfterMs) &&
      !isResolvedAskOnlyReview(review, pendingConversation.length)
    ) {
      nextReview = {
        ...nextReview,
        status: 'error',
        reason: INTERRUPTED_AGENT_REVIEW_REASON,
        checkedAt: nowIso,
      };
      reviewChanged = true;
    }

    if (pendingConversation.length > 0 && Array.isArray(review.conversation)) {
      let conversationChanged = false;
      const conversation = review.conversation.map((entry) => {
        if (entry.pending !== true || !shouldRecoverTimestamp(entry.askedAt, nowMs, staleAfterMs)) {
          return entry;
        }
        conversationChanged = true;
        return {
          ...entry,
          pending: false,
          error: INTERRUPTED_AGENT_ASK_REASON,
          answeredAt: nowIso,
        };
      });
      if (conversationChanged) {
        nextReview = {
          ...nextReview,
          conversation,
          checkedAt: typeof nextReview.checkedAt === 'string' ? nextReview.checkedAt : nowIso,
        };
        reviewChanged = true;
      }
    }

    if (!reviewChanged) return record;
    changed = true;
    return {
      ...record,
      agentReview: nextReview,
      updatedAt: nowIso,
    } as T;
  });

  return { records: recovered, changed };
}

function isResolvedAskOnlyReview(review: RecoverableAgentReviewState, pendingConversationCount: number): boolean {
  return review.status === 'checking' &&
    review.reason === ASK_AGENT_CONVERSATION_ONLY_REASON &&
    Array.isArray(review.conversation) &&
    review.conversation.length > 0 &&
    pendingConversationCount === 0;
}

function shouldRecoverTimestamp(value: string | undefined, nowMs: number, staleAfterMs: number): boolean {
  if (!Number.isFinite(nowMs)) return true;
  if (!value) return true;
  const startedMs = Date.parse(value);
  if (!Number.isFinite(startedMs)) return true;
  return nowMs - startedMs >= staleAfterMs;
}
