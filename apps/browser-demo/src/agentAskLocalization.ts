import {
  agentReviewLocalizedProse,
  normalizeReviewLanguageCode,
  shouldLocalizeAgentReview,
  type AgentReviewLocalizedCopy,
  type LocalizableAgentReview,
  type PolicyLanguageCode,
} from '@solana-agent-wallet-adapter/workflow';

export interface AgentAskLocalizationOptions {
  enabled: boolean;
  language: string | undefined;
  fallbackText: string;
  localizeReviewCopy: (
    review: LocalizableAgentReview,
    language: PolicyLanguageCode,
    fallbackText: string,
  ) => Promise<AgentReviewLocalizedCopy | null>;
}

export async function localizeAgentAskResultForDisplay<R extends { answer: string }>(
  result: R,
  options: AgentAskLocalizationOptions,
): Promise<R> {
  try {
    if (!options.enabled) return result;
    const language = normalizeReviewLanguageCode(options.language);
    if (!shouldLocalizeAgentReview(language)) return result;
    const answer = result.answer.trim();
    if (!answer) return result;
    const localized = await options.localizeReviewCopy({ reason: answer }, language, options.fallbackText);
    const translatedAnswer = localized?.reason?.trim() ||
      agentReviewLocalizedProse(answer, language)?.trim() ||
      '';
    if (!translatedAnswer || translatedAnswer === answer) return result;
    return { ...result, answer: translatedAnswer };
  } catch {
    return result;
  }
}
