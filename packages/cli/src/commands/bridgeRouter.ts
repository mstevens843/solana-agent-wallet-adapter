/**
 * Bridge router quote — fiat USD → cheapest Solana settlement route.
 *
 * Endpoint (verified against apps/render-web/src/cloud/bridgeRoutes.ts):
 *   POST /api/agents/settlement/quote
 *   body { amountUsd: number, recipient: string, targetMint?, cluster?, payerHoldings?, maxSlippageBps? }
 */
import type { ParsedArgs } from '../shared/types.js';
import { optionValue, readJsonFile, removeUndefined } from '../shared/util.js';
import { renderWebRequest } from '../http/index.js';

export async function dispatchBridgeRouter(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'quote';
  if (sub !== 'quote') {
    throw new Error(`Unknown bridge-router subcommand: ${sub}. Try: quote`);
  }
  const amountUsdRaw = parsed.positionals[2];
  const recipient = parsed.positionals[3];
  if (!amountUsdRaw || !recipient) {
    throw new Error('Usage: solana-agent-wallet bridge-router quote <amount-usd> <recipient> [--target-mint <mint>] [--cluster mainnet-beta|devnet] [--max-slippage-bps N] [--holdings <holdings.json>]');
  }
  const amountUsd = Number(amountUsdRaw);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error('amount-usd must be a positive number.');
  }
  const targetMint = optionValue(parsed.positionals, '--target-mint');
  const cluster = optionValue(parsed.positionals, '--cluster');
  const maxSlippageRaw = optionValue(parsed.positionals, '--max-slippage-bps');
  const maxSlippageBps = maxSlippageRaw ? Number(maxSlippageRaw) : undefined;
  if (maxSlippageBps !== undefined && (!Number.isFinite(maxSlippageBps) || maxSlippageBps < 0)) {
    throw new Error('--max-slippage-bps must be a non-negative number.');
  }
  let payerHoldings: unknown = undefined;
  const holdingsFile = optionValue(parsed.positionals, '--holdings');
  if (holdingsFile) {
    payerHoldings = await readJsonFile(holdingsFile, 'holdings');
  }
  const body = removeUndefined({
    amountUsd,
    recipient,
    targetMint,
    cluster,
    maxSlippageBps,
    payerHoldings,
  });
  return renderWebRequest(parsed.options, '/api/agents/settlement/quote', {
    method: 'POST',
    body: JSON.stringify(body),
  }, { label: 'Render-web settlement', requireAuth: true });
}
