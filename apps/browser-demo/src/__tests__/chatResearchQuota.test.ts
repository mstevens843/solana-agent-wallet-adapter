import { describe, expect, it } from 'vitest';

import {
  chatResearchQuotaStorageKey,
  readChatResearchQuota,
  recordChatResearchQuotaUse,
} from '../chatResearchQuota.js';

describe('chat research quota', () => {
  it('allows ten list requests in a rolling hour and blocks the eleventh', () => {
    let raw: string | null = null;
    for (let index = 0; index < 10; index += 1) {
      const next = recordChatResearchQuotaUse(raw, 1_000 + index, 10, 3_600_000);
      expect(next.allowed).toBe(true);
      raw = JSON.stringify(next.timestamps);
    }

    const blocked = readChatResearchQuota(raw, 2_000, 10, 3_600_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.used).toBe(10);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('drops expired entries before checking the limit', () => {
    const raw = JSON.stringify([1_000, 2_000, 3_000]);
    const next = recordChatResearchQuotaUse(raw, 3_605_000, 3, 3_600_000);

    expect(next.allowed).toBe(true);
    expect(next.timestamps).toEqual([3_605_000]);
  });

  it('scopes storage by wallet and action', () => {
    expect(chatResearchQuotaStorageKey('new-listings', 'ABC')).toContain(':ABC:new-listings');
    expect(chatResearchQuotaStorageKey('new-listings')).toContain(':anonymous:new-listings');
  });
});
