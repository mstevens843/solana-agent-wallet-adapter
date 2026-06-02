import './publish.css';
import { getJson } from './fetchHelpers.js';
import { registerSkillsSubTab } from './subTabRegistry.js';
import { getConnectedAddress } from '../../walletState.js';

// Mirrors SkillManifest / SkillManifestRecord at
// packages/workflow/src/dev/skills.ts:43-55, 89-96. Inlined to keep the
// workflow `/dev` subpath (which transitively pulls node:crypto) out of the
// browser bundle.
export type SkillCategory = 'dca' | 'yield' | 'stops' | 'bridge' | 'donation' | 'custom';

export interface SkillMonetization {
  kind: 'one-time' | 'monthly' | 'performance-fee';
  amount?: string;
  feePercent?: number;
  payoutWallet: string;
  // Currency the skill is priced in. Defaults to USDC when omitted; SKR is
  // accepted on Seeker-enabled deployments. Mirrors
  // `packages/workflow/src/dev/skills.ts:SkillMonetization.token`.
  token?: 'USDC' | 'SKR';
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  authorWallet: string;
  description: string;
  category: SkillCategory;
  schedule: { kind: 'cron' | 'interval' | 'price-trigger'; spec: string };
  action: { connectorAction: string; paramsTemplate: Record<string, unknown> };
  caps: {
    perRunMaxAmount: string;
    lifetimeMaxAmount: string;
    allowlistedTokens: string[];
    expiresAt?: string;
  };
  monetization?: SkillMonetization;
}

export interface SkillManifestRecord {
  id: string;
  version: string;
  authorWallet: string;
  createdAt: string;
  updatedAt: string;
  manifest: SkillManifest;
}

export interface SkillStatsSnapshot {
  skillId: string;
  installs: number;
  totalExecutions: number;
  successRate: number;
  computedAt: string;
}

export interface AuthorEarningsSkill {
  skillId: string;
  monthlyUsdc: string;
  activeSubscriptions: number;
}

export interface AuthorEarningsResponse {
  authorWallet: string;
  currency: string;
  totalMonthlyUsdc: string;
  skills: AuthorEarningsSkill[];
}

export interface PublishedSkillRecord extends SkillManifestRecord {
  stats?: SkillStatsSnapshot | null;
  monthlyUsdc?: string;
  activeSubscriptions?: number;
}

export type PublishPhase =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'empty'
  | 'error'
  | 'forbidden'
  | 'signedOut'
  | 'notDeployed'
  | 'noWallet';

export interface PublishPanelState {
  phase: PublishPhase;
  wallet: string | undefined;
  records: PublishedSkillRecord[];
  errorMessage: string;
  fetchedAt: number;
}

export const CLI_INSTALL_SNIPPET = [
  'npm install -g @solana-agent-wallet-adapter/skills-cli',
  'agentic-skill init my-skill',
  'agentic-skill publish ./my-skill/manifest.json',
].join('\n');

const DEFAULT_SKILL_PAGE_ORIGIN = 'https://agentic-signer.com';
const MONTHLY_EARNED_TOOLTIP =
  'Active monthly author-fee run-rate from recurring schedules';

const panelState: PublishPanelState = {
  phase: 'idle',
  wallet: undefined,
  records: [],
  errorMessage: '',
  fetchedAt: 0,
};

let kickoffScheduled = false;

export function __resetPanelStateForTests(next: Partial<PublishPanelState> = {}): void {
  panelState.phase = next.phase ?? 'idle';
  panelState.wallet = next.wallet;
  panelState.records = next.records ?? [];
  panelState.errorMessage = next.errorMessage ?? '';
  panelState.fetchedAt = next.fetchedAt ?? 0;
  kickoffScheduled = false;
}

export function __getPanelStateForTests(): Readonly<PublishPanelState> {
  return {
    phase: panelState.phase,
    wallet: panelState.wallet,
    records: panelState.records,
    errorMessage: panelState.errorMessage,
    fetchedAt: panelState.fetchedAt,
  };
}

export function __getKickoffScheduledForTests(): boolean {
  return kickoffScheduled;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
    : c === '<' ? '&lt;'
    : c === '>' ? '&gt;'
    : c === '"' ? '&quot;'
    : '&#39;',
  );
}

function currentBrowserOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.location.origin || undefined;
}

export function buildSkillPageUrl(
  id: string,
  origin = currentBrowserOrigin() ?? DEFAULT_SKILL_PAGE_ORIGIN,
): string {
  return `${origin.replace(/\/+$/, '')}/skills/${encodeURIComponent(id)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeManifest(value: unknown): value is SkillManifest {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string' &&
    typeof value.authorWallet === 'string' &&
    typeof value.name === 'string'
  );
}

function looksLikeManifestRecord(value: unknown): value is SkillManifestRecord {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string' &&
    typeof value.authorWallet === 'string' &&
    looksLikeManifest(value.manifest)
  );
}

function recordFromManifest(manifest: SkillManifest): SkillManifestRecord {
  return {
    id: manifest.id,
    version: manifest.version,
    authorWallet: manifest.authorWallet,
    createdAt: '',
    updatedAt: '',
    manifest,
  };
}

function normalizeCatalogItem(value: unknown): SkillManifestRecord | null {
  if (looksLikeManifestRecord(value)) return value;
  if (looksLikeManifest(value)) return recordFromManifest(value);
  return null;
}

export function normalizeCatalogResponse(input: unknown): SkillManifestRecord[] {
  const raw = Array.isArray(input)
    ? input
    : isObject(input) && Array.isArray(input.skills)
      ? input.skills
      : isObject(input) && Array.isArray(input.items)
        ? input.items
        : [];
  return raw.flatMap((entry) => {
    const normalized = normalizeCatalogItem(entry);
    return normalized ? [normalized] : [];
  });
}

function looksLikeSkillStats(value: unknown): value is SkillStatsSnapshot {
  return (
    isObject(value) &&
    typeof value.skillId === 'string' &&
    typeof value.installs === 'number' &&
    typeof value.totalExecutions === 'number' &&
    typeof value.successRate === 'number' &&
    typeof value.computedAt === 'string'
  );
}

export function normalizeStatsResponse(input: unknown): SkillStatsSnapshot | null {
  if (looksLikeSkillStats(input)) return input;
  if (isObject(input) && looksLikeSkillStats(input.snapshot)) return input.snapshot;
  if (isObject(input) && looksLikeSkillStats(input.stats)) return input.stats;
  return null;
}

function looksLikeAuthorEarningsSkill(value: unknown): value is AuthorEarningsSkill {
  return (
    isObject(value) &&
    typeof value.skillId === 'string' &&
    typeof value.monthlyUsdc === 'string' &&
    typeof value.activeSubscriptions === 'number'
  );
}

export function normalizeAuthorEarningsResponse(input: unknown): AuthorEarningsResponse | null {
  if (
    isObject(input) &&
    typeof input.authorWallet === 'string' &&
    typeof input.currency === 'string' &&
    typeof input.totalMonthlyUsdc === 'string' &&
    Array.isArray(input.skills) &&
    input.skills.every(looksLikeAuthorEarningsSkill)
  ) {
    return input as unknown as AuthorEarningsResponse;
  }
  return null;
}

export function formatInstalls(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const rounded = Math.max(0, Math.round(value));
  return `${rounded} install${rounded === 1 ? '' : 's'}`;
}

function isZeroDecimalString(value: string): boolean {
  return /^0+(\.0+)?$/.test(value);
}

/**
 * Format an author's monthly earnings amount with the skill's monetization
 * token. Defaults to USDC for skills published before the $SKR (Solana Mobile
 * Seeker) ecosystem token was introduced; pass `token: 'SKR'` for Seeker-priced
 * skills so the dashboard displays the correct currency.
 *
 * Exported as `formatMonthlyUsdc` alias for backward compatibility with the
 * skills-publish.test fixtures that predate the token argument.
 */
export function formatMonthlyAmount(value: string | undefined, token: string = 'USDC'): string {
  if (!value || isZeroDecimalString(value)) return '—';
  return `${value} ${token}/mo`;
}

export const formatMonthlyUsdc = formatMonthlyAmount;

export function filterRecordsForAuthor(
  records: readonly SkillManifestRecord[],
  wallet: string,
): SkillManifestRecord[] {
  return records.filter((r) => r.authorWallet === wallet);
}

function renderCliCard(): string {
  const safeSnippet = escapeHtml(CLI_INSTALL_SNIPPET);
  return `
    <section class="skills-publish-cli-card">
      <header>
        <span class="skills-publish-tag">Author flow</span>
        <h2>Publish a skill</h2>
        <p>
          Authoring lives in the <code>agentic-skill</code> CLI. Scaffold a manifest, validate it
          locally, then publish to the cloud registry. Every skill ships with hard caps and
          per-action wallet approval &mdash; never delegated signing.
        </p>
      </header>
      <pre class="skills-publish-pre" aria-label="CLI install snippet">${safeSnippet}</pre>
      <div class="skills-publish-cli-actions">
        <button
          type="button"
          class="skills-publish-button"
          data-skills-publish-action="copy-cli-snippet"
          data-skills-publish-value="${safeSnippet}"
        >Copy CLI snippet</button>
        <a
          class="skills-publish-button skills-publish-button-secondary"
          href="https://www.npmjs.com/package/@solana-agent-wallet-adapter/skills-cli"
          target="_blank"
          rel="noreferrer"
          data-skills-publish-action="open-npm"
        >View on npm →</a>
      </div>
    </section>
  `;
}

function renderRow(record: PublishedSkillRecord): string {
  const name = escapeHtml(record.manifest.name || record.id);
  const id = escapeHtml(record.id);
  const version = escapeHtml(record.version);
  const category = escapeHtml(record.manifest.category);
  const skillUrl = escapeHtml(buildSkillPageUrl(record.id));
  const installs = formatInstalls(record.stats?.installs);
  const monetizationToken = record.manifest.monetization?.token ?? 'USDC';
  const monthlyAmount = formatMonthlyAmount(record.monthlyUsdc, monetizationToken);
  return `
    <div class="skills-publish-row" data-skills-publish-skill-id="${id}">
      <div class="skills-publish-row-name">
        <span class="skills-publish-skill-name">${name}</span>
        <span class="skills-publish-skill-meta">v${version} · <code>${id}</code></span>
      </div>
      <div class="skills-publish-row-category">
        <span class="skills-publish-chip">${category}</span>
      </div>
      <div class="skills-publish-row-installs" title="Receipt aggregator install count">
        <span class="skills-publish-cell-label">Installs</span>
        <span class="skills-publish-cell-value">${escapeHtml(installs)}</span>
      </div>
      <div class="skills-publish-row-earned" title="${escapeHtml(MONTHLY_EARNED_TOOLTIP)}">
        <span class="skills-publish-cell-label">Monthly earnings</span>
        <span class="skills-publish-cell-value">${escapeHtml(monthlyAmount)}</span>
      </div>
      <div class="skills-publish-row-actions">
        <a
          class="skills-publish-button skills-publish-button-secondary"
          href="${skillUrl}"
          target="_blank"
          rel="noreferrer"
          data-skills-publish-action="open-skill-page"
        >Open skill page →</a>
      </div>
    </div>
  `;
}

function renderListSection(): string {
  switch (panelState.phase) {
    case 'noWallet':
      return `
        <section class="skills-publish-list-card">
          <div class="skills-publish-notice">
            <strong>Connect a wallet</strong>
            <p>Connect the wallet that authors your skills to manage published manifests.</p>
          </div>
        </section>
      `;
    case 'signedOut':
      return `
        <section class="skills-publish-list-card">
          <div class="skills-publish-notice">
            <strong>Sign in required</strong>
            <p>${escapeHtml(panelState.errorMessage || 'Sign in to Agentic Cloud with your wallet to manage authored skills.')}</p>
          </div>
        </section>
      `;
    case 'loading':
      return `
        <section class="skills-publish-list-card">
          <div class="skills-publish-skeleton" aria-busy="true">
            <span class="skills-publish-skeleton-line skills-publish-skeleton-line-wide"></span>
            <span class="skills-publish-skeleton-line"></span>
            <span class="skills-publish-skeleton-line"></span>
          </div>
        </section>
      `;
    case 'forbidden':
      return `
        <section class="skills-publish-list-card">
          <div class="skills-publish-notice skills-publish-notice-warn">
            <strong>Permission required</strong>
            <p>This wallet cannot publish or manage authored skills.</p>
          </div>
        </section>
      `;
    case 'notDeployed':
      return `
        <section class="skills-publish-list-card">
          <div class="skills-publish-notice">
            <strong>Skill registry API unavailable</strong>
            <p>
              The <code>/api/skills</code> endpoint returned 404 in this environment. The CLI
              snippet above still scaffolds and validates a manifest locally; publishing needs a
              render-web server with Skills routes enabled.
            </p>
          </div>
        </section>
      `;
    case 'error':
      return `
        <section class="skills-publish-list-card">
          <div class="skills-publish-notice skills-publish-notice-error">
            <strong>Couldn't load authored skills</strong>
            <p>${escapeHtml(panelState.errorMessage || 'Unknown error')}</p>
            <button
              type="button"
              class="skills-publish-button"
              data-skills-publish-action="retry"
            >Retry</button>
          </div>
        </section>
      `;
    case 'empty':
      return `
        <section class="skills-publish-list-card">
          <div class="skills-publish-notice">
            <strong>You haven't published any skills yet</strong>
            <p>
              The snippet above scaffolds your first manifest. Once <code>agentic-skill publish</code>
              succeeds, the new skill appears here with install counts and earnings.
            </p>
          </div>
        </section>
      `;
    case 'loaded': {
      const rows = panelState.records.map(renderRow).join('');
      return `
        <section class="skills-publish-list-card">
          <header class="skills-publish-list-header">
            <h3>Your published skills</h3>
            <span class="skills-publish-list-count">${panelState.records.length} live</span>
          </header>
          <div class="skills-publish-table">${rows}</div>
        </section>
      `;
    }
    case 'idle':
    default:
      return `
        <section class="skills-publish-list-card">
          <div class="skills-publish-skeleton" aria-busy="true">
            <span class="skills-publish-skeleton-line skills-publish-skeleton-line-wide"></span>
            <span class="skills-publish-skeleton-line"></span>
          </div>
        </section>
      `;
  }
}

export function renderPublishPanel(): string {
  return `
    <section class="skills-publish" data-skills-publish-root>
      ${renderCliCard()}
      ${renderListSection()}
    </section>
  `;
}

async function fetchAuthoredSkills(wallet: string): Promise<void> {
  panelState.wallet = wallet;
  panelState.phase = 'loading';
  panelState.errorMessage = '';
  rerenderPanelOnly();
  const result = await getJson<unknown>(
    `/api/skills?author=${encodeURIComponent(wallet)}`,
  );
  if (panelState.wallet !== wallet) return;
  switch (result.kind) {
    case 'ok': {
      const records = normalizeCatalogResponse(result.value);
      const filtered = filterRecordsForAuthor(records, wallet);
      if (filtered.length === 0) {
        panelState.records = [];
        panelState.phase = 'empty';
        break;
      }
      const [stats, earnings] = await Promise.all([
        Promise.all(filtered.map((record) => fetchSkillStats(record.id))),
        fetchAuthorEarnings(wallet),
      ]);
      if (panelState.wallet !== wallet) return;
      const earningsBySkill = new Map(
        (earnings?.skills ?? []).map((row) => [row.skillId, row] as const),
      );
      panelState.records = filtered.map((record, i) => {
        const earning = earningsBySkill.get(record.id);
        return {
          ...record,
          stats: stats[i] ?? null,
          ...(earning ? {
            monthlyUsdc: earning.monthlyUsdc,
            activeSubscriptions: earning.activeSubscriptions,
          } : {}),
        };
      });
      panelState.phase = 'loaded';
      break;
    }
    case 'forbidden':
      panelState.phase = 'forbidden';
      break;
    case 'unauthenticated':
      panelState.phase = 'signedOut';
      panelState.errorMessage = result.message;
      break;
    case 'notDeployed':
      panelState.phase = 'notDeployed';
      break;
    case 'networkError':
    case 'error':
      panelState.phase = 'error';
      panelState.errorMessage = result.message;
      break;
  }
  panelState.fetchedAt = Date.now();
  rerenderPanelOnly();
}

async function fetchSkillStats(skillId: string): Promise<SkillStatsSnapshot | null> {
  const result = await getJson<unknown>(
    `/api/aggregator/skills/${encodeURIComponent(skillId)}`,
  );
  return result.kind === 'ok' ? normalizeStatsResponse(result.value) : null;
}

async function fetchAuthorEarnings(wallet: string): Promise<AuthorEarningsResponse | null> {
  const result = await getJson<unknown>(
    `/api/skills/authors/${encodeURIComponent(wallet)}/earnings`,
  );
  return result.kind === 'ok' ? normalizeAuthorEarningsResponse(result.value) : null;
}

export async function __fetchAuthoredSkillsForTests(wallet: string): Promise<void> {
  await fetchAuthoredSkills(wallet);
}

function rerenderPanelOnly(): void {
  if (typeof document === 'undefined') return;
  const root = document.querySelector('[data-skills-publish-root]');
  if (!root || !root.parentNode) return;
  const template = document.createElement('template');
  template.innerHTML = renderPublishPanel().trim();
  const next = template.content.firstElementChild;
  if (!next) return;
  root.replaceWith(next);
}

let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  if (typeof document === 'undefined') return;
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'skills-publish-toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl?.classList.remove('visible');
  }, 3_000);
}

async function handleAction(action: string, dataset: DOMStringMap): Promise<void> {
  switch (action) {
    case 'copy-cli-snippet': {
      const value = dataset.skillsPublishValue ?? CLI_INSTALL_SNIPPET;
      try {
        await navigator.clipboard.writeText(value);
        showToast('CLI snippet copied');
      } catch {
        showToast('Copy failed — clipboard permission denied');
      }
      return;
    }
    case 'retry': {
      const wallet = getConnectedAddress();
      if (!wallet) {
        panelState.phase = 'noWallet';
        rerenderPanelOnly();
        return;
      }
      await fetchAuthoredSkills(wallet);
      return;
    }
    case 'open-skill-page':
    case 'open-npm':
      return;
    default:
      return;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    const trigger = target.closest<HTMLElement>('[data-skills-publish-action]');
    if (!trigger) return;
    const action = trigger.dataset.skillsPublishAction;
    if (!action) return;
    if (action !== 'open-skill-page' && action !== 'open-npm') {
      event.preventDefault();
    }
    void handleAction(action, trigger.dataset);
  });
}

registerSkillsSubTab({
  id: 'publish',
  label: 'Publish',
  description: 'Ship your own skill via the CLI.',
  render: () => {
    const wallet = getConnectedAddress();
    if (!wallet) {
      panelState.phase = 'noWallet';
      panelState.wallet = undefined;
      panelState.records = [];
      panelState.errorMessage = '';
      return renderPublishPanel();
    }
    if (panelState.wallet !== wallet) {
      panelState.wallet = wallet;
      panelState.phase = 'idle';
      panelState.records = [];
      panelState.errorMessage = '';
    }
    if (panelState.phase === 'idle' && !kickoffScheduled) {
      kickoffScheduled = true;
      Promise.resolve().then(() => {
        kickoffScheduled = false;
        void fetchAuthoredSkills(wallet);
      });
    }
    return renderPublishPanel();
  },
});
