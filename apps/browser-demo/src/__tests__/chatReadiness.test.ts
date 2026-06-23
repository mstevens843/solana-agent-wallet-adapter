import { describe, expect, it } from 'vitest';

import {
  CHAT_AI_CONNECTOR_REQUIRED,
  CHAT_HOSTED_BYOK_RELAY_REQUIRED,
  chatAiConnectorConfigured,
  chatHostedRelayReadinessError,
} from '../chatReadiness.js';

describe('chat readiness copy', () => {
  it('prioritizes AI setup over Hosted BYOK cloud relay sign-in', () => {
    expect(chatHostedRelayReadinessError({
      mode: 'hosted',
      apiKeyConfigured: false,
      hostedRelayAvailable: false,
    })).toBe(CHAT_AI_CONNECTOR_REQUIRED);
  });

  it('asks for AI setup when Device Agent has no key and no Plan Connector', () => {
    expect(chatHostedRelayReadinessError({
      mode: 'device-agent',
      apiKeyConfigured: false,
      deviceAgentConfigured: false,
      pairedPlanConnector: false,
      hostedRelayAvailable: false,
    })).toBe(CHAT_AI_CONNECTOR_REQUIRED);
  });

  it('surfaces Hosted BYOK relay auth only after an AI key exists', () => {
    expect(chatHostedRelayReadinessError({
      mode: 'hosted',
      apiKeyConfigured: true,
      hostedRelayAvailable: false,
    })).toBe(CHAT_HOSTED_BYOK_RELAY_REQUIRED);
  });

  it('treats paired Plan Connector as an AI connector', () => {
    expect(chatAiConnectorConfigured({
      mode: 'device-agent',
      apiKeyConfigured: false,
      pairedPlanConnector: true,
    })).toBe(true);
  });

  it('does not gate local bridge or paired Plan Connector on cloud relay sign-in', () => {
    expect(chatHostedRelayReadinessError({
      mode: 'bridge',
      apiKeyConfigured: false,
      hostedRelayAvailable: false,
    })).toBeNull();
    expect(chatHostedRelayReadinessError({
      mode: 'device-agent',
      apiKeyConfigured: false,
      pairedPlanConnector: true,
      hostedRelayAvailable: false,
    })).toBeNull();
  });
});
