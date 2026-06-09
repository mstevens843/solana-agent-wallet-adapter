// Deterministic, secret-safe diagnostic logging for the browser Device Agent runtime.
//
// Goal: when a provider call fails (OpenRouter "Failed to fetch", OpenAI-compatible empty
// response, etc.), emit a single, stable-format console line per event so a failing run can be
// read off the DevTools console and pasted verbatim — same shape every time, keys sorted, no
// randomness. Browser-only; intentionally NOT mirrored in the Kotlin/Swift runtimes.
//
// SECRETS: callers must never pass the API key or an Authorization header VALUE. This module
// logs only what it is given. The wired call sites pass header NAMES (not values), URLs, model
// ids, status codes, byte counts, and error codes/messages (already redacted upstream).
//
// Enabled by default in the browser; silenced under vitest so unit-test output stays clean.
// Force on/off at runtime from the console: `globalThis.__AGENTIC_DEVICE_AGENT_DEBUG__ = false`.

export type DeviceAgentDiagLevel = 'debug' | 'info' | 'warn' | 'error';

const GLOBAL_OVERRIDE_KEY = '__AGENTIC_DEVICE_AGENT_DEBUG__';

function detectDefaultEnabled(): boolean {
  // Off under vitest/node test runners so the test suites don't spew request logs.
  try {
    if (typeof process !== 'undefined' && process.env && (process.env.VITEST || process.env.NODE_ENV === 'test')) {
      return false;
    }
  } catch {
    // `process` not defined (real browser) — fall through to enabled.
  }
  return true;
}

let enabled = detectDefaultEnabled();

export function setDeviceAgentDiagLogging(on: boolean): void {
  enabled = on;
}

export function isDeviceAgentDiagLoggingEnabled(): boolean {
  const override = (globalThis as Record<string, unknown>)[GLOBAL_OVERRIDE_KEY];
  if (override === true) return true;
  if (override === false) return false;
  return enabled;
}

// Monotonic-ish clock for durations. performance.now() when available (high-res, immune to
// wall-clock jumps), else Date.now(). App code may use these freely.
export function diagNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') {
    // Quote only when the value would otherwise break the key=value split.
    return /[\s="]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => formatValue(v)).join(',')}]`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Emit one stable line: `[device-agent:diag] <event> key=value ...` with keys sorted so the
// output is deterministic and diffable across runs.
export function logDeviceAgentDiag(
  level: DeviceAgentDiagLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (!isDeviceAgentDiagLoggingEnabled()) return;
  const serialized = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${formatValue(fields[key])}`)
    .join(' ');
  const line = serialized.length > 0 ? `[device-agent:diag] ${event} ${serialized}` : `[device-agent:diag] ${event}`;
  const sink = level === 'error'
    ? console.error
    : level === 'warn'
      ? console.warn
      : level === 'info'
        ? console.info
        : console.debug;
  // eslint-disable-next-line no-console
  sink(line);
}
