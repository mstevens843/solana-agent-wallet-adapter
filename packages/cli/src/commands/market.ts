import type { ParsedArgs } from '../shared/types.js';
import { optionValue, optionValues, removeUndefined, booleanFlag } from '../shared/util.js';
import { bridgeRequest } from '../http/index.js';

/**
 * `market <mint>` — combined token snapshot (price + metadata + OHLCV + safety).
 *   --mints <m1 m2 ...>      multi-mint batch
 *   --with-metadata          include token metadata
 *   --with-ohlcv             include OHLCV bars
 *   --with-price-volume      include price-volume window
 *   --with-liquidity         include liquidity stats
 *   --no-price               omit price (default includes price)
 */
export async function dispatchMarket(parsed: ParsedArgs): Promise<unknown> {
  const mint = parsed.positionals[1] ?? optionValue(parsed.positionals, '--mint');
  const mints = optionValues(parsed.positionals, '--mints');
  if (!mint && mints.length === 0) {
    throw new Error('Usage: solana-agent-wallet market <mint> [--mints mint1 mint2 ...] [--with-metadata] [--with-ohlcv] [--with-price-volume] [--with-liquidity] [--no-price]');
  }
  const noPrice = booleanFlag(parsed.positionals, '--no-price');
  const body = removeUndefined({
    mint,
    mints: mints.length > 0 ? mints : undefined,
    includePrice: noPrice ? false : true,
    includeMetadata: booleanFlag(parsed.positionals, '--with-metadata') ? true : undefined,
    includeOhlcv: booleanFlag(parsed.positionals, '--with-ohlcv') ? true : undefined,
    includePriceVolume: booleanFlag(parsed.positionals, '--with-price-volume') ? true : undefined,
    includeLiquidity: booleanFlag(parsed.positionals, '--with-liquidity') ? true : undefined,
  });
  return bridgeRequest(parsed.options, '/bridge/action/market-data', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function dispatchTokens(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'search';
  if (sub === 'search') {
    const query = parsed.positionals.slice(2).filter((p) => !p.startsWith('--')).join(' ');
    if (!query) {
      throw new Error('Usage: solana-agent-wallet tokens search <query>');
    }
    return bridgeRequest(parsed.options, '/bridge/action/token-lists', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  }
  if (sub === 'safety') {
    const mint = parsed.positionals[2];
    if (!mint) throw new Error('Usage: solana-agent-wallet tokens safety <mint>');
    return bridgeRequest(parsed.options, '/bridge/action/token-safety-evidence', {
      method: 'POST',
      body: JSON.stringify({ mint }),
    });
  }
  throw new Error(`Unknown tokens subcommand: ${sub}. Try: search | safety`);
}
