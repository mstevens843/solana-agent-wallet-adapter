/**
 * Jupiter swap. Quotes and orders try the hosted render-web Jupiter relay first
 * for common tokens, then fall back to the local bridge for custom mints/BYOK.
 * Execution still calls the render-web relay only when a signed Jupiter order is
 * supplied.
 *
 *   swap quote <amount> [--input-token SOL --output-token USDC --slippage-bps 50]
 *   swap order <amount> [...]  [--cloud]
 *   swap execute <amount> [...]  [--cloud]
 */
import type { GlobalOptions, ParsedArgs } from '../shared/types.js';
import { commandValues, optionValue, removeUndefined } from '../shared/util.js';
import { bridgeRequest, renderWebRequest } from '../http/index.js';
import { tryHostedSwapOrder, type HostedSwapInput } from '../swap/hosted.js';

const VALUE_FLAGS = new Set([
  '--input-token',
  '--output-token',
  '--slippage-bps',
  '--wallet',
  '--taker',
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
  const bridgeOnly = parsed.positionals.includes('--bridge') || parsed.positionals.includes('--local');
  const taker = optionValue(parsed.positionals, '--wallet') ?? optionValue(parsed.positionals, '--taker');
  const swapInput: HostedSwapInput = {
    amount,
    inputToken,
    outputToken,
    slippageBps,
    taker,
  };
  const body = removeUndefined(swapInput as unknown as Record<string, unknown>);

  if (sub === 'quote') {
    if (!bridgeOnly) {
      const hosted = await tryHostedSwapOrder(parsed.options, swapInput);
      if (hosted.ok) return hosted.value;
    }
    return bridgeRequest(parsed.options, '/bridge/action/swap-quote', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  if (sub === 'order') {
    if (!bridgeOnly) {
      const hosted = await tryHostedSwapOrder(parsed.options, swapInput);
      if (hosted.ok) return hosted.value;
    }
    return bridgeRequest(parsed.options, '/bridge/action/swap-order', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  if (sub === 'execute') {
    return callCloudSwap(parsed.options, '/api/swap/execute', body);
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
