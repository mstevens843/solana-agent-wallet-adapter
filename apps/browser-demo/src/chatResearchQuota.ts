export const CHAT_RESEARCH_LIST_LIMIT = 10;
export const CHAT_RESEARCH_LIST_WINDOW_MS = 60 * 60 * 1000;

export interface ChatResearchQuotaSnapshot {
  allowed: boolean;
  used: number;
  limit: number;
  retryAfterMs?: number;
  timestamps: number[];
}

function normalizeTimestamps(input: unknown, now: number, windowMs: number): number[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .filter((value) => value > 0 && value <= now && now - value < windowMs)
    .sort((a, b) => a - b);
}

export function chatResearchQuotaStorageKey(actionId: string, walletAddress?: string): string {
  const scope = walletAddress?.trim() || 'anonymous';
  return `agentic:chat-research-quota:v1:${scope}:${actionId}`;
}

export function readChatResearchQuota(
  raw: string | null | undefined,
  now = Date.now(),
  limit = CHAT_RESEARCH_LIST_LIMIT,
  windowMs = CHAT_RESEARCH_LIST_WINDOW_MS,
): ChatResearchQuotaSnapshot {
  let parsed: unknown = undefined;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = undefined;
    }
  }
  const timestamps = normalizeTimestamps(parsed, now, windowMs);
  const allowed = timestamps.length < limit;
  const oldest = timestamps[0] ?? now;
  return {
    allowed,
    used: timestamps.length,
    limit,
    ...(allowed ? {} : { retryAfterMs: Math.max(0, windowMs - (now - oldest)) }),
    timestamps,
  };
}

export function recordChatResearchQuotaUse(
  raw: string | null | undefined,
  now = Date.now(),
  limit = CHAT_RESEARCH_LIST_LIMIT,
  windowMs = CHAT_RESEARCH_LIST_WINDOW_MS,
): ChatResearchQuotaSnapshot {
  const current = readChatResearchQuota(raw, now, limit, windowMs);
  if (!current.allowed) return current;
  const timestamps = [...current.timestamps, now].slice(-limit);
  return {
    allowed: true,
    used: timestamps.length,
    limit,
    timestamps,
  };
}
