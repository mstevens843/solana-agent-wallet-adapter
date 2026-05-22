/**
 * Cloud preferences + BYO connector API keys.
 *
 * Endpoints (verified against apps/render-web/src/cloud/router.ts + store.ts):
 *   GET  /api/preferences                       — list ALL preference namespaces
 *   GET  /api/preferences/<namespace>           — fetch one namespace
 *   PUT  /api/preferences/<namespace>           — replace one namespace's payload
 *   GET  /api/connector-secrets                 — list installed secret connectors
 *   POST /api/connector-secrets/<connectorId>   {apiKey, label?}
 *   DELETE /api/connector-secrets/<connectorId>
 *
 * Note: `agent-payment-profile` is a read-only mirror in the prefs system;
 * writes flow through `solana-agent-wallet profile publish` instead.
 *
 *   solana-agent-wallet prefs show
 *   solana-agent-wallet prefs get <namespace>
 *   solana-agent-wallet prefs set <namespace> --file <payload.json>
 *   solana-agent-wallet prefs agent-policies show|set --file policies.json
 *   solana-agent-wallet prefs connector-keys list
 *   solana-agent-wallet prefs connector-keys set <connector> --from-env <VAR> [--label <name>]
 *   solana-agent-wallet prefs connector-keys remove <connector>
 *   solana-agent-wallet prefs connector-keys test <connector> [--wallet <addr>] [--capability <c>]
 */
import process from 'node:process';

import type { ParsedArgs } from '../shared/types.js';
import { optionValue, readJsonFile, removeUndefined, resolveWalletAddress } from '../shared/util.js';
import { renderWebRequest, bridgeRequest } from '../http/index.js';

const KNOWN_NAMESPACES = new Set([
  'agent-policies',
  'protocol-connectors',
  'protocol-connector-secrets',
  'safety-rails',
  'failure-policies',
  'custom-tokens',
  'ai-settings',
  'agent-payment-profile',
  'mpp-config',
]);

// agent-payment-profile is read-only from the preferences API; writes go
// through `profile publish` which handles the SIWS-signed envelope.
const READONLY_NAMESPACES = new Set(['agent-payment-profile']);

export async function dispatchPrefs(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'show';

  if (sub === 'show' || sub === 'list') {
    return renderWebRequest(parsed.options, '/api/preferences', undefined, {
      label: 'Render-web preferences',
      requireAuth: true,
    });
  }

  if (sub === 'get') {
    const namespace = parsed.positionals[2];
    if (!namespace || !KNOWN_NAMESPACES.has(namespace)) {
      throw new Error(`Usage: solana-agent-wallet prefs get <namespace>. Known: ${[...KNOWN_NAMESPACES].join(', ')}`);
    }
    return renderWebRequest(parsed.options, `/api/preferences/${encodeURIComponent(namespace)}`, undefined, {
      label: 'Render-web preferences',
      requireAuth: true,
    });
  }

  if (sub === 'set') {
    const namespace = parsed.positionals[2];
    if (!namespace || !KNOWN_NAMESPACES.has(namespace)) {
      throw new Error(`Usage: solana-agent-wallet prefs set <namespace> --file <payload.json>. Known namespaces: ${[...KNOWN_NAMESPACES].join(', ')}`);
    }
    if (READONLY_NAMESPACES.has(namespace)) {
      throw new Error(`Namespace "${namespace}" is read-only via prefs. Use "solana-agent-wallet profile publish <agent-card.json>" instead.`);
    }
    return setPreferenceFromFile(parsed, namespace);
  }

  // Convenience shorthand: `prefs <namespace> show|set --file ...`
  if (KNOWN_NAMESPACES.has(sub)) {
    const op = parsed.positionals[2] ?? 'show';
    if (op === 'show' || op === 'get') {
      return renderWebRequest(parsed.options, `/api/preferences/${encodeURIComponent(sub)}`, undefined, {
        label: 'Render-web preferences',
        requireAuth: true,
      });
    }
    if (op === 'set') {
      if (READONLY_NAMESPACES.has(sub)) {
        throw new Error(`Namespace "${sub}" is read-only via prefs. Use "solana-agent-wallet profile publish <agent-card.json>" instead.`);
      }
      return setPreferenceFromFile(parsed, sub);
    }
    throw new Error(`Unknown prefs ${sub} subcommand: ${op}. Try: show | set --file <payload.json>`);
  }

  if (sub === 'connector-keys') {
    return dispatchConnectorKeys(parsed);
  }

  throw new Error(`Unknown prefs subcommand: ${sub}. Try: show | get <namespace> | set <namespace> --file <payload.json> | <namespace> show/set | connector-keys`);
}

async function setPreferenceFromFile(parsed: ParsedArgs, namespace: string): Promise<unknown> {
  const file = optionValue(parsed.positionals, '--file');
  if (!file) {
    throw new Error(`Usage: solana-agent-wallet prefs set ${namespace} --file <payload.json>`);
  }
  const payload = await readJsonFile(file, 'preferences payload');
  return renderWebRequest(parsed.options, `/api/preferences/${encodeURIComponent(namespace)}`, {
    method: 'PUT',
    body: JSON.stringify({ payload }),
  }, { label: 'Render-web preferences', requireAuth: true });
}

async function dispatchConnectorKeys(parsed: ParsedArgs): Promise<unknown> {
  const op = parsed.positionals[2] ?? 'list';
  if (op === 'list') {
    return renderWebRequest(parsed.options, '/api/connector-secrets', undefined, {
      label: 'Render-web connector secrets',
      requireAuth: true,
    });
  }
  if (op === 'set') {
    const connector = parsed.positionals[3];
    if (!connector) {
      throw new Error('Usage: solana-agent-wallet prefs connector-keys set <connector> --from-env <VAR> [--label <name>]');
    }
    const envVar = optionValue(parsed.positionals, '--from-env');
    const label = optionValue(parsed.positionals, '--label');
    if (!envVar) {
      throw new Error('Pass --from-env <VAR> (with the secret already in that env var). Inline --value is rejected to keep secrets out of shell history.');
    }
    const apiKey = process.env[envVar];
    if (!apiKey) throw new Error(`Env var ${envVar} is empty or undefined.`);
    const body = removeUndefined({ apiKey, label });
    return renderWebRequest(parsed.options, `/api/connector-secrets/${encodeURIComponent(connector)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, { label: 'Render-web connector secrets', requireAuth: true });
  }
  if (op === 'remove') {
    const connector = parsed.positionals[3];
    if (!connector) throw new Error('Usage: solana-agent-wallet prefs connector-keys remove <connector>');
    return renderWebRequest(parsed.options, `/api/connector-secrets/${encodeURIComponent(connector)}`, {
      method: 'DELETE',
    }, { label: 'Render-web connector secrets', requireAuth: true });
  }
  if (op === 'test') {
    const connector = parsed.positionals[3];
    if (!connector) {
      throw new Error('Usage: solana-agent-wallet prefs connector-keys test <connector> [--wallet <addr>] [--capability positions|markets]');
    }
    const walletAddress = resolveWalletAddress(parsed.positionals);
    const capability = optionValue(parsed.positionals, '--capability') ?? 'markets';
    const body = removeUndefined({
      connectorId: connector,
      capability,
      walletAddress,
    });
    return bridgeRequest(parsed.options, '/bridge/action/connector-read-facts', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  throw new Error(`Unknown connector-keys subcommand: ${op}. Try: list | set | remove | test`);
}
