import { redactSecrets } from './trace.js';

export type ChatFactAttemptStatus = 'ok' | 'missing' | 'error';

export interface ChatFactAttempt {
  provider: string;
  endpoint?: string;
  status: ChatFactAttemptStatus;
  checkedAt: string;
  detail?: string;
}

export interface ChatFactProviderSpec {
  provider: string;
  endpoint?: string;
  run: () => Promise<Record<string, unknown>>;
  /** Optional success predicate for providers whose valid "not found" shape is 200 OK. */
  isUsable?: (data: Record<string, unknown>) => boolean;
}

export interface ChatFactChainResult {
  data: Record<string, unknown>;
  attempts: ChatFactAttempt[];
  exhausted: boolean;
  webSearchRecommended?: boolean;
}

export interface ChatFactChainOptions {
  retryTransient?: boolean;
  retryDelayMs?: number;
  webSearchOnExhausted?: boolean;
}

const TRANSIENT_RE = /\b(timeout|timed?\s*out|econn|enotfound|fetch\s*failed|network|reset|503|504|502|500|429|abort|temporar(?:y|ily)|unavailable|rate limit|too many requests)\b/i;
const MISSING_RE = /\b(404|not[_\s-]?found|no data|missing|empty|unknown token|no price|no .*returned)\b/i;

export function redactChatFactText(value: string): string {
  const redacted = redactSecrets(value);
  return typeof redacted === 'string' ? redacted : '[redacted]';
}

export function chatFactErrorMessage(err: unknown): string {
  return redactChatFactText(err instanceof Error ? err.message : String(err));
}

export function isChatFactTransientDetail(detail: string | undefined): boolean {
  return Boolean(detail && TRANSIENT_RE.test(detail));
}

export function isChatFactMissingDetail(detail: string | undefined): boolean {
  return Boolean(detail && MISSING_RE.test(detail));
}

export function isUnavailableChatFact(data: Record<string, unknown>): boolean {
  if (data.unavailable === true || data.error !== undefined) return true;
  if (data.found === false || data.exists === false) return true;
  const reason = typeof data.reason === 'string' ? data.reason : '';
  return isChatFactMissingDetail(reason);
}

function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attempt(provider: string, status: ChatFactAttemptStatus, endpoint?: string, detail?: string): ChatFactAttempt {
  return {
    provider,
    ...(endpoint ? { endpoint } : {}),
    status,
    checkedAt: new Date().toISOString(),
    ...(detail ? { detail: redactChatFactText(detail) } : {}),
  };
}

async function runProviderOnce(spec: ChatFactProviderSpec): Promise<{ data?: Record<string, unknown>; attempt: ChatFactAttempt }> {
  try {
    const data = await spec.run();
    const usable = spec.isUsable ? spec.isUsable(data) : !isUnavailableChatFact(data);
    if (usable) return { data, attempt: attempt(spec.provider, 'ok', spec.endpoint) };
    const detail = typeof data.error === 'string'
      ? data.error
      : typeof data.reason === 'string' ? data.reason : 'provider returned no usable data';
    return { data, attempt: attempt(spec.provider, 'missing', spec.endpoint, detail) };
  } catch (err) {
    const detail = chatFactErrorMessage(err);
    return { attempt: attempt(spec.provider, isChatFactMissingDetail(detail) ? 'missing' : 'error', spec.endpoint, detail) };
  }
}

export async function resolveChatFactChain(
  specs: ReadonlyArray<ChatFactProviderSpec>,
  options: ChatFactChainOptions = {},
): Promise<ChatFactChainResult> {
  const attempts: ChatFactAttempt[] = [];
  let lastData: Record<string, unknown> | undefined;
  const retryTransient = options.retryTransient !== false;
  const retryDelayMs = options.retryDelayMs ?? 150;

  for (const spec of specs) {
    const first = await runProviderOnce(spec);
    attempts.push(first.attempt);
    if (first.data) lastData = first.data;
    if (first.attempt.status === 'ok' && first.data) {
      return { data: { ...first.data, providerAttempts: attempts }, attempts, exhausted: false };
    }
    if (retryTransient && first.attempt.status === 'error' && isChatFactTransientDetail(first.attempt.detail)) {
      await sleep(retryDelayMs);
      const retry = await runProviderOnce(spec);
      attempts.push(retry.attempt);
      if (retry.data) lastData = retry.data;
      if (retry.attempt.status === 'ok' && retry.data) {
        return { data: { ...retry.data, providerAttempts: attempts }, attempts, exhausted: false };
      }
    }
  }

  const finalData = lastData && Object.keys(lastData).length > 0 ? lastData : {};
  return {
    data: {
      ...finalData,
      unavailable: true,
      exhausted: true,
      providerAttempts: attempts,
      ...(options.webSearchOnExhausted ? { webSearchRecommended: true } : {}),
    },
    attempts,
    exhausted: true,
    ...(options.webSearchOnExhausted ? { webSearchRecommended: true } : {}),
  };
}
