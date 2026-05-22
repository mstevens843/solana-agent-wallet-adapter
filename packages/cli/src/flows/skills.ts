import type { GlobalOptions } from '../shared/types.js';
import { renderWebRequest } from '../http/index.js';
import { select, confirm, input, header, kv, badge, divider, spinner } from '../tui/index.js';
import { readJsonFile } from '../shared/util.js';

interface SkillSummary {
  id?: string;
  name?: string;
  authorWallet?: string;
  description?: string;
  latestVersion?: string;
  monetization?: string;
  installs?: number;
}

interface SkillInstall {
  id?: string;
  installId?: string;
  skillId?: string;
  name?: string;
  status?: string;
  manifestVersion?: string;
  installedAt?: string;
}

type RootChoice = 'browse' | 'installed' | 'profile' | 'publish' | 'back';

// `/skills` — friendlier menu over the existing dispatchSkills command tree.
// The actual install/publish heavy lifting still goes through render-web /
// agentic-skill; this wrapper just adds the pickers and guidance text.
export async function runSkillsMenu(options: GlobalOptions): Promise<void> {
  while (true) {
    console.log();
    console.log(header('Skills'));
    console.log(badge('Browse · Installed · My Profile · Publish', 'muted'));

    const choice = await select<RootChoice>({
      message: 'What next?',
      choices: [
        { name: 'Browse catalog',                value: 'browse',    description: 'See published skills and install one' },
        { name: 'Installed skills',              value: 'installed', description: 'Pause / resume / uninstall what you have' },
        { name: 'My profile (author earnings)',  value: 'profile',   description: 'Read your skill-author earnings' },
        { name: 'Publish a new skill',           value: 'publish',   description: 'Guided init → test → publish' },
        { name: '← Back to main menu',           value: 'back' },
      ],
    });
    if (choice === 'back') return;
    if (choice === 'browse')    { await runBrowse(options); continue; }
    if (choice === 'installed') { await runInstalled(options); continue; }
    if (choice === 'profile')   { await runProfile(options); continue; }
    if (choice === 'publish')   { runPublishGuide(); continue; }
  }
}

async function runBrowse(options: GlobalOptions): Promise<void> {
  const spin = spinner('Loading catalog…');
  let list: SkillSummary[] = [];
  try {
    const raw = await renderWebRequest<unknown>(options, '/api/skills', undefined, {
      label: 'Render-web skills',
    });
    list = extractList<SkillSummary>(raw, ['skills', 'items', 'catalog']);
    spin.succeed(`${list.length} skills in catalog.`);
  } catch (err) {
    spin.fail(`Could not load: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (list.length === 0) {
    console.log(badge('No skills published yet.', 'muted'));
    return;
  }

  const pickedId = await select<string>({
    message: 'Pick a skill',
    pageSize: Math.min(20, list.length + 1),
    choices: [
      ...list.map((s, i) => ({
        name: rowLabelCatalog(i + 1, s),
        value: s.id ?? `__skip_${i}__`,
        description: s.description?.slice(0, 80),
      })),
      { name: '← Back', value: '__back__' },
    ],
  });
  if (pickedId === '__back__' || pickedId.startsWith('__skip_')) return;
  const skill = list.find((s) => s.id === pickedId);
  if (!skill) return;
  await skillDetailAction(options, skill);
}

async function skillDetailAction(options: GlobalOptions, skill: SkillSummary): Promise<void> {
  console.log();
  console.log(header(skill.name ?? skill.id ?? 'Skill'));
  const rows: Array<[string, string]> = [];
  if (skill.id) rows.push(['ID', skill.id]);
  if (skill.authorWallet) rows.push(['Author', skill.authorWallet]);
  if (skill.latestVersion) rows.push(['Latest version', skill.latestVersion]);
  if (skill.monetization) rows.push(['Monetization', skill.monetization]);
  if (typeof skill.installs === 'number') rows.push(['Installs', String(skill.installs)]);
  if (skill.description) rows.push(['Description', skill.description]);
  console.log(kv(rows));
  console.log(divider());

  const action = await select<'install' | 'detail' | 'back'>({
    message: 'What next?',
    choices: [
      { name: 'View manifest detail', value: 'detail' },
      { name: 'Install this skill',   value: 'install' },
      { name: '← Back to catalog',    value: 'back' },
    ],
  });
  if (action === 'back') return;
  if (action === 'detail') {
    await showManifest(options, skill.id ?? '');
    return;
  }
  if (action === 'install') {
    await installSkill(options, skill);
  }
}

async function showManifest(options: GlobalOptions, id: string): Promise<void> {
  if (!id) return;
  const spin = spinner('Loading manifest…');
  try {
    const raw = await renderWebRequest<unknown>(options, `/api/skills/${encodeURIComponent(id)}`, undefined, {
      label: 'Render-web skills',
    });
    spin.succeed('Loaded.');
    console.log(JSON.stringify(raw, null, 2).slice(0, 2000));
    console.log(divider());
  } catch (err) {
    spin.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function installSkill(options: GlobalOptions, skill: SkillSummary): Promise<void> {
  if (!skill.id) {
    console.log(badge('Skill has no id — cannot install.', 'err'));
    return;
  }
  const manifestVersion = await input({
    message: 'Manifest version (e.g. v1)',
    default: skill.latestVersion ?? 'v1',
  });
  const capsPath = await input({
    message: 'Path to caps.json (capabilities the skill may use)',
    default: './caps.json',
  });
  let caps: unknown;
  try {
    caps = await readJsonFile(capsPath.trim(), 'caps');
  } catch (err) {
    console.log(badge(`Could not read caps file: ${err instanceof Error ? err.message : String(err)}`, 'err'));
    return;
  }
  let acceptMonetization = false;
  if (skill.monetization) {
    acceptMonetization = await confirm({
      message: `This skill is monetized (${skill.monetization}). Accept?`,
      default: false,
    });
    if (!acceptMonetization) {
      console.log(badge('Aborted — monetization not accepted.', 'muted'));
      return;
    }
  }
  const spin = spinner(`Installing ${skill.name ?? skill.id}…`);
  try {
    await renderWebRequest(options, '/api/skills/installs', {
      method: 'POST',
      body: JSON.stringify({ skillId: skill.id, manifestVersion: manifestVersion.trim(), caps, acceptMonetization }),
    }, { label: 'Render-web skills', requireAuth: true });
    spin.succeed('Skill installed.');
  } catch (err) {
    spin.fail(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runInstalled(options: GlobalOptions): Promise<void> {
  const spin = spinner('Loading installs…');
  let list: SkillInstall[] = [];
  try {
    const raw = await renderWebRequest<unknown>(options, '/api/skills/installs', undefined, {
      label: 'Render-web skills',
      requireAuth: true,
    });
    list = extractList<SkillInstall>(raw, ['installs', 'items']);
    spin.succeed(`${list.length} installed.`);
  } catch (err) {
    spin.fail(`Could not load: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (list.length === 0) {
    console.log(badge('No installed skills.', 'muted'));
    return;
  }
  const pickedId = await select<string>({
    message: 'Pick an installed skill',
    pageSize: Math.min(20, list.length + 1),
    choices: [
      ...list.map((s, i) => ({
        name: rowLabelInstall(i + 1, s),
        value: s.installId ?? s.id ?? `__skip_${i}__`,
      })),
      { name: '← Back', value: '__back__' },
    ],
  });
  if (pickedId === '__back__' || pickedId.startsWith('__skip_')) return;
  const install = list.find((s) => (s.installId ?? s.id) === pickedId);
  if (!install) return;
  const action = await select<'pause' | 'resume' | 'uninstall' | 'back'>({
    message: 'What next?',
    choices: install.status === 'paused'
      ? [
          { name: 'Resume',           value: 'resume' },
          { name: 'Uninstall',        value: 'uninstall' },
          { name: '← Back',           value: 'back' },
        ]
      : [
          { name: 'Pause',            value: 'pause' },
          { name: 'Uninstall',        value: 'uninstall' },
          { name: '← Back',           value: 'back' },
        ],
  });
  if (action === 'back') return;
  if (action === 'uninstall') {
    const yes = await confirm({ message: 'Permanently uninstall? Caps are revoked.', default: false });
    if (!yes) return;
  }
  const installId = install.installId ?? install.id ?? pickedId;
  const spin2 = spinner(`${action}ing…`);
  try {
    await renderWebRequest(options, `/api/skills/installs/${encodeURIComponent(installId)}/${action}`, {
      method: 'POST',
      body: '{}',
    }, { label: 'Render-web skills', requireAuth: true });
    spin2.succeed(`${action} ok.`);
  } catch (err) {
    spin2.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runProfile(options: GlobalOptions): Promise<void> {
  const wallet = await input({ message: 'Author wallet (leave blank for "me")', default: '' });
  const path = wallet.trim()
    ? `/api/skills/authors/${encodeURIComponent(wallet.trim())}/earnings`
    : `/api/skills/platform-earnings`;
  const spin = spinner('Loading earnings…');
  try {
    const raw = await renderWebRequest<unknown>(options, path, undefined, {
      label: 'Render-web skills',
      requireAuth: !wallet.trim(),
    });
    spin.succeed('Loaded.');
    console.log(JSON.stringify(raw, null, 2).slice(0, 2000));
    console.log(divider());
  } catch (err) {
    spin.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function runPublishGuide(): void {
  console.log();
  console.log(header('Publish a new skill'));
  console.log('Publishing uses the `agentic-skill` CLI (resolved via local node_modules, PATH, or bundled).');
  console.log();
  console.log(`  1.  ${badge('solana-agent-wallet skills init', 'info')}   — scaffold a new skill package`);
  console.log(`  2.  ${badge('solana-agent-wallet skills test', 'info')}   — smoke-test it against a stub workflow`);
  console.log(`  3.  ${badge('solana-agent-wallet skills publish', 'info')} — sign the manifest + register in the catalog`);
  console.log();
  console.log(badge('Tip: keep the working directory inside the skill package while you run these.', 'muted'));
  console.log(divider());
}

function rowLabelCatalog(n: number, s: SkillSummary): string {
  const row = String(n).padStart(2, ' ');
  const monetized = s.monetization ? badge(s.monetization, 'warn') : badge('free', 'muted');
  return `${row}.  ${s.name ?? s.id ?? 'unnamed'}  ${monetized}  ${badge(`v ${s.latestVersion ?? '—'}`, 'muted')}`;
}

function rowLabelInstall(n: number, s: SkillInstall): string {
  const row = String(n).padStart(2, ' ');
  const statusChip = s.status === 'active' ? badge('active', 'ok') : s.status ? badge(s.status, 'warn') : badge('unknown', 'muted');
  return `${row}.  ${statusChip}  ${s.name ?? s.skillId ?? '?'}  ${badge(`v ${s.manifestVersion ?? '—'}`, 'muted')}`;
}

function extractList<T>(raw: unknown, keys: string[]): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    for (const k of keys) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}
