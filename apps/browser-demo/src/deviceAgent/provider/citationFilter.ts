// Defense against low-authority web research sources (blog posts, news subdomains,
// medium.com, substack.com, etc.) for pricing questions. Without this filter, OpenAI's
// `web_search_preview` and other search backends tend to surface vendor blog subdomains
// (e.g. blog.heliummobile.com) that describe historical/discontinued plans — the model
// then cites stale pricing as if it were current.
//
// Conservative scoping: the filter is a no-op unless the instruction matches a pricing
// keyword (price/cost/fee/rate/plan/subscription/monthly/$N). Non-pricing questions can
// legitimately cite blog/medium posts.
//
// Server-side mirror: packages/mcp-server/src/aiPlanner.ts has its own copy because it
// can't import from apps/browser-demo. Keep the two in sync when widening the patterns.

// Two alternatives: word-bounded pricing keywords OR a dollar-sign-then-digit anywhere.
// The dollar-sign alternative has no \b prefix because `$` is non-word and `under $20`
// has no word boundary directly before the `$`.
const PRICING_KEYWORDS = /\b(price|cost|fee|rate|plan|plans|subscription|monthly|per[\s-]?month)\b|\$\s*\d/i;

// Hostnames matching any of these patterns are dropped when the instruction is a
// pricing question. Listed in order of expected frequency for quick predicate cost.
const LOW_AUTHORITY_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /^blog\./i,             // blog.heliummobile.com, blog.vendor.com
  /^news\./i,             // news.vendor.com
  /\.blog$/i,             // example.blog
  /(^|\.)medium\.com$/i,  // medium.com, user.medium.com
  /(^|\.)substack\.com$/i, // substack.com, author.substack.com
  /(^|\.)wordpress\.com$/i,
  /(^|\.)tumblr\.com$/i,
  /^community\./i,        // community.vendor.com (often forum threads)
  /^forum\./i,            // forum.vendor.com
];

export function isPricingInstruction(text: string): boolean {
  if (typeof text !== 'string' || text.trim().length === 0) return false;
  return PRICING_KEYWORDS.test(text);
}

export interface CitationLike {
  url: string;
  title?: string;
  citedText?: string;
}

/**
 * Drop citations whose hostname matches any LOW_AUTHORITY_HOST_PATTERNS pattern, BUT
 * only when the instruction looks like a pricing question. Non-pricing instructions
 * (e.g. "is this a real token mint?") pass through unchanged so general knowledge
 * questions can still cite blog/medium posts as legitimate primary sources.
 */
export function filterLowAuthorityCitations<T extends CitationLike>(
  citations: ReadonlyArray<T>,
  instructionText: string,
): T[] {
  if (!isPricingInstruction(instructionText)) {
    return [...citations];
  }
  const out: T[] = [];
  for (const citation of citations) {
    if (!isLowAuthorityHost(citation.url)) {
      out.push(citation);
    }
  }
  return out;
}

function isLowAuthorityHost(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Malformed URLs are conservatively NOT filtered — they likely won't survive
    // downstream processing anyway, and false-filtering them would silently drop
    // potentially-legitimate citations.
    return false;
  }
  for (const pattern of LOW_AUTHORITY_HOST_PATTERNS) {
    if (pattern.test(host)) return true;
  }
  return false;
}
