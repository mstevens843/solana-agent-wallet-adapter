import type { JsonObject, JsonValue, WorkflowCluster } from '@solana-agent-wallet-adapter/workflow';
import type * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';

export type SkillManifest = DevLayer1.skills.SkillManifest;
export type SkillInstallRecord = DevLayer1.skills.SkillInstallRecord;
export type SkillExecutionRecord = DevLayer1.skills.SkillExecutionRecord;
export type SkillCaps = DevLayer1.skills.SkillCaps;
export type SkillSchedule = DevLayer1.skills.SkillSchedule;
export type SkillScheduleKind = DevLayer1.skills.SkillScheduleKind;
export type SkillCategory = DevLayer1.skills.SkillCategory;
export type SkillInstallStatus = DevLayer1.skills.SkillInstallStatus;
export type SkillActionTemplate = DevLayer1.skills.SkillActionTemplate;

export type { JsonObject, JsonValue, WorkflowCluster };

export type PriceLookup = (
  feedSymbol: string,
  cluster: WorkflowCluster,
) => Promise<number>;

export interface SchedulerInput {
  install: SkillInstallRecord;
  manifest: SkillManifest;
  lastExecutionAtIso: string | undefined;
  executionCount: number;
  now: Date;
  priceLookup?: PriceLookup;
  cluster: WorkflowCluster;
}

export type SchedulerDecision =
  | { due: true; reason: string }
  | { due: false; reason: string; nextDueAtIso?: string };

export interface EvaluatorInput {
  install: SkillInstallRecord;
  manifest: SkillManifest;
  executionCount: number;
  totalExecutedAmount: string;
  now: Date;
  params?: JsonObject;
}

export type EvaluatorDecision =
  | { allowed: true }
  | { allowed: false; reason: EvaluatorSkipReason };

export type EvaluatorSkipReason =
  | 'not-active'
  | 'expired'
  | 'max-executions-reached'
  | 'lifetime-cap-reached'
  | 'per-run-cap-exceeded'
  | 'amount-missing'
  | 'amount-invalid'
  | 'amount-ambiguous'
  | 'token-not-allowlisted'
  | 'recipient-not-allowlisted';

export interface SandboxBindInput {
  install: SkillInstallRecord;
  manifest: SkillManifest;
  executionCount: number;
  nowIso: string;
}

export interface SandboxResult {
  params: JsonObject;
}

export interface BuildApprovalInput {
  install: SkillInstallRecord;
  manifest: SkillManifest;
  boundParams: JsonObject;
  cluster: WorkflowCluster;
  nowIso: string;
}

export interface BuildApprovalResult {
  kind: string;
  summary: string;
  params: JsonObject;
  metadata: JsonObject;
  cluster: WorkflowCluster;
}
