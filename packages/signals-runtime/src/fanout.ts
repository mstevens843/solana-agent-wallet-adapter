import {
  clampToSubscriptionCaps,
  compareDecimalStrings,
  evaluateSubscription,
  extractTemplateAmount,
  extractTemplateRecipient,
  extractTemplateToken,
  isRecipientAllowed,
  isTokenAllowed,
  overrideTemplateAmount,
} from './subscription.js';
import type {
  FanoutDecision,
  FanoutPlan,
  SignalEmissionRecord,
  SignalSubscriptionUsage,
  SignalSubscriptionRecord,
} from './types.js';

export interface PlanFanoutInput {
  emission: SignalEmissionRecord;
  subscriptions: SignalSubscriptionRecord[];
  nowIso: string;
  subscriptionUsage?: ReadonlyMap<string, SignalSubscriptionUsage> | Record<string, SignalSubscriptionUsage>;
}

export function planFanout(input: PlanFanoutInput): FanoutPlan {
  const sortedSubscriptions = [...input.subscriptions].sort((a, b) => a.id.localeCompare(b.id));
  const decisions = sortedSubscriptions.map((subscription) =>
    decideForSubscription(
      input.emission,
      subscription,
      input.nowIso,
      usageForSubscription(input.subscriptionUsage, subscription.id),
    ),
  );
  return {
    emissionId: input.emission.id,
    feedId: input.emission.feedId,
    decisions,
  };
}

function decideForSubscription(
  emission: SignalEmissionRecord,
  subscription: SignalSubscriptionRecord,
  nowIso: string,
  usage: SignalSubscriptionUsage | undefined,
): FanoutDecision {
  const verdict = evaluateSubscription(subscription, nowIso, usage);
  if (verdict.kind === 'skip') {
    return { subscription, verdict: 'skip', reason: verdict.reason };
  }
  const token = extractTemplateToken(emission.actionTemplate);
  if (!isTokenAllowed(token, subscription.caps.allowlistedTokens)) {
    return { subscription, verdict: 'skip', reason: 'token_not_allowed' };
  }
  const recipient = extractTemplateRecipient(emission.actionTemplate);
  if (!isRecipientAllowed(recipient, subscription.caps.allowlistedRecipients)) {
    return { subscription, verdict: 'skip', reason: 'recipient_not_allowed' };
  }
  const publisherAmount = extractTemplateAmount(emission.actionTemplate);
  if (!publisherAmount) {
    return { subscription, verdict: 'skip', reason: 'missing_amount' };
  }
  let clampedAmount: string;
  try {
    clampedAmount = clampToSubscriptionCaps(publisherAmount, subscription, usage);
  } catch {
    return { subscription, verdict: 'skip', reason: 'missing_amount' };
  }
  // Zero or negative perRunMax means the subscription cannot copy anything.
  if (compareDecimalStrings(clampedAmount, '0') <= 0) {
    return { subscription, verdict: 'skip', reason: 'missing_amount' };
  }
  const { template: clampedActionTemplate } = overrideTemplateAmount(
    emission.actionTemplate,
    clampedAmount,
  );
  return {
    subscription,
    verdict: 'deliver',
    clampedAmount,
    clampedActionTemplate,
  };
}

function usageForSubscription(
  usage: PlanFanoutInput['subscriptionUsage'],
  subscriptionId: string,
): SignalSubscriptionUsage | undefined {
  if (!usage) return undefined;
  if (isUsageMap(usage)) return usage.get(subscriptionId);
  return usage[subscriptionId];
}

function isUsageMap(
  usage: NonNullable<PlanFanoutInput['subscriptionUsage']>,
): usage is ReadonlyMap<string, SignalSubscriptionUsage> {
  return typeof (usage as ReadonlyMap<string, SignalSubscriptionUsage>).get === 'function';
}
