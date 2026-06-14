import './skills.css';
import { registerDevTab } from '../devTabRegistry.js';
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
    <div class="skills-subtab-row" role="tablist" aria-label="Skills sections">
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
                <span class="skills-subtab-label-full">${escapeHtmlLocal(tab.label)}</span>
                <span class="skills-subtab-label-mobile">${escapeHtmlLocal(mobileLabel)}</span>
              </strong>
              <span class="skills-subtab-description">${escapeHtmlLocal(tab.description)}</span>
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
      <span class="skills-placeholder-tag">Skills unavailable</span>
      <h2>Skills Hub</h2>
      <p>
        The Skills container loaded, but no sections registered in this build. Rebuild the browser app
        with the Skills sub-tab modules included.
      </p>
      <div class="skills-placeholder-grid">
        <div class="skills-placeholder-card">
          <strong>Browse</strong>
          <span>Catalog of installable skills, sorted by track record.</span>
        </div>
        <div class="skills-placeholder-card">
          <strong>Installed</strong>
          <span>Active skills with next-run countdown, pause / resume, uninstall.</span>
        </div>
        <div class="skills-placeholder-card">
          <strong>My Profile</strong>
          <span>Public <code>/u/&lt;wallet&gt;</code> page aggregating receipts into a verifiable performance record.</span>
        </div>
        <div class="skills-placeholder-card">
          <strong>Publish</strong>
          <span>Author dashboard for uploading skills via <code>agentic-skill</code> CLI.</span>
        </div>
      </div>
    </div>
  `;
}

function renderSkillsGuide(): string {
  return `
    <section class="skills-guide skills-guide-desktop" aria-label="How skills work">
      <div class="skills-guide-heading">
        <span>How skills work</span>
        <strong>Install a recipe. Approve every run.</strong>
      </div>
      <div class="skills-guide-grid">
        <div>
          <strong>Library</strong>
          <span>Browse shows curated and author-published skill manifests from the registry.</span>
        </div>
        <div>
          <strong>Install</strong>
          <span>Install stores caps, params, and a signed manifest snapshot. No funds move.</span>
        </div>
        <div>
          <strong>Run</strong>
          <span>The scheduler creates a Needs Approval item when due; your wallet signs each action.</span>
        </div>
        <div>
          <strong>Share</strong>
          <span>Your public URL is a receipt-backed track record for buyers and collaborators.</span>
        </div>
      </div>
      <div class="skills-guide-footer">
        <span>Publish with <code>agentic-skill init</code>, <code>agentic-skill test</code>, then <code>agentic-skill publish</code>.</span>
        <span>Delete an installed skill from the Installed tab with Uninstall.</span>
      </div>
    </section>
    <details class="skills-guide skills-guide-mobile" aria-label="How skills work">
      <summary>
        <span>How skills work</span>
        <strong>Install. Approve. Share.</strong>
      </summary>
      <div class="skills-guide-grid">
        <div>
          <strong>Install</strong>
          <span>Recipes create approval requests; they never move funds alone.</span>
        </div>
        <div>
          <strong>Share</strong>
          <span>Your receipts become a public track record when you publish it.</span>
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
