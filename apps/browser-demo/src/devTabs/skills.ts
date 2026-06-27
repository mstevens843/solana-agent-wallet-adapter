import './skills.css';
import { registerDevTab } from '../devTabRegistry.js';
import { t } from '../demo-i18n/uiLang.js';
import {
  findSkillsSubTab,
  getActiveSkillsSubTab,
  listSkillsSubTabs,
} from './skills/subTabRegistry.js';

// Side-effect import: each Skills sub-tab self-registers on load.
import './skills/index.js';

function escapeHtmlLocal(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
    : c === '<' ? '&lt;'
    : c === '>' ? '&gt;'
    : c === '"' ? '&quot;'
    : '&#39;',
  );
}

function renderSubTabPills(activeId: string): string {
  const subTabs = listSkillsSubTabs();
  if (subTabs.length === 0) return '';
  return `
    <div class="skills-subtab-row" role="tablist" aria-label="${escapeHtmlLocal(t('Skills sections'))}">
      ${subTabs
        .map((tab) => {
          const active = tab.id === activeId;
          const mobileLabel = tab.mobileLabel ?? tab.label;
          return `
            <button
              type="button"
              class="${active ? 'active' : ''}"
              data-skills-subtab="${escapeHtmlLocal(String(tab.id))}"
              role="tab"
              aria-selected="${active ? 'true' : 'false'}"
            >
              <strong>
                <span class="skills-subtab-label-full">${escapeHtmlLocal(t(tab.label))}</span>
                <span class="skills-subtab-label-mobile">${escapeHtmlLocal(t(mobileLabel))}</span>
              </strong>
              <span class="skills-subtab-description">${escapeHtmlLocal(t(tab.description))}</span>
            </button>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderEmptyPlaceholder(): string {
  return `
    <div class="skills-placeholder">
      <span class="skills-placeholder-tag">${escapeHtmlLocal(t('Skills unavailable'))}</span>
      <h2>${escapeHtmlLocal(t('Skills Hub'))}</h2>
      <p>
        ${escapeHtmlLocal(t('The Skills container loaded, but no sections registered in this build. Rebuild the browser app with the Skills sub-tab modules included.'))}
      </p>
      <div class="skills-placeholder-grid">
        <div class="skills-placeholder-card">
          <strong>${escapeHtmlLocal(t('Browse'))}</strong>
          <span>${escapeHtmlLocal(t('Catalog of installable skills, sorted by track record.'))}</span>
        </div>
        <div class="skills-placeholder-card">
          <strong>${escapeHtmlLocal(t('Installed'))}</strong>
          <span>${escapeHtmlLocal(t('Active skills with next-run countdown, pause / resume, uninstall.'))}</span>
        </div>
        <div class="skills-placeholder-card">
          <strong>${escapeHtmlLocal(t('My Profile'))}</strong>
          <span>${escapeHtmlLocal(t('Public'))} <code>/u/&lt;wallet&gt;</code> ${escapeHtmlLocal(t('page aggregating receipts into a verifiable performance record.'))}</span>
        </div>
        <div class="skills-placeholder-card">
          <strong>${escapeHtmlLocal(t('Publish'))}</strong>
          <span>${escapeHtmlLocal(t('Author dashboard for uploading skills via'))} <code>agentic-skill</code> ${escapeHtmlLocal(t('CLI.'))}</span>
        </div>
      </div>
    </div>
  `;
}

function renderSkillsGuide(): string {
  return `
    <section class="skills-guide skills-guide-desktop" aria-label="${escapeHtmlLocal(t('How skills work'))}">
      <div class="skills-guide-heading">
        <span>${escapeHtmlLocal(t('How skills work'))}</span>
        <strong>${escapeHtmlLocal(t('Install a recipe. Approve every run.'))}</strong>
      </div>
      <div class="skills-guide-grid">
        <div>
          <strong>${escapeHtmlLocal(t('Library'))}</strong>
          <span>${escapeHtmlLocal(t('Browse shows curated and author-published skill manifests from the registry.'))}</span>
        </div>
        <div>
          <strong>${escapeHtmlLocal(t('Install'))}</strong>
          <span>${escapeHtmlLocal(t('Install stores caps, params, and a signed manifest snapshot. No funds move.'))}</span>
        </div>
        <div>
          <strong>${escapeHtmlLocal(t('Run'))}</strong>
          <span>${escapeHtmlLocal(t('The scheduler creates a Sign Approval item when due; your wallet signs each action.'))}</span>
        </div>
        <div>
          <strong>${escapeHtmlLocal(t('Share'))}</strong>
          <span>${escapeHtmlLocal(t('Your public URL is a receipt-backed track record for buyers and collaborators.'))}</span>
        </div>
      </div>
      <div class="skills-guide-footer">
        <span>${escapeHtmlLocal(t('Publish with'))} <code>agentic-skill init</code>, <code>agentic-skill test</code>, ${escapeHtmlLocal(t('then'))} <code>agentic-skill publish</code>.</span>
        <span>${escapeHtmlLocal(t('Delete an installed skill from the Installed tab with Uninstall.'))}</span>
      </div>
    </section>
    <details class="skills-guide skills-guide-mobile" aria-label="${escapeHtmlLocal(t('How skills work'))}">
      <summary>
        <span>${escapeHtmlLocal(t('How skills work'))}</span>
        <strong>${escapeHtmlLocal(t('Install. Approve. Share.'))}</strong>
      </summary>
      <div class="skills-guide-grid">
        <div>
          <strong>${escapeHtmlLocal(t('Install'))}</strong>
          <span>${escapeHtmlLocal(t('Recipes create approval requests; they never move funds alone.'))}</span>
        </div>
        <div>
          <strong>${escapeHtmlLocal(t('Share'))}</strong>
          <span>${escapeHtmlLocal(t('Your receipts become a public track record when you publish it.'))}</span>
        </div>
      </div>
    </details>
  `;
}

export function renderSkillsPanel(): string {
  const subTabs = listSkillsSubTabs();
  if (subTabs.length === 0) return renderEmptyPlaceholder();
  const activeId = String(getActiveSkillsSubTab());
  const active = findSkillsSubTab(activeId) ?? subTabs[0]!;
  return `
    <div class="skills-shell">
      ${renderSubTabPills(active.id as string)}
      ${renderSkillsGuide()}
      <div class="skills-active-panel" data-active-subtab="${escapeHtmlLocal(String(active.id))}">
        ${active.render()}
      </div>
    </div>
  `;
}

registerDevTab({
  id: 'skills',
  label: 'Skills',
  guard: () => true,
  render: renderSkillsPanel,
});
