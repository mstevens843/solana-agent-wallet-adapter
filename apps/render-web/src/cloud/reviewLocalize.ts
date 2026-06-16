/**
 * /api/review/localize
 *
 * Model-backed translation of an already-produced agent review's user-facing display
 * copy (summary / reason / findings / questions / reviewers) into the user's language.
 *
 * Why this exists: the hosted AI review path translates inline (aiPlanner
 * `localizeReviewForDisplay`), but the BYOK **device-agent** path runs the review LLM
 * on-device / in the native runtime and never reaches the server — so its English review
 * cannot be translated there. The device-agent client posts the finished review's display
 * copy here and the operator's LLM returns localized copy, which the client merges into
 * `review.localized`. Phrase-pack localization (deterministic labels/prose) still runs
 * client-side regardless; this only covers the free-form LLM prose the phrase-pack cannot.
 *
 * No keys cross from the device: the operator key (or a body-supplied session key) does the
 * translation. Gated by `AGENTIC_REVIEW_LOCALIZATION` (the planner returns undefined when
 * disabled) and only runs for non-English languages. Rate-limited as a hosted-AI route.
 *
 * Contract:
 *   Request: { review: { reason?, summary?, evidence?, questions?, reviewers?, policies?, facts?, auditReceipt? },
 *              language?: string, fallbackText?: string }
 *   Response: { ok: true, localized: <AgentReviewLocalizedCopy> | null }  (null = nothing to do)
 *          or { ok: false, error: string, code: 'bad_request' | 'too_large' | 'localize_failed' }
 */

import {
  normalizeReviewLanguageCode,
  shouldLocalizeAgentReview,
  sourceLanguageFromReview,
  type AgentReviewLocalizedCopy,
  type LocalizableAgentReview,
  type PolicyLanguageCode,
} from '@solana-agent-wallet-adapter/workflow';

export type ReviewLocalizeErrorCode = 'bad_request' | 'too_large' | 'localize_failed';

export type ReviewLocalizeResult =
  | { ok: true; localized: AgentReviewLocalizedCopy | null }
  | { ok: false; error: string; code: ReviewLocalizeErrorCode };

/** A real review's display copy is tiny; reject oversized blobs before hitting the LLM. */
const MAX_REVIEW_LOCALIZE_CHARS = 24_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function handleReviewLocalize(
  rawBody: unknown,
  localize: (
    review: LocalizableAgentReview,
    language: PolicyLanguageCode,
  ) => Promise<AgentReviewLocalizedCopy | undefined>,
): Promise<ReviewLocalizeResult> {
  const body = isObject(rawBody) ? rawBody : {};
  const review = isObject(body.review) ? (body.review as LocalizableAgentReview) : undefined;
  if (!review) return { ok: false, error: 'Missing review display copy.', code: 'bad_request' };

  // Bound the payload — display copy is small; anything larger is abuse, not a real review.
  if (JSON.stringify(review).length > MAX_REVIEW_LOCALIZE_CHARS) {
    return { ok: false, error: 'Review display copy too large.', code: 'too_large' };
  }

  const fallbackText = typeof body.fallbackText === 'string' ? body.fallbackText : '';
  const language = normalizeReviewLanguageCode(
    typeof body.language === 'string' && body.language
      ? body.language
      : sourceLanguageFromReview(review, fallbackText),
  );
  // English / unknown / undetectable: nothing to translate. Client keeps its phrase-pack copy.
  if (!shouldLocalizeAgentReview(language)) return { ok: true, localized: null };

  try {
    const localized = await localize(review, language);
    return { ok: true, localized: localized ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'localize_failed' };
  }
}
