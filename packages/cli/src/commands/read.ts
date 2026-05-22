/**
 * `read <connector> [capability]` — convenience entry point that hits the
 * generic /bridge/action/connector-read-facts endpoint.
 *
 * Examples:
 *   solana-agent-wallet read marinade --capability positions --param walletAddress=...
 *   solana-agent-wallet read kamino positions --wallet <addr>
 */
import type { ParsedArgs } from '../shared/types.js';
import { optionValue, optionValues, parseStringParameters, removeUndefined } from '../shared/util.js';
import { bridgeRequest } from '../http/index.js';

export async function dispatchRead(parsed: ParsedArgs): Promise<unknown> {
  const connectorId = parsed.positionals[1];
  if (!connectorId) {
    throw new Error('Usage: solana-agent-wallet read <connectorId> [capability] [--wallet <addr>] [--param key=value]');
  }
  const positionalCapability = parsed.positionals[2];
  const capability = positionalCapability ?? optionValue(parsed.positionals, '--capability');
  const params = parseStringParameters([
    ...optionValues(parsed.positionals, '--param'),
    ...optionValues(parsed.positionals, '--parameter'),
  ]);
  const walletAddress = optionValue(parsed.positionals, '--wallet') ?? process.env.AGENTIC_WALLET_ADDRESS;
  const body = removeUndefined({
    connectorId,
    capability,
    walletAddress,
    ...params,
  });
  return bridgeRequest(parsed.options, '/bridge/action/connector-read-facts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
