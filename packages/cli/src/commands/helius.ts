/**
 * `helius-history <wallet>` — recent activity via /bridge/action/helius-history.
 *
 * The bridge expects { operation, address, ... } where operation selects what
 * shape of history to return. Defaults to `transfers_by_address` to mirror the
 * common user intent ("show me transfers in/out of this wallet").
 *
 *   --operation <op>        transaction_history | transfers_by_address | parse_transactions | ...
 *   --limit <n>             max items returned
 *   --direction in|out|any  filter direction (transfers_by_address only)
 *   --mint <mint>           filter by token mint
 *   --with <addr>           filter by counterparty
 */
import type { ParsedArgs } from '../shared/types.js';
import { optionValue, removeUndefined } from '../shared/util.js';
import { bridgeRequest } from '../http/index.js';

const KNOWN_OPS = new Set([
  'transaction_history',
  'parse_transactions',
  'recent_mint_txs',
  'transfers_by_address',
  'mint_creation',
  'has_history_before',
  'authority',
]);

export async function dispatchHeliusHistory(parsed: ParsedArgs): Promise<unknown> {
  const wallet = parsed.positionals[1]
    ?? optionValue(parsed.positionals, '--wallet')
    ?? optionValue(parsed.positionals, '--address')
    ?? process.env.AGENTIC_WALLET_ADDRESS;
  if (!wallet) {
    throw new Error('Usage: solana-agent-wallet helius-history <wallet> [--operation transfers_by_address] [--limit 25] [--direction in|out|any] [--mint <mint>] [--with <addr>]');
  }
  const operation = optionValue(parsed.positionals, '--operation') ?? 'transfers_by_address';
  if (!KNOWN_OPS.has(operation)) {
    throw new Error(`--operation must be one of: ${[...KNOWN_OPS].join(', ')}`);
  }
  const limitRaw = optionValue(parsed.positionals, '--limit');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > 1000)) {
    throw new Error('--limit must be a positive integer ≤ 1000.');
  }
  const direction = optionValue(parsed.positionals, '--direction');
  if (direction !== undefined && !['in', 'out', 'any'].includes(direction)) {
    throw new Error('--direction must be in, out, or any.');
  }
  const body = removeUndefined({
    operation,
    address: wallet,
    limit,
    direction,
    mint: optionValue(parsed.positionals, '--mint'),
    with: optionValue(parsed.positionals, '--with'),
    source: optionValue(parsed.positionals, '--source'),
    type: optionValue(parsed.positionals, '--type'),
  });
  return bridgeRequest(parsed.options, '/bridge/action/helius-history', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
