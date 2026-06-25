import type { AiSettings } from './planner.js';

export type ChatAiMode = AiSettings['mode'];

export const CHAT_AI_CONNECTOR_REQUIRED =
  'Connect AI first to use chat. Add an AI connector key or connect Plan Connector in Preferences → AI connector.';

export const CHAT_HOSTED_BYOK_RELAY_REQUIRED =
  'Hosted BYOK needs Agentic Cloud relay sign-in, or switch to Device Agent / Plan Connector. Chat history still saves locally.';

export function chatAiConnectorConfigured(input: {
  mode: ChatAiMode;
  apiKeyConfigured: boolean;
  deviceAgentConfigured?: boolean;
  pairedPlanConnector?: boolean;
}): boolean {
  if (input.mode === 'device-agent') {
    return Boolean(input.pairedPlanConnector || input.deviceAgentConfigured || input.apiKeyConfigured);
  }
  if (input.mode === 'bridge') return true;
  return input.apiKeyConfigured;
}

export function chatHostedRelayReadinessError(input: {
  mode: ChatAiMode;
  apiKeyConfigured: boolean;
  deviceAgentConfigured?: boolean;
  pairedPlanConnector?: boolean;
  hostedRelayAvailable: boolean;
}): string | null {
  if (!chatAiConnectorConfigured(input)) return CHAT_AI_CONNECTOR_REQUIRED;
  // Local bridge, paired Plan Connector, and a configured standalone Device Agent all
  // run the AI without the Cloud relay — none of them needs a hosted sign-in.
  if (
    input.mode === 'bridge'
    || input.pairedPlanConnector
    || (input.mode === 'device-agent' && Boolean(input.deviceAgentConfigured))
  ) return null;
  if (!input.hostedRelayAvailable) return CHAT_HOSTED_BYOK_RELAY_REQUIRED;
  return null;
}
