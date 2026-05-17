// Pins the citation filter that drops blog/news subdomain citations on pricing
// questions. Without this filter, OpenAI's web_search_preview consistently surfaces
// blog.heliummobile.com posts and the model cites stale ($0 discontinued plan) prices.

import { describe, expect, it } from 'vitest';

import { filterLowAuthorityCitations, isPricingInstruction } from '../provider/citationFilter.js';

describe('isPricingInstruction', () => {
  it('matches price/cost/fee/rate/plan/subscription/monthly keywords', () => {
    expect(isPricingInstruction('what is the price of helium mobile')).toBe(true);
    expect(isPricingInstruction('check the monthly cost')).toBe(true);
    expect(isPricingInstruction('lowest fee')).toBe(true);
    expect(isPricingInstruction('current rate')).toBe(true);
    expect(isPricingInstruction('cheapest plan')).toBe(true);
    expect(isPricingInstruction('lowest plans')).toBe(true);
    expect(isPricingInstruction('vendor subscription')).toBe(true);
    expect(isPricingInstruction('per month')).toBe(true);
    expect(isPricingInstruction('per-month')).toBe(true);
    expect(isPricingInstruction('under $20')).toBe(true);
    expect(isPricingInstruction('approve if less than $5')).toBe(true);
  });

  it('does NOT match non-pricing questions', () => {
    expect(isPricingInstruction('is this a real token mint')).toBe(false);
    expect(isPricingInstruction('what protocol does jupiter use')).toBe(false);
    expect(isPricingInstruction('show recent transactions')).toBe(false);
    expect(isPricingInstruction('')).toBe(false);
    expect(isPricingInstruction('   ')).toBe(false);
  });
});

describe('filterLowAuthorityCitations', () => {
  const pricingInstruction = 'check helium mobile. lowest monthly plan. if less than $20. approve.';
  const nonPricingInstruction = 'is this a real token mint';

  function cite(url: string, title?: string) {
    return title ? { url, title } : { url };
  }

  it('drops blog/news/medium/substack citations on pricing questions', () => {
    const filtered = filterLowAuthorityCitations(
      [
        cite('https://blog.heliummobile.com/break-free', 'Break Free'),
        cite('https://news.vendor.com/article'),
        cite('https://medium.com/@user/post'),
        cite('https://author.substack.com/p/article'),
        cite('https://community.vendor.com/thread'),
        cite('https://forum.vendor.com/thread'),
        cite('https://user.wordpress.com/post'),
      ],
      pricingInstruction,
    );
    expect(filtered).toEqual([]);
  });

  it('preserves official pricing pages and support subdomains', () => {
    const filtered = filterLowAuthorityCitations(
      [
        cite('https://www.heliummobile.com/plans', 'Plans'),
        cite('https://hellohelium.com/plans'),
        cite('https://support.hellohelium.com/faq'),
        cite('https://pricing.vendor.com/tiers'),
        cite('https://vendor.com/about'),
      ],
      pricingInstruction,
    );
    expect(filtered).toHaveLength(5);
    expect(filtered[0]!.url).toBe('https://www.heliummobile.com/plans');
  });

  it('is a no-op for non-pricing questions (blog/medium pass through)', () => {
    const input = [
      cite('https://blog.example.com/post'),
      cite('https://medium.com/@user/post'),
      cite('https://example.com/api'),
    ];
    const filtered = filterLowAuthorityCitations(input, nonPricingInstruction);
    expect(filtered).toHaveLength(3);
  });

  it('drops a mixed list down to only official-domain citations', () => {
    const filtered = filterLowAuthorityCitations(
      [
        cite('https://blog.heliummobile.com/zero-plan'),
        cite('https://www.heliummobile.com/plans', 'Plans'),
        cite('https://hellohelium.com/'),
      ],
      pricingInstruction,
    );
    expect(filtered.map((c) => c.url)).toEqual([
      'https://www.heliummobile.com/plans',
      'https://hellohelium.com/',
    ]);
  });

  it('tolerates malformed URLs without crashing (does NOT drop them)', () => {
    const filtered = filterLowAuthorityCitations(
      [cite('not-a-url'), cite('https://www.heliummobile.com/plans')],
      pricingInstruction,
    );
    // Malformed entries pass through; we'd rather surface them than silently drop
    // potentially-legitimate citations on a parsing edge case.
    expect(filtered).toHaveLength(2);
  });
});
