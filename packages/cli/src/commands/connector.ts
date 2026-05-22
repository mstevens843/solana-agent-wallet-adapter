import type { ParsedArgs } from '../shared/types.js';
import { commandValues, optionValue, optionValues, parseStringParameters, removeUndefined } from '../shared/util.js';
import { bridgeRequest } from '../http/index.js';
import { resolveAliasKind } from './prepareAliases.js';

const PREPARE_VALUE_FLAGS = new Set([
  '--note',
  '--due-at',
  '--slippage-bps',
  '--url',
  '--blink-url',
  '--connector',
  '--protocol',
  '--operation',
  '--account',
  '--expected-amount',
  '--expected-token',
  '--expected-recipient',
  '--position',
  '--parameter',
  '--param',
  '--kind',
  '--cluster',
  '--wallet',
  '--summary',
  '--capability',
]);

/**
 * Generic `prepare connector <kind>` command — wraps the bridge's existing
 * /bridge/connector/prepare-transaction endpoint to unlock every connector
 * write action via a single CLI surface.
 *
 *   solana-agent-wallet prepare connector marinade_liquid_stake \
 *     --param solAmount=0.01 --wallet <addr> --cluster mainnet-beta
 *
 * Also accepts an alias as `kind` (e.g. `marinade-stake`); the alias resolver
 * maps it to the canonical bridge kind before submitting.
 */
export async function dispatchPrepareConnector(parsed: ParsedArgs): Promise<unknown> {
  const rawArgs = commandValues(parsed.positionals.slice(2), PREPARE_VALUE_FLAGS);
  const rawKind = rawArgs[0] ?? optionValue(parsed.positionals, '--kind');
  if (!rawKind) {
    throw new Error('Usage: solana-agent-wallet prepare connector <kind> [--param key=value ...] [--wallet <addr>] [--cluster <name>]');
  }
  const kind = resolveAliasKind(rawKind);
  const walletAddress = optionValue(parsed.positionals, '--wallet')
    ?? process.env.AGENTIC_WALLET_ADDRESS
    ?? '';
  if (!walletAddress) {
    throw new Error('Missing wallet address. Pass --wallet <addr> or set AGENTIC_WALLET_ADDRESS.');
  }
  const cluster = (optionValue(parsed.positionals, '--cluster') ?? 'mainnet-beta');
  const summary = optionValue(parsed.positionals, '--summary');
  const params = parseStringParameters([
    ...optionValues(parsed.positionals, '--param'),
    ...optionValues(parsed.positionals, '--parameter'),
  ]);
  const body = removeUndefined({
    kind,
    params: castParams(params),
    walletAddress,
    cluster,
    summary,
  });
  return bridgeRequest(parsed.options, '/bridge/connector/prepare-transaction', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * `connector list` / `connector info <id>` — wrap the bridge's capability registry.
 * `connector read <id> <capability>` — wrap connector-read-facts.
 */
export async function dispatchConnectorGroup(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'list';
  if (sub === 'list') {
    return bridgeRequest(parsed.options, '/bridge/action/connector-capabilities');
  }
  if (sub === 'info') {
    const id = parsed.positionals[2];
    if (!id) throw new Error('Usage: solana-agent-wallet connector info <connectorId>');
    const url = `/bridge/action/connector-capabilities?connectorId=${encodeURIComponent(id)}`;
    return bridgeRequest(parsed.options, url);
  }
  if (sub === 'read') {
    const id = parsed.positionals[2];
    const capability = parsed.positionals[3] ?? optionValue(parsed.positionals, '--capability');
    if (!id) throw new Error('Usage: solana-agent-wallet connector read <connectorId> <capability> [--param key=value]');
    const params = parseStringParameters([
      ...optionValues(parsed.positionals, '--param'),
      ...optionValues(parsed.positionals, '--parameter'),
    ]);
    const walletAddress = optionValue(parsed.positionals, '--wallet') ?? process.env.AGENTIC_WALLET_ADDRESS;
    const body = removeUndefined({
      connectorId: id,
      capability,
      walletAddress,
      ...castParams(params),
    });
    return bridgeRequest(parsed.options, '/bridge/action/connector-read-facts', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  if (sub === 'prepare') {
    // Alias of `prepare connector` for nicer ergonomics.
    return dispatchPrepareConnector({
      ...parsed,
      positionals: ['prepare', 'connector', ...parsed.positionals.slice(2)],
    });
  }
  throw new Error(`Unknown connector subcommand: ${sub}. Try: list | info | read | prepare`);
}

/**
 * Some bridge params are numbers/booleans/arrays — coerce simple cases so users
 * can pass `--param limit=10` and `--param includeBids=true` from the shell.
 *
 * Decimal/amount fields are intentionally kept as strings (the bridge expects
 * stringified decimals for token amounts to avoid float precision loss). Only
 * integers and booleans are coerced. Anything else passes through unchanged.
 *
 * Users can force-quote via `--param raw=true` semantics if they need to bypass
 * coercion — wrap in quotes inside the value (`--param amount="0.5"`).
 */
function castParams(input: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === 'true') out[key] = true;
    else if (value === 'false') out[key] = false;
    else if (value.includes(',') && !value.includes(' ') && !/^[1-9A-HJ-NP-Za-km-z]{32,}$/.test(value)) {
      // Comma-separated values become arrays — but only when the value doesn't
      // look like a single base58 string (those never contain commas anyway).
      out[key] = value.split(',').map((part) => part.trim()).filter(Boolean);
    } else if (/^-?\d+$/.test(value)) {
      // Pure integers coerce to Number. Decimals stay as strings (token amount
      // precision). Negative numbers supported (e.g. negative offsets).
      const asNumber = Number(value);
      out[key] = Number.isFinite(asNumber) ? asNumber : value;
    } else {
      // Everything else — decimals, addresses, hashes, free-form text — stays
      // as the original string.
      out[key] = value;
    }
  }
  return out;
}
