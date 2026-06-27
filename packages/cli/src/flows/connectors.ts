import process from 'node:process';

import type { GlobalOptions } from '../shared/types.js';
import { renderWebRequest, bridgeRequest } from '../http/index.js';
import { select, confirm, password, input, header, kv, badge, spinner, divider } from '../tui/index.js';
import { listConnectors, listActions, humanizeActionKind, type ConnectorSummary } from '../forms/connectorMeta.js';
import {
  connectorSecretsForRequest,
  enabledConnectorIds,
  listInstalledConnectorKeys,
  loadConnectorState,
  removeSessionConnectorSecret,
  saveConnectorState,
  saveSessionConnectorSecret,
  setConnectorEnabled,
  type ProtocolConnectorState,
} from './connectorState.js';

type Action = 'view' | 'set-key' | 'remove-key' | 'toggle' | 'test' | 'back';

export async function runConnectorsMenu(options: GlobalOptions): Promise<void> {
  while (true) {
    const connectors = listConnectors();
    const installedKeys = await listInstalledConnectorKeys(options);
    const connectorState = await loadConnectorState(options);
    const enabled = enabledConnectorIds(connectorState);

    console.log();
    console.log(header('Connectors'));
    console.log(badge(`${enabled.size} connected · ${connectors.length} protocols configured · ${installedKeys.size} BYO keys available`, 'muted'));

    const choice = await select<string>({
      message: 'Check a connector to connect or disconnect',
      pageSize: Math.min(22, connectors.length + 2),
      choices: [
        ...connectors.map((c, i) => ({
          name: rowLabel(i, c, installedKeys.has(c.id), enabled.has(c.id)),
          value: c.id,
        })),
        { name: 'Manage connector details', value: '__manage__' },
        { name: '← Back to main menu', value: '__back__' },
      ],
    });
    if (choice === '__back__') return;
    if (choice === '__manage__') {
      await pickConnectorToManage(options, connectors, installedKeys, enabled, connectorState);
      continue;
    }

    const connector = connectors.find((c) => c.id === choice);
    if (!connector) continue;
    await toggleConnector(options, connectorState, connector, !enabled.has(connector.id), installedKeys.has(connector.id));
  }
}

function rowLabel(index: number, c: ConnectorSummary, keyInstalled: boolean, isEnabled: boolean): string {
  const id = String(index + 1).padStart(2, ' ');
  const onOff = isEnabled ? badge('[x]', 'ok') : badge('[ ]', 'muted');
  const keyChip = c.needsKey
    ? keyInstalled
      ? badge('key set', 'ok')
      : badge('needs key', 'warn')
    : badge('no key needed', 'muted');
  return `${id}.  ${onOff}  ${c.name.padEnd(18)}  ${keyChip}  ${badge(`${c.actionCount} actions`, 'muted')}`;
}

async function pickConnectorToManage(
  options: GlobalOptions,
  connectors: ConnectorSummary[],
  installedKeys: Set<string>,
  enabled: Set<string>,
  connectorState: ProtocolConnectorState,
): Promise<void> {
  const choice = await select<string>({
    message: 'Pick a connector to manage',
    pageSize: Math.min(22, connectors.length + 1),
    choices: [
      ...connectors.map((c, i) => ({
        name: rowLabel(i, c, installedKeys.has(c.id), enabled.has(c.id)),
        value: c.id,
      })),
      { name: '← Back', value: '__back__' },
    ],
  });
  if (choice === '__back__') return;
  const connector = connectors.find((c) => c.id === choice);
  if (!connector) return;
  await manageConnector(options, connector, installedKeys.has(connector.id), enabled.has(connector.id), connectorState);
}

async function manageConnector(
  options: GlobalOptions,
  connector: ConnectorSummary,
  keyInstalled: boolean,
  isEnabled: boolean,
  connectorState: ProtocolConnectorState,
): Promise<void> {
  console.log();
  console.log(header(connector.name));
  const rows: Array<[string, string]> = [
    ['Slug', connector.id],
    ['Status', connector.status],
    ['Connected', isEnabled ? badge('yes', 'ok') : badge('no', 'muted')],
    ['Actions', String(connector.actionCount)],
    ['Credential', connector.needsKey ? (keyInstalled ? badge('configured', 'ok') : badge('missing', 'warn')) : badge('not required', 'muted')],
    ['Recurring', connector.recurringCapable ? badge('supported', 'ok') : badge('not supported', 'muted')],
  ];
  if (connector.keyLabel) rows.push(['Key', connector.keyLabel]);
  console.log(kv(rows));

  const choices: Array<{ name: string; value: Action; description?: string }> = [
    { name: 'View supported actions', value: 'view' },
    { name: isEnabled ? 'Turn off' : 'Turn on', value: 'toggle' },
  ];
  if (connector.needsKey) {
    choices.push({ name: keyInstalled ? `Replace ${connector.keyLabel ?? 'credential'}` : `Set ${connector.keyLabel ?? 'credential'}`, value: 'set-key' });
    if (keyInstalled) choices.push({ name: `Remove ${connector.keyLabel ?? 'credential'}`, value: 'remove-key' });
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
    console.log(header(`${connector.name} - implemented actions`));
    for (const a of actions) {
      console.log(`  · ${humanizeActionKind(a.actionKind, connector.id)}  ${badge(a.actionKind, 'muted')}`);
    }
    console.log(divider());
    return;
  }
  if (action === 'toggle') {
    await toggleConnector(options, connectorState, connector, !isEnabled, keyInstalled);
    return;
  }
  if (action === 'set-key') {
    await setApiKey(options, connector);
    return;
  }
  if (action === 'remove-key') {
    const yes = await confirm({ message: `Remove ${connector.name} ${connector.keyLabel ?? 'credential'}?`, default: false });
    if (!yes) return;
    removeSessionConnectorSecret(connector.id);
    const spin = spinner(`Removing ${connector.keyLabel ?? 'credential'}…`);
    try {
      await renderWebRequest(options, `/api/connector-secrets/${encodeURIComponent(connector.id)}`, {
        method: 'DELETE',
      }, { label: 'Render-web connector secrets', requireAuth: true });
      spin.succeed(`${connector.keyLabel ?? 'Credential'} removed.`);
    } catch (err) {
      spin.succeed(`${connector.keyLabel ?? 'Credential'} removed for this CLI session.`);
      console.log(badge(`Cloud remove skipped: ${err instanceof Error ? err.message : String(err)}`, 'muted'));
    }
    return;
  }
  if (action === 'test') {
    await testConnector(options, connector);
    return;
  }
}

async function toggleConnector(
  options: GlobalOptions,
  state: ProtocolConnectorState,
  connector: ConnectorSummary,
  nextEnabled: boolean,
  keyInstalled: boolean,
): Promise<void> {
  if (nextEnabled && connector.needsKey && !keyInstalled) {
    const saved = await setApiKey(options, connector);
    if (!saved) return;
  }
  const next = setConnectorEnabled(state, connector.id, nextEnabled);
  const spin = spinner(`${nextEnabled ? 'Turning on' : 'Turning off'} ${connector.name}…`);
  const result = await saveConnectorState(options, next);
  if (result.cloud) {
    spin.succeed(`${connector.name} ${nextEnabled ? 'connected' : 'disconnected'}.`);
  } else {
    spin.succeed(`${connector.name} ${nextEnabled ? 'connected' : 'disconnected'} for this CLI session.`);
    console.log(badge('Sign in with /sign-in to sync connector choices to cloud storage.', 'muted'));
  }
}

async function setApiKey(options: GlobalOptions, connector: ConnectorSummary): Promise<boolean> {
  const label = connector.keyLabel ?? 'API key';
  console.log();
  console.log(badge(`Pasting a ${label} stores it encrypted in cloud preferences when signed in; otherwise it stays in this CLI session.`, 'muted'));

  // Prefer reading from an env var to keep secrets out of shell history when
  // the user has one set. Fall back to a masked password prompt.
  const fromEnv = connector.envVar && process.env[connector.envVar]
    ? await confirm({ message: `Use the value of ${connector.envVar}?`, default: true })
    : false;
  const apiKey = fromEnv && connector.envVar
    ? process.env[connector.envVar]!
    : await password({ message: `${label}:` });
  if (!apiKey.trim()) {
    console.log(badge('Aborted - empty credential.', 'warn'));
    return false;
  }
  const labelInput = await input({
    message: 'Label for this credential (optional)',
    default: '',
  });
  const body: Record<string, string> = { apiKey: apiKey.trim() };
  if (labelInput.trim()) body.label = labelInput.trim();
  saveSessionConnectorSecret(connector.id, { apiKey: apiKey.trim() });
  const spin = spinner(`Saving ${label}…`);
  try {
    await renderWebRequest(options, `/api/connector-secrets/${encodeURIComponent(connector.id)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, { label: 'Render-web connector secrets', requireAuth: true });
    spin.succeed(`${label} saved.`);
    return true;
  } catch (err) {
    spin.succeed(`${label} stored for this CLI session.`);
    console.log(badge(`Cloud save skipped: ${err instanceof Error ? err.message : String(err)}`, 'muted'));
    return true;
  }
}

async function testConnector(options: GlobalOptions, connector: ConnectorSummary): Promise<void> {
  const spin = spinner(`Probing ${connector.name}…`);
  const connectorSecrets = connectorSecretsForRequest(connector.id);
  try {
    const result = await bridgeRequest(options, '/bridge/action/connector-read-facts', {
      method: 'POST',
      body: JSON.stringify({
        connectorId: connector.id,
        capability: 'markets',
        ...(connectorSecrets ? { connectorSecrets } : {}),
      }),
    });
    spin.succeed('Read OK.');
    console.log(divider());
    console.log(JSON.stringify(result, null, 2).slice(0, 1500));
    console.log(divider());
  } catch (err) {
    spin.fail(`Read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
