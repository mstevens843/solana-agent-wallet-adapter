/**
 * Birdeye market-data CLI surface.
 *
 * The hosted render-web API is the default path so CLI users get the same
 * Agentic-managed BirdEye access as the web and desktop apps. The local bridge
 * remains a fallback for users running BYOK/offline development.
 *
 * Endpoints (15 total, verified against bridgeServer.ts):
 *   price-multi, price-volume, history-price, ohlcv, search, token-meta,
 *   token-security, token-holders, token-creation-info, exit-liquidity-multi,
 *   trending, new-listings, token-list-v3, wallet-token-list, ws-snapshot
 */
import type { GlobalOptions, ParsedArgs } from '../shared/types.js';
import {
  optionValue,
  optionValues,
  readJsonFile,
  removeUndefined,
  resolveWalletAddress,
} from '../shared/util.js';
import { renderWebRequest, tryBridgeRequest } from '../http/index.js';

const KNOWN_SUBS = new Set([
  'price-multi',
  'price-volume',
  'history-price',
  'ohlcv',
  'search',
  'token-meta',
  'token-security',
  'token-holders',
  'token-creation-info',
  'exit-liquidity-multi',
  'trending',
  'new-listings',
  'token-list-v3',
  'wallet-token-list',
  'ws-snapshot',
]);

export async function dispatchBirdeye(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1];
  if (!sub || !KNOWN_SUBS.has(sub)) {
    return {
      command: 'birdeye',
      subcommands: [...KNOWN_SUBS],
      hint: 'e.g. solana-agent-wallet birdeye search --query SOL',
    };
  }
  const body = await buildBirdeyeBody(sub, parsed);
  return callBirdeye(parsed.options, sub, body);
}

async function buildBirdeyeBody(sub: string, parsed: ParsedArgs): Promise<Record<string, unknown>> {
  const opt = (flag: string) => optionValue(parsed.positionals, flag);
  const file = opt('--body');
  if (file) {
    return readJsonFile<Record<string, unknown>>(file, 'birdeye body');
  }
  // Common flag wiring; commands that don't accept these just ignore them.
  const mint = parsed.positionals[2] ?? opt('--mint');
  const mints = optionValues(parsed.positionals, '--mints');
  const query = opt('--query') ?? parsed.positionals[2];
  switch (sub) {
    case 'price-multi':
    case 'exit-liquidity-multi':
      if (mints.length === 0 && !mint) {
        throw new Error(`Usage: solana-agent-wallet birdeye ${sub} --mints <m1 m2 ...>`);
      }
      return removeUndefined({ mints: mints.length > 0 ? mints : [mint] });
    case 'search':
      if (!query) throw new Error('Usage: solana-agent-wallet birdeye search <query>');
      return { query };
    case 'wallet-token-list': {
      const wallet = resolveWalletAddress(parsed.positionals);
      if (!wallet) throw new Error('Usage: solana-agent-wallet birdeye wallet-token-list --wallet <addr>');
      return { walletAddress: wallet };
    }
    case 'price-volume':
    case 'history-price':
    case 'ohlcv':
    case 'token-meta':
    case 'token-security':
    case 'token-holders':
    case 'token-creation-info':
      if (!mint) throw new Error(`Usage: solana-agent-wallet birdeye ${sub} <mint>`);
      return removeUndefined({
        mint,
        type: opt('--type'),
        from: opt('--from'),
        to: opt('--to'),
        offset: opt('--offset'),
        limit: opt('--limit'),
      });
    case 'trending':
    case 'new-listings':
    case 'token-list-v3':
    case 'ws-snapshot':
      return removeUndefined({
        sortBy: opt('--sort-by'),
        sortType: opt('--sort-type'),
        offset: opt('--offset'),
        limit: opt('--limit'),
        // Pass --body for advanced body shapes; otherwise an empty body is fine.
      });
    default:
      return {};
  }
}

async function callBirdeye(
  options: GlobalOptions,
  sub: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const path = `/birdeye/${sub}`;
  try {
    return await renderWebRequest(options, `/api${path}`, {
      method: 'POST',
      body: JSON.stringify(cloudBirdeyeBody(sub, body)),
    }, { label: 'BirdEye (hosted)', requireAuth: sub === 'wallet-token-list' });
  } catch (err) {
    const bridgeResult = await tryBridgeRequest<unknown>(
      options,
      `/bridge${path}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (bridgeResult.ok) return bridgeResult.value;
    throw err;
  }
}

function cloudBirdeyeBody(sub: string, body: Record<string, unknown>): Record<string, unknown> {
  if (sub === 'price-multi' || sub === 'exit-liquidity-multi') {
    return {
      ...body,
      addresses: Array.isArray(body.mints) ? body.mints : body.mints === undefined ? body.addresses : [body.mints],
    };
  }
  if (sub === 'search') {
    return {
      ...body,
      keyword: body.keyword ?? body.query,
    };
  }
  if (
    sub === 'price-volume'
    || sub === 'history-price'
    || sub === 'ohlcv'
    || sub === 'token-meta'
    || sub === 'token-security'
    || sub === 'token-holders'
    || sub === 'token-creation-info'
  ) {
    const needsAddressList = sub === 'token-meta';
    return {
      ...body,
      address: body.address ?? body.mint,
      addresses: body.addresses ?? (needsAddressList && body.mint !== undefined ? [body.mint] : undefined),
      timeFrom: body.timeFrom ?? body.from,
      timeTo: body.timeTo ?? body.to,
    };
  }
  return body;
}
