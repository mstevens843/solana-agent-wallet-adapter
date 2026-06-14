export type AgentReviewSourceLike = 'hosted' | 'session' | 'bridge' | 'device-agent' | 'mock';
export type AgentReviewDisplayPath = AgentReviewSourceLike | 'plan-connector';

export interface AgentReviewDisplayPathInput {
  source?: AgentReviewSourceLike;
  path?: AgentReviewDisplayPath;
  provider?: string;
  model?: string;
  pairedBridge?: boolean;
  bridgeConnector?: boolean;
}

function normalizePathText(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isAgentReviewDisplayPath(value: unknown): value is AgentReviewDisplayPath {
  return value === 'hosted' ||
    value === 'session' ||
    value === 'bridge' ||
    value === 'device-agent' ||
    value === 'mock' ||
    value === 'plan-connector';
}

export function agentReviewLooksLikePlanConnector(input: AgentReviewDisplayPathInput): boolean {
  if (input.path === 'plan-connector' || input.pairedBridge || input.bridgeConnector) return true;
  const provider = normalizePathText(input.provider);
  const model = normalizePathText(input.model);
  const joined = `${provider} ${model}`.trim();
  if (!joined) return false;
  if (provider === 'paired bridge' || model === 'connector' || joined.includes('paired bridge')) return true;
  if (/\bplan connector\b/.test(joined)) return true;
  if (/\b(codex|claude|gemini|antigravity) connector\b/.test(joined)) return true;
  if (
    (input.source === 'device-agent' || input.source === 'bridge') &&
    /\b(chatgpt plan|agent sdk credits|google ai pro ultra|subscription plan|computer plan|codex plan|claude plan|gemini plan|antigravity plan)\b/.test(joined)
  ) {
    return true;
  }
  return false;
}

export function agentReviewDisplayPath(input: AgentReviewDisplayPathInput): AgentReviewDisplayPath | undefined {
  if (agentReviewLooksLikePlanConnector(input)) return 'plan-connector';
  if (input.path && isAgentReviewDisplayPath(input.path)) return input.path;
  return input.source;
}

export function agentReviewDisplayPathLabel(path: AgentReviewDisplayPath | undefined): string {
  switch (path) {
    case 'plan-connector':
      return 'Plan Connector';
    case 'hosted':
      return 'Hosted BYOK';
    case 'bridge':
      return 'Local bridge';
    case 'device-agent':
      return 'Device Agent';
    case 'session':
      return 'Browser session';
    case 'mock':
      return 'Local demo';
    default:
      return 'No agent';
  }
}
