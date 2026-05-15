export type {
  CreateSignalEmissionRequest,
  CreateSignalSubscriptionRequest,
  FanoutDecision,
  FanoutPlan,
  SignalEmissionRecord,
  SignalFeedRecord,
  SignalFeedStatus,
  SignalSubscriptionRecord,
  SignalSubscriptionStatus,
  SignalSubscriptionUsage,
  SkipReason,
} from './types.js';

export { planFanout, type PlanFanoutInput } from './fanout.js';
export {
  clampAmount,
  clampToSubscriptionCaps,
  compareDecimalStrings,
  evaluateSubscription,
  extractTemplateAmount,
  extractTemplateRecipient,
  extractTemplateToken,
  isRecipientAllowed,
  isTokenAllowed,
  overrideTemplateAmount,
  addDecimalStrings,
  subtractDecimalStrings,
  type SubscriptionVerdict,
} from './subscription.js';
