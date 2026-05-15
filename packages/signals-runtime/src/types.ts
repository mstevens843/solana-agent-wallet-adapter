import type { JsonObject } from '@solana-agent-wallet-adapter/workflow';
import type * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';

export type SignalFeedRecord = DevLayer1.signals.SignalFeedRecord;
export type SignalFeedStatus = DevLayer1.signals.SignalFeedStatus;
export type SignalEmissionRecord = DevLayer1.signals.SignalEmissionRecord;
export type SignalSubscriptionRecord = DevLayer1.signals.SignalSubscriptionRecord;
export type SignalSubscriptionStatus = DevLayer1.signals.SignalSubscriptionStatus;
export type CreateSignalSubscriptionRequest = DevLayer1.signals.CreateSignalSubscriptionRequest;
export type CreateSignalEmissionRequest = DevLayer1.signals.CreateSignalEmissionRequest;

export type SkipReason =
  | 'subscription_paused'
  | 'subscription_revoked'
  | 'subscription_expired'
  | 'lifetime_cap_exhausted'
  | 'max_executions_reached'
  | 'token_not_allowed'
  | 'recipient_not_allowed'
  | 'missing_amount';

export interface SignalSubscriptionUsage {
  executionCount: number;
  lifetimeAmount: string;
}

export interface FanoutDecision {
  subscription: SignalSubscriptionRecord;
  verdict: 'deliver' | 'skip';
  reason?: SkipReason;
  clampedAmount?: string;
  clampedActionTemplate?: JsonObject;
}

export interface FanoutPlan {
  emissionId: string;
  feedId: string;
  decisions: FanoutDecision[];
}
