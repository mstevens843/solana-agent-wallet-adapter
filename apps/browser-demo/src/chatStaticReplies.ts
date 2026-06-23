export const CHAT_HELP_PROMPT = 'What can you help me do?';

export const CHAT_HELP_REPLY_LINES = [
  'Use this tab to think through anything about your wallet before you act.',
  'Ask about balances, tokens, prices, risk, routes, or what a transaction would mean.',
  'When you are ready, use Wallet Actions or ask me to prepare a swap, send, or proof. I will prepare a review card here.',
  'Nothing moves until you review and sign.',
] as const;

function normalizeStaticPrompt(input: string): string {
  return input
    .trim()
    .replace(/[?!.]+$/u, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

export function chatStaticReplyForPrompt(input: string): readonly string[] | null {
  return normalizeStaticPrompt(input) === 'what can you help me do'
    ? CHAT_HELP_REPLY_LINES
    : null;
}
