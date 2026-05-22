/**
 * Solana RPC proxies. Both the bridge and render-web expose the same set:
 *   bridge: /bridge/solana/{latest-blockhash, send-transaction, signature-status}
 *   cloud:  /api/solana/{latest-blockhash, send-transaction, signature-status,
 *                        parsed-account-info}
 *
 * The cloud surface adds parsed-account-info; that subcommand calls render-web
 * directly. The other three try the bridge first (no auth required) and fall
 * back to render-web (auth required) when the bridge is offline.
 */
import type { GlobalOptions, ParsedArgs } from '../shared/types.js';
import { optionValue, removeUndefined } from '../shared/util.js';
import { renderWebRequest, tryBridgeRequest } from '../http/index.js';

export async function dispatchSolana(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1];
  switch (sub) {
    case 'blockhash':
    case 'latest-blockhash':
      return callBridgeFirst(parsed.options, '/solana/latest-blockhash', { method: 'POST', body: '{}' });
    case 'send-tx':
    case 'send-transaction': {
      const tx = parsed.positionals[2] ?? optionValue(parsed.positionals, '--tx');
      if (!tx) throw new Error('Usage: solana-agent-wallet solana send-tx <base64-signed-transaction>');
      return callBridgeFirst(parsed.options, '/solana/send-transaction', {
        method: 'POST',
        body: JSON.stringify({ transaction: tx }),
      });
    }
    case 'tx-status':
    case 'signature-status': {
      const sig = parsed.positionals[2] ?? optionValue(parsed.positionals, '--signature');
      if (!sig) throw new Error('Usage: solana-agent-wallet solana tx-status <signature>');
      return callBridgeFirst(parsed.options, '/solana/signature-status', {
        method: 'POST',
        body: JSON.stringify({ signature: sig }),
      });
    }
    case 'account-info':
    case 'parsed-account-info': {
      const address = parsed.positionals[2] ?? optionValue(parsed.positionals, '--address');
      if (!address) throw new Error('Usage: solana-agent-wallet solana account-info <address>');
      const body = removeUndefined({
        address,
        commitment: optionValue(parsed.positionals, '--commitment'),
      });
      // Cloud-only; no bridge equivalent for parsed-account-info.
      return renderWebRequest(parsed.options, '/api/solana/parsed-account-info', {
        method: 'POST',
        body: JSON.stringify(body),
      }, { label: 'Solana RPC (cloud)', requireAuth: true });
    }
    default:
      return {
        command: 'solana',
        subcommands: ['blockhash', 'send-tx <base64>', 'tx-status <sig>', 'account-info <addr>'],
      };
  }
}

async function callBridgeFirst(
  options: GlobalOptions,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const bridgeResult = await tryBridgeRequest<unknown>(options, `/bridge${path}`, init);
  if (bridgeResult.ok) return bridgeResult.value;
  return renderWebRequest(options, `/api${path}`, init, {
    label: 'Solana RPC (cloud)',
    requireAuth: true,
  });
}
