/**
 * Solana RPC proxies. Both the bridge and render-web expose the same set:
 *   bridge: /bridge/solana/{latest-blockhash, send-transaction, signature-status}
 *   cloud:  /api/solana/{latest-blockhash, send-transaction, signature-status,
 *                        parsed-account-info}
 *
 * The hosted render-web API is the default path so installed CLIs use the same
 * Agentic-managed RPC as the web and desktop apps. The local bridge remains a
 * BYOK/offline fallback when hosted calls fail.
 */
import type { GlobalOptions, ParsedArgs } from '../shared/types.js';
import { optionValue, removeUndefined } from '../shared/util.js';
import { renderWebRequest, tryBridgeRequest } from '../http/index.js';

export async function dispatchSolana(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1];
  switch (sub) {
    case 'blockhash':
    case 'latest-blockhash':
      return callHostedFirst(parsed.options, '/solana/latest-blockhash', {
        method: 'POST',
        body: JSON.stringify({ cluster: cluster(parsed) }),
      });
    case 'send-tx':
    case 'send-transaction': {
      const tx = parsed.positionals[2] ?? optionValue(parsed.positionals, '--tx');
      if (!tx) throw new Error('Usage: solana-agent-wallet solana send-tx <base64-signed-transaction>');
      return callHostedFirst(parsed.options, '/solana/send-transaction', {
        method: 'POST',
        body: JSON.stringify({ signedTransactionBase64: tx, transaction: tx, cluster: cluster(parsed) }),
      });
    }
    case 'tx-status':
    case 'signature-status': {
      const sig = parsed.positionals[2] ?? optionValue(parsed.positionals, '--signature');
      if (!sig) throw new Error('Usage: solana-agent-wallet solana tx-status <signature>');
      return callHostedFirst(parsed.options, '/solana/signature-status', {
        method: 'POST',
        body: JSON.stringify({ signature: sig, cluster: cluster(parsed) }),
      });
    }
    case 'account-info':
    case 'parsed-account-info': {
      const address = parsed.positionals[2] ?? optionValue(parsed.positionals, '--address');
      if (!address) throw new Error('Usage: solana-agent-wallet solana account-info <address>');
      const body = removeUndefined({
        address,
        cluster: cluster(parsed),
        commitment: optionValue(parsed.positionals, '--commitment'),
      });
      return renderWebRequest(parsed.options, '/api/solana/parsed-account-info', {
        method: 'POST',
        body: JSON.stringify(body),
      }, { label: 'Solana RPC (hosted)' });
    }
    default:
      return {
        command: 'solana',
        subcommands: ['blockhash', 'send-tx <base64>', 'tx-status <sig>', 'account-info <addr>'],
      };
  }
}

async function callHostedFirst(
  options: GlobalOptions,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  try {
    return await renderWebRequest(options, `/api${path}`, init, {
      label: 'Solana RPC (hosted)',
    });
  } catch (err) {
    const bridgeResult = await tryBridgeRequest<unknown>(options, `/bridge${path}`, init);
    if (bridgeResult.ok) return bridgeResult.value;
    throw err;
  }
}

function cluster(parsed: ParsedArgs): string {
  return optionValue(parsed.positionals, '--cluster') ?? 'mainnet-beta';
}
