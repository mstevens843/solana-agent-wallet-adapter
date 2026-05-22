/**
 * Helius cloud passthrough — separate from the bridge-routed `helius-history`
 * top-level command. Uses /api/helius/transfers-by-address when the user wants
 * the cloud rate-limited path (e.g. for environments without a local bridge).
 *
 * Subcommands:
 *   helius cloud-transfers <wallet> [--limit N] [--direction in|out|any]
 *   helius local-transfers <wallet>          (alias of `helius-history`)
 */
import type { ParsedArgs } from '../shared/types.js';
import { optionValue, removeUndefined, resolveWalletAddress } from '../shared/util.js';
import { renderWebRequest } from '../http/index.js';

export async function dispatchHeliusGroup(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'help';
  if (sub === 'cloud-transfers' || sub === 'transfers') {
    const wallet = parsed.positionals[2] ?? resolveWalletAddress(parsed.positionals);
    if (!wallet) {
      throw new Error('Usage: solana-agent-wallet helius cloud-transfers <wallet> [--limit N] [--direction in|out|any]');
    }
    const limit = optionValue(parsed.positionals, '--limit');
    const direction = optionValue(parsed.positionals, '--direction');
    if (direction !== undefined && !['in', 'out', 'any'].includes(direction)) {
      throw new Error('--direction must be in, out, or any.');
    }
    const body = removeUndefined({
      address: wallet,
      limit: limit ? Number(limit) : undefined,
      direction,
    });
    return renderWebRequest(parsed.options, '/api/helius/transfers-by-address', {
      method: 'POST',
      body: JSON.stringify(body),
    }, { label: 'Helius cloud', requireAuth: true });
  }
  throw new Error(`Unknown helius subcommand: ${sub}. Try: cloud-transfers <wallet>. (For bridge-routed history use the top-level "helius-history" command.)`);
}
