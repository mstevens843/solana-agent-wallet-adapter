import type { ParsedArgs } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';

/**
 * `plan generate <prompt>` → /bridge/ai/generate-plan
 * `plan review <action-id>` → /bridge/ai/review-plan
 * `plan ask <action-id> "question"` → /bridge/ai/ask-about-plan
 * `plan status` → /bridge/ai/status
 */
export async function dispatchPlan(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'status';
  if (sub === 'status') {
    return bridgeRequest(parsed.options, '/bridge/ai/status');
  }
  if (sub === 'generate') {
    const prompt = parsed.positionals.slice(2).filter((p) => !p.startsWith('--')).join(' ');
    if (!prompt) {
      throw new Error('Usage: solana-agent-wallet plan generate "your intent text"');
    }
    return bridgeRequest(parsed.options, '/bridge/ai/generate-plan', {
      method: 'POST',
      body: JSON.stringify({ prompt, userNotes: prompt }),
    });
  }
  if (sub === 'review') {
    const actionId = parsed.positionals[2];
    if (!actionId) {
      throw new Error('Usage: solana-agent-wallet plan review <action-id>');
    }
    return bridgeRequest(parsed.options, '/bridge/ai/review-plan', {
      method: 'POST',
      body: JSON.stringify({ actionId }),
    });
  }
  if (sub === 'ask') {
    const actionId = parsed.positionals[2];
    const question = parsed.positionals.slice(3).join(' ');
    if (!actionId || !question) {
      throw new Error('Usage: solana-agent-wallet plan ask <action-id> "question text"');
    }
    return bridgeRequest(parsed.options, '/bridge/ai/ask-about-plan', {
      method: 'POST',
      body: JSON.stringify({ actionId, question }),
    });
  }
  throw new Error(`Unknown plan subcommand: ${sub}. Try: status | generate | review | ask`);
}
