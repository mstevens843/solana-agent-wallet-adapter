/**
 * CoinGecko market-data CLI surface.
 *
 * Endpoints (verified against bridgeServer.ts + router.ts):
 *   GET /bridge/coingecko/endpoints          | GET /api/coingecko/endpoints
 *   GET /bridge/coingecko/global             | GET /api/coingecko/global
 *   POST /bridge/coingecko/read              | POST /api/coingecko/read
 *   POST /bridge/coingecko/token-evidence    | POST /api/coingecko/token-evidence
 */
import type { GlobalOptions, ParsedArgs } from '../shared/types.js';
import { optionValue, readJsonFile, removeUndefined } from '../shared/util.js';
import { renderWebRequest, tryBridgeRequest } from '../http/index.js';

const KNOWN_SUBS = new Set(['endpoints', 'global', 'read', 'token-evidence']);

export async function dispatchCoingecko(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1];
  if (!sub || !KNOWN_SUBS.has(sub)) {
    return { command: 'coingecko', subcommands: [...KNOWN_SUBS] };
  }
  const isGet = sub === 'endpoints' || sub === 'global';
  if (isGet) {
    return callCoingecko(parsed.options, sub, 'GET');
  }
  // POST: read and token-evidence accept either --body file or a few common
  // flags directly.
  const body = await buildCoingeckoBody(sub, parsed);
  return callCoingecko(parsed.options, sub, 'POST', body);
}

async function buildCoingeckoBody(
  sub: string,
  parsed: ParsedArgs,
): Promise<Record<string, unknown>> {
  const file = optionValue(parsed.positionals, '--body');
  if (file) return readJsonFile<Record<string, unknown>>(file, 'coingecko body');
  if (sub === 'read') {
    const endpoint = optionValue(parsed.positionals, '--endpoint') ?? parsed.positionals[2];
    if (!endpoint) {
      throw new Error('Usage: solana-agent-wallet coingecko read <endpoint> [--params <json-file>]');
    }
    const paramsFile = optionValue(parsed.positionals, '--params');
    const params = paramsFile ? await readJsonFile(paramsFile, 'params') : undefined;
    return removeUndefined({ endpoint, params });
  }
  if (sub === 'token-evidence') {
    const mint = parsed.positionals[2] ?? optionValue(parsed.positionals, '--mint');
    if (!mint) throw new Error('Usage: solana-agent-wallet coingecko token-evidence <mint>');
    return { mint };
  }
  return {};
}

async function callCoingecko(
  options: GlobalOptions,
  sub: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<unknown> {
  const bridgePath = `/bridge/coingecko/${sub}`;
  const cloudPath = `/api/coingecko/${sub}`;
  const init: RequestInit = method === 'POST'
    ? { method, body: JSON.stringify(body ?? {}) }
    : { method };
  try {
    return await renderWebRequest(options, cloudPath, init, { label: 'CoinGecko (hosted)' });
  } catch (err) {
    const bridgeResult = await tryBridgeRequest<unknown>(options, bridgePath, init);
    if (bridgeResult.ok) return bridgeResult.value;
    throw err;
  }
}
