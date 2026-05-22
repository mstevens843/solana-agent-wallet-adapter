/**
 * Local bridge agent token management — distinct from the cloud A2A
 * `profile publish` flow. These are short-lived access tokens issued by the
 * local bridge so agents (e.g. a Claude tool-use loop) can authenticate to
 * the bridge HTTP surface without leaking the master BRIDGE_TOKEN.
 *
 *   GET  /bridge/agents                    list registered agents
 *   POST /bridge/agents                    {name, description?} register
 *   POST /bridge/agents/issue              {agentId, ttlSeconds?} issue token
 *   POST /bridge/agents/delete             {agentId} revoke
 */
import type { ParsedArgs } from '../shared/types.js';
import { optionValue, removeUndefined } from '../shared/util.js';
import { bridgeRequest } from '../http/index.js';

export async function dispatchBridgeAgents(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'list';

  if (sub === 'list') {
    return bridgeRequest(parsed.options, '/bridge/agents');
  }
  if (sub === 'register') {
    const name = optionValue(parsed.positionals, '--name') ?? parsed.positionals[2];
    if (!name) throw new Error('Usage: solana-agent-wallet bridge-agents register --name <agent-name> [--description <text>]');
    const body = removeUndefined({
      name,
      description: optionValue(parsed.positionals, '--description'),
    });
    return bridgeRequest(parsed.options, '/bridge/agents', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  if (sub === 'issue') {
    const agentId = parsed.positionals[2];
    if (!agentId) throw new Error('Usage: solana-agent-wallet bridge-agents issue <agent-id> [--ttl-seconds N]');
    const ttlRaw = optionValue(parsed.positionals, '--ttl-seconds');
    const ttlSeconds = ttlRaw ? Number(ttlRaw) : undefined;
    if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0)) {
      throw new Error('--ttl-seconds must be a positive integer.');
    }
    return bridgeRequest(parsed.options, '/bridge/agents/issue', {
      method: 'POST',
      body: JSON.stringify(removeUndefined({ agentId, ttlSeconds })),
    });
  }
  if (sub === 'delete' || sub === 'revoke') {
    const agentId = parsed.positionals[2];
    if (!agentId) throw new Error('Usage: solana-agent-wallet bridge-agents delete <agent-id>');
    return bridgeRequest(parsed.options, '/bridge/agents/delete', {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    });
  }
  throw new Error(`Unknown bridge-agents subcommand: ${sub}. Try: list | register | issue | delete`);
}
