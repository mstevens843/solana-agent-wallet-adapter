import { describe, expect, it } from 'vitest';

import {
  parseDeviceAgentConfig,
  parseDeviceAgentRequestEnvelope,
  parseDeviceAgentResponseEnvelope,
  parseDeviceAgentStatus,
  WorkflowValidationError,
} from '../index.js';

const STATUS = {
  available: true,
  enabled: true,
  configured: true,
  state: 'running',
  runtime: 'android-native',
  provider: 'openai',
  apiFormat: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  walletAddress: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
  message: 'Android Device Agent runtime is running.',
  checkedAt: '2026-05-15T12:00:00.000Z',
};

function workflowError(action: () => unknown): WorkflowValidationError {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowValidationError);
    return err as WorkflowValidationError;
  }
  throw new Error('Expected WorkflowValidationError.');
}

describe('Device Agent workflow contract', () => {
  it('parses a valid status payload', () => {
    expect(parseDeviceAgentStatus(STATUS)).toEqual(STATUS);
  });

  it('rejects invalid status enum values', () => {
    expect(workflowError(() => parseDeviceAgentStatus({
      ...STATUS,
      state: 'paused',
    }))).toMatchObject({
      code: 'invalid_enum',
      path: '$.state',
    });
    expect(workflowError(() => parseDeviceAgentStatus({
      ...STATUS,
      runtime: 'render-worker',
    }))).toMatchObject({
      code: 'invalid_enum',
      path: '$.runtime',
    });
    expect(workflowError(() => parseDeviceAgentStatus({
      ...STATUS,
      runtime: 'browser-unknown',
    }))).toMatchObject({
      code: 'invalid_enum',
      path: '$.runtime',
    });
  });

  it('parses a browser-native status payload', () => {
    const browserNativeStatus = { ...STATUS, runtime: 'browser-native' as const };
    expect(parseDeviceAgentStatus(browserNativeStatus)).toEqual(browserNativeStatus);
  });

  it('parses a browser-native success response envelope', () => {
    const status = { ...STATUS, runtime: 'browser-native' as const };
    expect(parseDeviceAgentResponseEnvelope({
      ok: true,
      status,
      result: { title: 'Draft SOL transfer' },
    })).toEqual({
      ok: true,
      status,
      result: { title: 'Draft SOL transfer' },
    });
  });

  it('parses a success response envelope', () => {
    expect(parseDeviceAgentResponseEnvelope({
      ok: true,
      status: STATUS,
      result: {
        title: 'Draft SOL transfer',
        fields: [{ label: 'Amount SOL', value: '0.1' }],
      },
    })).toEqual({
      ok: true,
      status: STATUS,
      result: {
        title: 'Draft SOL transfer',
        fields: [{ label: 'Amount SOL', value: '0.1' }],
      },
    });
  });

  it('parses an error response envelope', () => {
    expect(parseDeviceAgentResponseEnvelope({
      ok: false,
      status: { ...STATUS, state: 'error' },
      error: {
        code: 'INVALID_CONFIG',
        message: 'Device Agent config is missing apiKey.',
        subcode: 'MISSING_API_KEY',
      },
    })).toEqual({
      ok: false,
      status: { ...STATUS, state: 'error' },
      error: {
        code: 'INVALID_CONFIG',
        message: 'Device Agent config is missing apiKey.',
        subcode: 'MISSING_API_KEY',
      },
    });
  });

  it('rejects response envelopes with missing fields', () => {
    expect(workflowError(() => parseDeviceAgentResponseEnvelope({
      ok: true,
      result: { draft: true },
    }))).toMatchObject({
      code: 'invalid_object',
      path: '$.status',
    });
    expect(workflowError(() => parseDeviceAgentResponseEnvelope({
      ok: false,
      status: STATUS,
    }))).toMatchObject({
      code: 'invalid_object',
      path: '$.error',
    });
  });

  it('parses config and request envelopes without platform dependencies', () => {
    expect(parseDeviceAgentConfig({
      provider: 'openai',
      apiFormat: 'openai-compatible',
      model: 'gpt-4.1-mini',
      baseUrl: ' https://api.openai.com/v1 ',
      apiKey: 'sk-test',
      walletAddress: ' 4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd ',
    })).toEqual({
      provider: 'openai',
      apiFormat: 'openai-compatible',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      walletAddress: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
    });
    expect(parseDeviceAgentRequestEnvelope({
      requestId: 'req-1',
      method: 'generatePlan',
      payload: { prompt: 'Draft a payment plan.' },
    })).toEqual({
      requestId: 'req-1',
      method: 'generatePlan',
      payload: { prompt: 'Draft a payment plan.' },
    });
  });
});
