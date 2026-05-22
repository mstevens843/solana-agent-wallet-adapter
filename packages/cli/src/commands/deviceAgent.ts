/**
 * Device Agent control surface.
 *
 * Endpoints (verified against apps/render-web/src/cloud/router.ts):
 *   GET  /api/device-agent/status                     — current state
 *   POST /api/device-agent/control
 *     body { action: 'configure' | 'start' | 'stop' | 'clear', settings?: { provider, apiFormat, baseUrl, model } }
 *
 * The render-side device-agent never receives API keys (those stay client-side
 * in the Android Keystore / browser IndexedDB). For BRIDGE-side AI planning
 * (CLI/desktop), the key goes via /bridge/ai/session-key — set it with
 * `device-agent set-key --from-env AGENTIC_AI_API_KEY`.
 *
 * AI primitives (used by both Device Agent runtimes and the bridge):
 *   POST /bridge/ai/generate-plan
 *   POST /bridge/ai/review-plan
 *   POST /bridge/ai/ask-about-plan
 */
import process from 'node:process';

import type { GlobalOptions, ParsedArgs } from '../shared/types.js';
import { optionValue, removeUndefined } from '../shared/util.js';
import { bridgeRequest, renderWebRequest } from '../http/index.js';

const KNOWN_SUBS = new Set([
  'status',
  'control',
  'configure',
  'start',
  'stop',
  'clear',
  'set-key',
  'generate-plan',
  'review-plan',
  'ask',
]);

export async function dispatchDeviceAgent(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'help';
  if (sub === 'help' || !KNOWN_SUBS.has(sub)) {
    return {
      command: 'device-agent',
      subcommands: [...KNOWN_SUBS],
      hint: 'status, configure, start, stop, clear, set-key, generate-plan, review-plan, ask',
    };
  }

  if (sub === 'status') {
    return renderWebRequest(parsed.options, '/api/device-agent/status', undefined, {
      label: 'Device Agent',
      requireAuth: true,
    });
  }

  if (sub === 'configure' || sub === 'control') {
    const action = (sub === 'control')
      ? (optionValue(parsed.positionals, '--action') ?? 'configure')
      : 'configure';
    const settings = removeUndefined({
      provider: optionValue(parsed.positionals, '--provider'),
      apiFormat: optionValue(parsed.positionals, '--api-format'),
      baseUrl: optionValue(parsed.positionals, '--base-url'),
      model: optionValue(parsed.positionals, '--model'),
    });
    return renderWebRequest(parsed.options, '/api/device-agent/control', {
      method: 'POST',
      body: JSON.stringify({ action, settings }),
    }, { label: 'Device Agent', requireAuth: true });
  }

  if (sub === 'start' || sub === 'stop' || sub === 'clear') {
    return renderWebRequest(parsed.options, '/api/device-agent/control', {
      method: 'POST',
      body: JSON.stringify({ action: sub }),
    }, { label: 'Device Agent', requireAuth: true });
  }

  if (sub === 'set-key') {
    // BRIDGE-side AI session key — never sent to render-web. Local-only.
    // Inline --key is deliberately rejected to keep secrets out of argv +
    // shell history. Use --from-env <VAR> with the key already in that var.
    if (optionValue(parsed.positionals, '--key') !== undefined) {
      throw new Error('Inline --key is rejected to keep API keys out of shell history. Use --from-env <VAR> instead.');
    }
    const fromEnv = optionValue(parsed.positionals, '--from-env');
    if (!fromEnv) {
      throw new Error('Usage: solana-agent-wallet device-agent set-key --from-env <VAR> [--provider openai] [--model gpt-5] [--base-url <url>] [--api-format openai|anthropic]');
    }
    const apiKey = process.env[fromEnv];
    if (!apiKey) throw new Error(`Env var ${fromEnv} is empty or undefined.`);
    const body = removeUndefined({
      apiKey,
      provider: optionValue(parsed.positionals, '--provider'),
      model: optionValue(parsed.positionals, '--model'),
      baseUrl: optionValue(parsed.positionals, '--base-url'),
      apiFormat: optionValue(parsed.positionals, '--api-format'),
    });
    return bridgeRequest(parsed.options, '/bridge/ai/session-key', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  if (sub === 'generate-plan') {
    const prompt = parsed.positionals.slice(2).filter((p) => !p.startsWith('--')).join(' ');
    if (!prompt) {
      throw new Error('Usage: solana-agent-wallet device-agent generate-plan "your intent here"');
    }
    return runBridgeAi(parsed.options, '/bridge/ai/generate-plan', {
      prompt,
      userNotes: prompt,
    });
  }

  if (sub === 'review-plan') {
    const actionId = parsed.positionals[2];
    if (!actionId) {
      throw new Error('Usage: solana-agent-wallet device-agent review-plan <action-id>');
    }
    return runBridgeAi(parsed.options, '/bridge/ai/review-plan', { actionId });
  }

  if (sub === 'ask') {
    const actionId = parsed.positionals[2];
    const question = parsed.positionals.slice(3).join(' ');
    if (!actionId || !question) {
      throw new Error('Usage: solana-agent-wallet device-agent ask <action-id> "question text"');
    }
    return runBridgeAi(parsed.options, '/bridge/ai/ask-about-plan', { actionId, question });
  }

  throw new Error(`Unknown device-agent command: ${sub}`);
}

async function runBridgeAi(options: GlobalOptions, path: string, body: Record<string, unknown>): Promise<unknown> {
  return bridgeRequest(options, path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
