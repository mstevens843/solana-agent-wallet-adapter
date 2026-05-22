import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';
import { kv, badge } from '../tui/index.js';

interface BalanceTokenRow {
  symbol?: string;
  amount?: string | number;
  mint?: string;
  decimals?: number;
}

interface BalanceResponse {
  address?: string;
  sol?: string | number;
  tokens?: BalanceTokenRow[];
}

// Returns kv-ready rows: SOL always, plus the requested SPL token if held.
// Designed to fail soft — if the bridge can't be reached or the wallet has no
// balance, returns an empty array and the caller skips the preview header.
export async function fetchBalanceLines(
  options: GlobalOptions,
  focusToken?: string,
): Promise<Array<[string, string]>> {
  try {
    const balances = await bridgeRequest<BalanceResponse>(options, '/bridge/action/balances');
    const rows: Array<[string, string]> = [];
    if (balances.sol !== undefined) {
      rows.push(['SOL', `${balances.sol} SOL`]);
    }
    const tokens = Array.isArray(balances.tokens) ? balances.tokens : [];
    if (focusToken) {
      const norm = focusToken.trim().toUpperCase();
      const match = tokens.find(
        (t) => (typeof t.symbol === 'string' && t.symbol.toUpperCase() === norm)
            || (typeof t.mint === 'string' && t.mint === focusToken.trim()),
      );
      if (match) {
        rows.push([match.symbol ?? norm, `${match.amount ?? '0'} ${match.symbol ?? norm}`]);
      } else if (norm !== 'SOL') {
        rows.push([norm, badge('not held', 'muted')]);
      }
    }
    return rows;
  } catch {
    return [];
  }
}

export function printBalanceHeader(rows: Array<[string, string]>): void {
  if (rows.length === 0) return;
  console.log(badge('Your balance', 'muted'));
  console.log(kv(rows));
  console.log();
}
