import { describe, expect, it } from 'vitest';

import {
  DeviceAgentClientError,
  deviceAgentDiagnosticCode,
  deviceAgentDiagnosticsFromError,
} from '../deviceAgentClient.js';
import { AiPlanConnectionError, aiDiagnosticsFromError } from '../planner.js';

const context = {
  action: 'generate-plan',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
};

describe('deviceAgentDiagnosticCode', () => {
  it.each([
    ['provider_auth', 'AI_PROVIDER_ERROR'],
    ['provider_invalid_response', 'AI_PROVIDER_ERROR'],
    ['payload_too_large', 'AI_PROVIDER_ERROR'],
    ['invalid_payload', 'AI_PROVIDER_ERROR'],
    ['unknown_failure_xyz', 'AI_PROVIDER_ERROR'],
    ['request_timeout', 'AI_HTTP'],
    ['provider_timeout', 'AI_HTTP'],
    ['provider_rate_limited', 'AI_HTTP'],
    ['bridge_unavailable', 'AI_ROUTE_MISMATCH'],
    ['agent_not_implemented', 'AI_ROUTE_MISMATCH'],
    ['device_agent_unavailable', 'AI_ROUTE_MISMATCH'],
    ['INVALID_REQUEST', 'AI_ROUTE_MISMATCH'],
    ['UNSUPPORTED_METHOD', 'AI_ROUTE_MISMATCH'],
    ['unsupported_method', 'AI_ROUTE_MISMATCH'],
  ])('maps %s to %s', (code, expected) => {
    expect(deviceAgentDiagnosticCode(code)).toBe(expected);
  });
});

describe('deviceAgentDiagnosticsFromError', () => {
  it('builds a route entry plus a provider-error entry for DeviceAgentClientError', () => {
    const err = new DeviceAgentClientError('provider_auth', 'Bad key.');
    const diagnostics = deviceAgentDiagnosticsFromError(err, context);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      code: 'AI_ROUTE',
      method: 'POST',
      path: '/api/device-agent/generate-plan',
    });
    expect(diagnostics[1]).toMatchObject({
      code: 'AI_PROVIDER_ERROR',
      method: 'POST',
      path: '/api/device-agent/generate-plan',
    });
    expect(diagnostics[1]?.message).toContain('provider_auth');
    expect(diagnostics[1]?.detail).toContain('Bad key.');
    expect(diagnostics[1]?.detail).toContain('anthropic');
  });

  it('routes timeout codes to AI_HTTP', () => {
    const err = new DeviceAgentClientError('request_timeout', 'timed out');
    const diagnostics = deviceAgentDiagnosticsFromError(err, context);
    expect(diagnostics[1]?.code).toBe('AI_HTTP');
  });

  it('routes bridge_unavailable to AI_ROUTE_MISMATCH so the runtime mismatch is visible', () => {
    const err = new DeviceAgentClientError('bridge_unavailable', 'no bridge');
    const diagnostics = deviceAgentDiagnosticsFromError(err, context);
    expect(diagnostics[1]?.code).toBe('AI_ROUTE_MISMATCH');
  });

  it('falls back to AI_PROVIDER_ERROR for plain Error inputs', () => {
    const diagnostics = deviceAgentDiagnosticsFromError(new Error('generic'), context);
    expect(diagnostics[1]).toMatchObject({
      code: 'AI_PROVIDER_ERROR',
      message: 'generic',
      path: '/api/device-agent/generate-plan',
    });
  });

  it('round-trips through AiPlanConnectionError + aiDiagnosticsFromError', () => {
    const err = new DeviceAgentClientError('provider_rate_limited', 'slow down');
    const diagnostics = deviceAgentDiagnosticsFromError(err, context);
    const connection = new AiPlanConnectionError('Device Agent generate-plan failed: slow down', diagnostics);
    const recovered = aiDiagnosticsFromError(connection);
    expect(recovered).toHaveLength(2);
    expect(recovered[0]?.code).toBe('AI_ROUTE');
    expect(recovered[1]?.code).toBe('AI_HTTP');
  });

  it('uses "model configured" detail when no model is provided', () => {
    const err = new DeviceAgentClientError('provider_auth', 'bad');
    const diagnostics = deviceAgentDiagnosticsFromError(err, {
      action: 'generate-plan',
      provider: '',
      model: '',
    });
    expect(diagnostics[0]?.detail).toBe('model configured');
  });

  it('surfaces subcode in both message and detail when DeviceAgentClientError carries one', () => {
    const err = new DeviceAgentClientError(
      'provider_invalid_response',
      'bad json',
      undefined,
      'json_parse',
    );
    const diagnostics = deviceAgentDiagnosticsFromError(err, context);
    expect(diagnostics[1]?.message).toContain('provider_invalid_response:json_parse');
    expect(diagnostics[1]?.detail).toContain('subcode=json_parse');
    expect(diagnostics[1]?.detail).toContain('bad json');
  });

  it('omits the subcode segment when none is present', () => {
    const err = new DeviceAgentClientError('provider_auth', 'bad');
    const diagnostics = deviceAgentDiagnosticsFromError(err, context);
    expect(diagnostics[1]?.message).not.toContain(':');
    expect(diagnostics[1]?.detail).not.toContain('subcode=');
  });
});
