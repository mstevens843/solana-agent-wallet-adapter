import type { GlobalOptions } from '../shared/types.js';
import { renderWebRequest, bridgeRequest, tryBridgeRequest } from '../http/index.js';
import { select, confirm, input, header, kv, badge, divider, spinner } from '../tui/index.js';
import { loadSession, sessionStatusSummary } from '../auth/sessionStore.js';
import { runConnectorsMenu } from './connectors.js';
import { countEnabledConnectors } from './connectorState.js';

type Card = 'workspace' | 'ai' | 'access' | 'rules' | 'tokens' | 'back';

// `/preferences` — 5-card menu mirroring the web Preferences page. Each card
// reads its prefs namespace via render-web, renders a summary, and offers
// targeted edits. Power-user JSON editing stays available via the existing
// `/prefs show | get | set` command.
export async function runPreferencesMenu(options: GlobalOptions): Promise<void> {
  while (true) {
    console.log();
    console.log(header('Preferences'));
    const summary = await fetchSummary(options);
    console.log(kv([
      ['Backup & Alerts → Workspace',       summary.workspace],
      ['Prompts & Review → AI Drafting',    summary.ai],
      ['Agents & Connectors → Agent Access', summary.access],
      ['Recipients & Policy → Review Rules', summary.rules],
      ['Labels & Failures → Tokens & Retry', summary.tokens],
    ]));
    console.log(divider());

    const choice = await select<Card>({
      message: 'Open which card?',
      choices: [
        { name: 'Workspace (backup & alerts)',                value: 'workspace' },
        { name: 'AI Drafting (prompts & review)',             value: 'ai' },
        { name: 'Agent Access (agents & connectors)',         value: 'access' },
        { name: 'Review Rules (recipients & policy)',         value: 'rules' },
        { name: 'Tokens & Retry (labels & failures)',         value: 'tokens' },
        { name: '← Back to main menu',                        value: 'back' },
      ],
    });
    if (choice === 'back') return;
    if (choice === 'workspace') { await openWorkspace(options); continue; }
    if (choice === 'ai')        { await openAi(options); continue; }
    if (choice === 'access')    { await runConnectorsMenu(options); continue; }
    if (choice === 'rules')     { await openRules(options); continue; }
    if (choice === 'tokens')    { await openTokens(options); continue; }
  }
}

interface Summary {
  workspace: string;
  ai: string;
  access: string;
  rules: string;
  tokens: string;
}

async function fetchSummary(options: GlobalOptions): Promise<Summary> {
  const [session, ai, connectors, policies, rails, tokens, failure] = await Promise.all([
    loadSession(options).catch(() => null),
    fetchNamespace(options, 'ai-settings'),
    fetchNamespace(options, 'protocol-connectors'),
    fetchNamespace(options, 'agent-policies'),
    fetchNamespace(options, 'safety-rails'),
    fetchNamespace(options, 'custom-tokens'),
    fetchNamespace(options, 'failure-policies'),
  ]);
  const auth = sessionStatusSummary(session);
  const connectorCount = countEnabledConnectors(connectors);
  const policyCount = countEntries(policies);
  const railCount = countEntries(rails);
  const tokenCount = countEntries(tokens);
  const failurePolicyCount = countEntries(failure);
  const aiMode = aiModeLabel(ai);

  return {
    workspace: `${auth.authenticated ? badge('signed in', 'ok') : badge('local only', 'muted')} · ${auth.walletAddress ?? '-'}`,
    ai: `${aiMode}`,
    access: `${connectorCount} connectors enabled`,
    rules: `${policyCount} policies · ${railCount} safety rails`,
    tokens: `${tokenCount} custom tokens · ${failurePolicyCount} retry rules`,
  };
}

async function openWorkspace(options: GlobalOptions): Promise<void> {
  console.log();
  console.log(header('Workspace · backup & alerts'));
  const [session, health] = await Promise.all([
    loadSession(options).catch(() => null),
    tryBridgeRequest<{ walletAddress?: string; cluster?: string; bridgeConnected?: boolean }>(options, '/bridge/health'),
  ]);
  const auth = sessionStatusSummary(session);
  console.log(kv([
    ['Signed in',     auth.authenticated ? badge('yes', 'ok') : badge('no', 'muted')],
    ['Wallet',        auth.walletAddress ?? '-'],
    ['Expires',       auth.expiresAt ?? '-'],
    ['Cloud sync',    auth.authenticated ? badge('active', 'ok') : badge('paused (sign in to sync)', 'muted')],
    ['Bridge',        health.ok ? badge('online', 'ok') : badge('offline', 'err')],
    ['Network',       health.ok ? health.value.cluster ?? 'unknown' : '-'],
  ]));
  console.log(divider());
  console.log(badge('To clear local + cloud workspace data, run /cloud-workspace delete.', 'muted'));
}

async function openAi(options: GlobalOptions): Promise<void> {
  console.log();
  console.log(header('AI Drafting · prompts & review'));
  const settings = await fetchNamespace(options, 'ai-settings');
  console.log(kv([
    ['Mode',           pickString(settings, ['mode'])          ?? 'bridge (default)'],
    ['Provider',       pickString(settings, ['provider'])      ?? 'auto'],
    ['Model',          pickString(settings, ['model'])         ?? 'default'],
    ['Multi-review',   pickString(settings, ['multiReviewer'])   ?? 'off'],
  ]));
  console.log(divider());

  const choice = await select<'mode' | 'provider' | 'model' | 'review' | 'back'>({
    message: 'What to edit?',
    choices: [
      { name: 'Set AI mode (bridge / device-agent / hosted)', value: 'mode' },
      { name: 'Set provider (anthropic / openai / local)',    value: 'provider' },
      { name: 'Set model name',                               value: 'model' },
      { name: 'Toggle multi-review',                          value: 'review' },
      { name: '← Back',                                       value: 'back' },
    ],
  });
  if (choice === 'back') return;
  if (choice === 'mode')     return setKey(options, 'ai-settings', 'mode',     await pickAiMode());
  if (choice === 'provider') return setKey(options, 'ai-settings', 'provider', await input({ message: 'Provider', default: 'anthropic' }));
  if (choice === 'model')    return setKey(options, 'ai-settings', 'model',    await input({ message: 'Model name', default: 'claude-sonnet-4-5' }));
  if (choice === 'review') {
    const next = !(pickBool(settings, ['multiReviewer']) ?? false);
    return setKey(options, 'ai-settings', 'multiReviewer', next);
  }
}

async function openRules(options: GlobalOptions): Promise<void> {
  console.log();
  console.log(header('Review Rules · recipients & policy'));
  const [policies, rails] = await Promise.all([
    fetchNamespace(options, 'agent-policies'),
    fetchNamespace(options, 'safety-rails'),
  ]);
  console.log(kv([
    ['Saved policies', String(countEntries(policies))],
    ['Safety rails',   String(countEntries(rails))],
  ]));
  console.log(divider());
  console.log(badge('Entries are JSON. To add/remove an entry, use the editor below.', 'muted'));

  const choice = await select<'view-policies' | 'view-rails' | 'edit-policies' | 'edit-rails' | 'back'>({
    message: 'What next?',
    choices: [
      { name: 'View agent policies',     value: 'view-policies' },
      { name: 'View safety rails',       value: 'view-rails' },
      { name: 'Edit agent policies (via file)', value: 'edit-policies' },
      { name: 'Edit safety rails (via file)',   value: 'edit-rails' },
      { name: '← Back',                  value: 'back' },
    ],
  });
  if (choice === 'back') return;
  if (choice === 'view-policies') { console.log(JSON.stringify(policies, null, 2)); console.log(divider()); return; }
  if (choice === 'view-rails')    { console.log(JSON.stringify(rails, null, 2));    console.log(divider()); return; }
  if (choice === 'edit-policies') { return editFromFile(options, 'agent-policies'); }
  if (choice === 'edit-rails')    { return editFromFile(options, 'safety-rails'); }
}

async function openTokens(options: GlobalOptions): Promise<void> {
  console.log();
  console.log(header('Tokens & Retry · labels & failures'));
  const [tokens, failure] = await Promise.all([
    fetchNamespace(options, 'custom-tokens'),
    fetchNamespace(options, 'failure-policies'),
  ]);
  console.log(kv([
    ['Custom tokens', String(countEntries(tokens))],
    ['Retry rules',   String(countEntries(failure))],
  ]));
  console.log(divider());

  const choice = await select<'view-tokens' | 'view-retry' | 'add-token' | 'edit-retry' | 'back'>({
    message: 'What next?',
    choices: [
      { name: 'View custom tokens',           value: 'view-tokens' },
      { name: 'View retry rules',             value: 'view-retry' },
      { name: 'Add a custom token mapping',   value: 'add-token' },
      { name: 'Edit retry rules (via file)',  value: 'edit-retry' },
      { name: '← Back',                       value: 'back' },
    ],
  });
  if (choice === 'back') return;
  if (choice === 'view-tokens') { console.log(JSON.stringify(tokens,  null, 2)); console.log(divider()); return; }
  if (choice === 'view-retry')  { console.log(JSON.stringify(failure, null, 2)); console.log(divider()); return; }
  if (choice === 'add-token')   { return addCustomToken(options, tokens); }
  if (choice === 'edit-retry')  { return editFromFile(options, 'failure-policies'); }
}

async function addCustomToken(options: GlobalOptions, current: Record<string, unknown>): Promise<void> {
  const symbol = (await input({ message: 'Token symbol (e.g. MYTOKEN)' })).trim().toUpperCase();
  if (!symbol) return;
  const mint = (await input({ message: 'Mint address' })).trim();
  if (!mint) return;
  const decimals = Number((await input({ message: 'Decimals', default: '6' })).trim());
  const next = { ...current, [symbol]: { mint, decimals } };
  const spin = spinner(`Saving ${symbol}…`);
  try {
    await renderWebRequest(options, '/api/preferences/custom-tokens', {
      method: 'PUT',
      body: JSON.stringify({ payload: next }),
    }, { label: 'Render-web preferences', requireAuth: true });
    spin.succeed(`Added ${symbol} → ${mint.slice(0, 12)}…`);
  } catch (err) {
    spin.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function editFromFile(options: GlobalOptions, namespace: string): Promise<void> {
  const file = await input({
    message: `Path to JSON file with the new ${namespace} payload`,
  });
  if (!file.trim()) return;
  let payload: unknown;
  try {
    const { readJsonFile } = await import('../shared/util.js');
    payload = await readJsonFile(file.trim(), `${namespace} payload`);
  } catch (err) {
    console.log(badge(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`, 'err'));
    return;
  }
  const yes = await confirm({ message: `Replace ${namespace} with this payload?`, default: false });
  if (!yes) return;
  const spin = spinner(`Writing ${namespace}…`);
  try {
    await renderWebRequest(options, `/api/preferences/${namespace}`, {
      method: 'PUT',
      body: JSON.stringify({ payload }),
    }, { label: 'Render-web preferences', requireAuth: true });
    spin.succeed(`${namespace} updated.`);
  } catch (err) {
    spin.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function setKey(options: GlobalOptions, namespace: string, key: string, value: unknown): Promise<void> {
  const current = await fetchNamespace(options, namespace);
  const next = { ...current, [key]: value };
  const spin = spinner(`Saving ${namespace}.${key}…`);
  try {
    await renderWebRequest(options, `/api/preferences/${namespace}`, {
      method: 'PUT',
      body: JSON.stringify({ payload: next }),
    }, { label: 'Render-web preferences', requireAuth: true });
    spin.succeed(`Saved ${namespace}.${key} = ${JSON.stringify(value)}`);
  } catch (err) {
    spin.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function pickAiMode(): Promise<string> {
  return select<string>({
    message: 'AI mode',
    choices: [
      { name: 'bridge - local bridge AI (default)',     value: 'bridge' },
      { name: 'device-agent - on-device LLM',           value: 'device-agent' },
      { name: 'hosted - cloud AI (render-web)',         value: 'hosted' },
    ],
  });
}

async function fetchNamespace(options: GlobalOptions, namespace: string): Promise<Record<string, unknown>> {
  try {
    const raw = await renderWebRequest<unknown>(options, `/api/preferences/${namespace}`, undefined, {
      label: 'Render-web preferences',
      requireAuth: true,
    });
    if (raw && typeof raw === 'object') {
      const payload = (raw as { payload?: unknown }).payload;
      if (payload && typeof payload === 'object') return payload as Record<string, unknown>;
      return raw as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function countEntries(payload: Record<string, unknown>): number {
  if (Array.isArray(payload)) return (payload as unknown[]).length;
  return Object.keys(payload).length;
}

function aiModeLabel(settings: Record<string, unknown>): string {
  const mode = pickString(settings, ['mode']);
  if (!mode) return 'bridge (default)';
  return mode;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

function pickBool(obj: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}
