// Pins the deterministic, secret-safe console format of the Device Agent diagnostic logger:
// stable `[device-agent:diag] <event> key=value` shape, keys sorted, disabled by default under
// vitest, and a global runtime override.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isDeviceAgentDiagLoggingEnabled,
  logDeviceAgentDiag,
  setDeviceAgentDiagLogging,
} from '../runtime/diagnosticLog.js';

const GLOBAL_OVERRIDE_KEY = '__AGENTIC_DEVICE_AGENT_DEBUG__';

describe('logDeviceAgentDiag', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[GLOBAL_OVERRIDE_KEY];
    setDeviceAgentDiagLogging(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>)[GLOBAL_OVERRIDE_KEY];
    setDeviceAgentDiagLogging(false);
  });

  it('is disabled by default under vitest', () => {
    setDeviceAgentDiagLogging(false);
    expect(isDeviceAgentDiagLoggingEnabled()).toBe(false);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logDeviceAgentDiag('info', 'provider.request', { url: 'https://openrouter.ai/api/v1/messages' });
    expect(info).not.toHaveBeenCalled();
  });

  it('emits a stable line with keys sorted alphabetically', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logDeviceAgentDiag('info', 'provider.request', {
      url: 'https://openrouter.ai/api/v1/messages',
      method: 'POST',
      bodyChars: 1234,
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toBe(
      '[device-agent:diag] provider.request bodyChars=1234 method=POST url=https://openrouter.ai/api/v1/messages',
    );
  });

  it('formats arrays compactly (header names, not values)', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logDeviceAgentDiag('info', 'provider.request', {
      headers: ['Accept', 'Authorization', 'Content-Type', 'HTTP-Referer', 'X-Title'],
    });
    expect(info.mock.calls[0]![0]).toBe(
      '[device-agent:diag] provider.request headers=[Accept,Authorization,Content-Type,HTTP-Referer,X-Title]',
    );
  });

  it('routes each level to the matching console method', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    logDeviceAgentDiag('warn', 'provider.empty', { truncated: true });
    logDeviceAgentDiag('error', 'provider.error', { code: 'provider_network' });
    expect(warn).toHaveBeenCalledWith('[device-agent:diag] provider.empty truncated=true');
    expect(error).toHaveBeenCalledWith('[device-agent:diag] provider.error code=provider_network');
  });

  it('quotes only values that would break the key=value split', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logDeviceAgentDiag('info', 'provider.error', { message: 'Failed to fetch' });
    expect(info.mock.calls[0]![0]).toBe('[device-agent:diag] provider.error message="Failed to fetch"');
  });

  it('honors the global runtime override regardless of the module flag', () => {
    setDeviceAgentDiagLogging(false);
    (globalThis as Record<string, unknown>)[GLOBAL_OVERRIDE_KEY] = true;
    expect(isDeviceAgentDiagLoggingEnabled()).toBe(true);

    setDeviceAgentDiagLogging(true);
    (globalThis as Record<string, unknown>)[GLOBAL_OVERRIDE_KEY] = false;
    expect(isDeviceAgentDiagLoggingEnabled()).toBe(false);
  });
});
