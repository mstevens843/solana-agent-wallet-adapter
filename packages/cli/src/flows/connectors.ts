import process from 'node:process';

import type { GlobalOptions } from '../shared/types.js';
import { renderWebRequest, bridgeRequest } from '../http/index.js';
import { select, confirm, password, input, header, kv, badge, spinner, divider } from '../tui/index.js';
import { listConnectors, listActions, humanizeActionKind, type ConnectorSummary } from '../forms/connectorMeta.js';

type Action = 'view' | 'set-key' | 'remove-key' | 'toggle' | 'test' | 'back';

export async function runConnectorsMenu(options: GlobalOptions): Promise<void> {
  while (true) {
    const connectors = listConnectors();
    const installedKeys = await safeListInstalledKeys(options);
    const enabled = await safeFetchEnabledMap(options);

    console.log();
    console.log(header('Connectors'));
    console.log(badge(`${connectors.length} protocols configured · ${installedKeys.size} BYO keys stored`, 'muted'));

    const choice = await select<string>({
      message: 'Pick a connector to manage',
      pageSize: Math.min(22, connectors.length + 1),
      choices: [
        ...connectors.map((c, i) => ({
          name: rowLabel(i, c, installedKeys.has(c.id), enabled.get(c.id) ?? true),
          value: c.id,
        })),
        { name: '← Back to main menu', value: '__back__' },
      ],
    });
    if (choice === '__back__') return;

    const connector = connectors.find((c) => c.id === choice);
    if (!connector) continue;
    await manageConnector(options, connector, installedKeys.has(connector.id), enabled.get(connector.id) ?? true);
  }
}

function rowLabel(index: number, c: ConnectorSummary, keyInstalled: boolean, isEnabled: boolean): string {
  const id = String(index + 1).padStart(2, ' ');
  const onOff = isEnabled ? badge('● on', 'ok') : badge('○ off', 'muted');
  const keyChip = c.needsKey
    ? keyInstalled
      ? badge('key set', 'ok')
      : badge('needs key', 'warn')
    : badge('no key needed', 'muted');
  return `${id}.  ${onOff}  ${c.name.padEnd(18)}  ${keyChip}  ${badge(`${c.actionCount} actions`, 'muted')}`;
}

async function manageConnector(
  options: GlobalOptions,
  connector: ConnectorSummary,
  keyInstalled: boolean,
  isEnabled: boolean,
): Promise<void> {
  console.log();
  console.log(header(connector.name));
  const rows: Array<[string, string]> = [
    ['Slug', connector.id],
    ['Status', connector.status],
    ['Enabled in agent', isEnabled ? badge('yes', 'ok') : badge('no', 'muted')],
    ['Actions', String(connector.actionCount)],
    ['BYO key', connector.needsKey ? (keyInstalled ? badge('configured', 'ok') : badge('missing', 'warn')) : badge('not required', 'muted')],
    ['Recurring', connector.recurringCapable ? badge('supported', 'ok') : badge('not supported', 'muted')],
  ];
  if (connector.keyLabel) rows.push(['Key', connector.keyLabel]);
  console.log(kv(rows));

  const choices: Array<{ name: string; value: Action; description?: string }> = [
    { name: 'View supported actions', value: 'view' },
    { name: isEnabled ? 'Disable in agent' : 'Enable in agent', value: 'toggle' },
  ];
  if (connector.needsKey) {
    choices.push({ name: keyInstalled ? 'Replace API key' : 'Set API key', value: 'set-key' });
    if (keyInstalled) choices.push({ name: 'Remove API key', value: 'remove-key' });
    choices.push({ name: 'Test connector', value: 'test' });
  } else {
    choices.push({ name: 'Test connector (read markets)', value: 'test' });
  }
  choices.push({ name: '← Back', value: 'back' });

  const action = await select<Action>({ message: 'What next?', choices });
  if (action === 'back') return;
  if (action === 'view') {
    const actions = listActions(connector.id);
    console.log();
    console.log(header(`${connector.name} — implemented actions`));
    for (const a of actions) {
      console.log(`  · ${humanizeActionKind(a.actionKind, connector.id)}  ${badge(a.actionKind, 'muted')}`);
    }
    console.log(divider());
    return;
  }
  if (action === 'toggle') {
    await toggleEnabled(options, connector, !isEnabled);
    return;
  }
  if (action === 'set-key') {
    await setApiKey(options, connector);
    return;
  }
  if (action === 'remove-key') {
    const yes = await confirm({ message: `Remove ${connector.name} API key?`, default: false });
    if (!yes) return;
    const spin = spinner(`Removing ${connector.keyLabel ?? 'key'}…`);
    try {
      await renderWebRequest(options, `/api/connector-secrets/${encodeURIComponent(connector.id)}`, {
        method: 'DELETE',
      }, { label: 'Render-web connector secrets', requireAuth: true });
      spin.succeed(`${connector.keyLabel ?? 'Key'} removed.`);
    } catch (err) {
      spin.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (action === 'test') {
    await testConnector(options, connector);
    return;
  }
}

// Reads /api/preferences/protocol-connectors and returns a map of
// connectorId → enabled. Missing keys default to enabled (the web app's
// default behaviour).
async function safeFetchEnabledMap(options: GlobalOptions): Promise<Map<string, boolean>> {
  try {
    const raw = await renderWebRequest<unknown>(options, '/api/preferences/protocol-connectors', undefined, {
      label: 'Render-web preferences',
      requireAuth: true,
    });
    const map = new Map<string, boolean>();
    const payload = extractPrefsPayload(raw);
    for (const [id, value] of Object.entries(payload)) {
      if (value && typeof value === 'object' && 'enabled' in (value as Record<string, unknown>)) {
        map.set(id, Boolean((value as { enabled?: boolean }).enabled));
      } else if (typeof value === 'boolean') {
        map.set(id, value);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function extractPrefsPayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const payload = (raw as Record<string, unknown>).payload;
    if (payload && typeof payload === 'object') return payload as Record<string, unknown>;
    return raw as Record<string, unknown>;
  }
  return {};
}

async function toggleEnabled(options: GlobalOptions, connector: ConnectorSummary, nextEnabled: boolean): Promise<void> {
  const spin = spinner(`${nextEnabled ? 'Enabling' : 'Disabling'} ${connector.name}…`);
  try {
    const raw = await renderWebRequest<unknown>(options, '/api/preferences/protocol-connectors', undefined, {
      label: 'Render-web preferences',
      requireAuth: true,
    }).catch(() => null);
    const payload = extractPrefsPayload(raw);
    const existing = payload[connector.id];
    const merged: Record<string, unknown> = {
      ...payload,
      [connector.id]: existing && typeof existing === 'object'
        ? { ...(existing as Record<string, unknown>), enabled: nextEnabled }
        : { enabled: nextEnabled },
    };
    await renderWebRequest(options, '/api/preferences/protocol-connectors', {
      method: 'PUT',
      body: JSON.stringify({ payload: merged }),
    }, { label: 'Render-web preferences', requireAuth: true });
    spin.succeed(`${connector.name} ${nextEnabled ? 'enabled' : 'disabled'} in agent.`);
  } catch (err) {
    spin.fail(`Toggle failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log(badge('Tip: run /sign-in first to authenticate with the cloud workspace.', 'muted'));
  }
}

async function setApiKey(options: GlobalOptions, connector: ConnectorSummary): Promise<void> {
  const label = connector.keyLabel ?? 'API key';
  console.log();
  console.log(badge(`Pasting a ${label} stores it encrypted in cloud preferences (requires sign-in).`, 'muted'));

  // Prefer reading from an env var to keep secrets out of shell history when
  // the user has one set. Fall back to a masked password prompt.
  const fromEnv = connector.envVar && process.env[connector.envVar]
    ? await confirm({ message: `Use the value of ${connector.envVar}?`, default: true })
    : false;
  const apiKey = fromEnv && connector.envVar
    ? process.env[connector.envVar]!
    : await password({ message: `${label}:` });
  if (!apiKey.trim()) {
    console.log(badge('Aborted — empty key.', 'warn'));
    return;
  }
  const labelInput = await input({
    message: 'Label for this key (optional)',
    default: '',
  });
  const body: Record<string, string> = { apiKey: apiKey.trim() };
  if (labelInput.trim()) body.label = labelInput.trim();
  const spin = spinner(`Saving ${label}…`);
  try {
    await renderWebRequest(options, `/api/connector-secrets/${encodeURIComponent(connector.id)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, { label: 'Render-web connector secrets', requireAuth: true });
    spin.succeed(`${label} saved.`);
  } catch (err) {
    spin.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log(badge('Tip: run /sign-in first to authenticate with the cloud workspace.', 'muted'));
  }
}

async function testConnector(options: GlobalOptions, connector: ConnectorSummary): Promise<void> {
  const spin = spinner(`Probing ${connector.name}…`);
  try {
    const result = await bridgeRequest(options, '/bridge/action/connector-read-facts', {
      method: 'POST',
      body: JSON.stringify({ connectorId: connector.id, capability: 'markets' }),
    });
    spin.succeed('Read OK.');
    console.log(divider());
    console.log(JSON.stringify(result, null, 2).slice(0, 1500));
    console.log(divider());
  } catch (err) {
    spin.fail(`Read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function safeListInstalledKeys(options: GlobalOptions): Promise<Set<string>> {
  try {
    const raw = await renderWebRequest<unknown>(options, '/api/connector-secrets', undefined, {
      label: 'Render-web connector secrets',
      requireAuth: true,
    });
    const list = extractList(raw);
    return new Set(list.map((entry) => entry.connectorId).filter((id): id is string => typeof id === 'string'));
  } catch {
    // Not signed in or render-web unreachable. Render-web is optional; we
    // degrade silently and show "needs key" for everything.
    return new Set();
  }
}

function extractList(raw: unknown): Array<{ connectorId?: string }> {
  if (Array.isArray(raw)) return raw as Array<{ connectorId?: string }>;
  if (raw && typeof raw === 'object') {
    const candidate = (raw as Record<string, unknown>).secrets ?? (raw as Record<string, unknown>).items;
    if (Array.isArray(candidate)) return candidate as Array<{ connectorId?: string }>;
  }
  return [];
}
