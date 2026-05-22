/**
 * Jupiter swap. The default path uses the local bridge (`/bridge/action/swap-*`)
 * which is preferred because it composes a prepared-action in the user's
 * approval inbox. The `--cloud` flag routes `order` and `execute` to the
 * render-web Jupiter relay (`/api/swap/{order,execute}`) for environments
 * without a local bridge (e.g. CI scripts that only have a session token).
 *
 *   swap quote <amount> [--input-token SOL --output-token USDC --slippage-bps 50]
 *   swap order <amount> [...]  [--cloud]
 *   swap execute <amount> [...]  [--cloud]
 */
import type { GlobalOptions, ParsedArgs } from '../shared/types.js';
import { commandValues, optionValue, removeUndefined } from '../shared/util.js';
import { bridgeRequest, renderWebRequest } from '../http/index.js';

const VALUE_FLAGS = new Set([
  '--input-token',
  '--output-token',
  '--slippage-bps',
  '--wallet',
  '--amount',
]);

export async function dispatchSwap(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'quote';
  const rawArgs = commandValues(parsed.positionals.slice(2), VALUE_FLAGS);
  const amount = rawArgs[0] ?? optionValue(parsed.positionals, '--amount');
  if (!amount) {
    throw new Error(`Usage: solana-agent-wallet swap ${sub} <amount> [--input-token SOL] [--output-token USDC] [--slippage-bps 50] [--cloud]`);
  }
  const inputToken = optionValue(parsed.positionals, '--input-token') ?? rawArgs[1] ?? 'SOL';
  const outputToken = optionValue(parsed.positionals, '--output-token') ?? rawArgs[2] ?? 'USDC';
  const slippageBpsRaw = optionValue(parsed.positionals, '--slippage-bps');
  const slippageBps = slippageBpsRaw ? Number(slippageBpsRaw) : undefined;
  const cloud = parsed.positionals.includes('--cloud');
  const body = removeUndefined({
    amount,
    inputToken,
    outputToken,
    slippageBps,
  });

  if (sub === 'quote') {
    // Quote always goes through the bridge (no cloud equivalent needed —
    // quotes are read-only and the bridge endpoint is unauthenticated).
    return bridgeRequest(parsed.options, '/bridge/action/swap-quote', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  if (sub === 'order') {
    return cloud
      ? callCloudSwap(parsed.options, '/api/swap/order', body)
      : bridgeRequest(parsed.options, '/bridge/action/swap-order', {
          method: 'POST',
          body: JSON.stringify(body),
        });
  }
  if (sub === 'execute') {
    return cloud
      ? callCloudSwap(parsed.options, '/api/swap/execute', body)
      : bridgeRequest(parsed.options, '/bridge/action/swap-execute', {
          method: 'POST',
          body: JSON.stringify(body),
        });
  }
  throw new Error(`Unknown swap subcommand: ${sub}. Try: quote | order | execute`);
}

async function callCloudSwap(
  options: GlobalOptions,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return renderWebRequest(options, path, {
    method: 'POST',
    body: JSON.stringify(body),
  }, { label: 'Render-web swap', requireAuth: true });
}
