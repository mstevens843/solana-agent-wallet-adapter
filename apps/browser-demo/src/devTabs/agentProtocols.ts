import './agentProtocols.css';
import { registerDevTab } from '../devTabRegistry.js';
import { t, tf } from '../demo-i18n/uiLang.js';
import { renderAgentCardPanel } from './agentCard.js';
import { fetchInbound, renderExternalAgentsPanel } from './externalAgents.js';
import { renderPayOutPanel } from './payOut.js';

type AgentProtocolsSubTabId = 'agent-card' | 'pay-out' | 'external-agents';

interface AgentProtocolsSubTab {
  id: AgentProtocolsSubTabId;
  label: string;
  mobileLabel: string;
  description: string;
  render: () => string;
  onActivate?: () => void;
}

const subTabs: readonly AgentProtocolsSubTab[] = [
  {
    id: 'agent-card',
    label: 'Profile',
    mobileLabel: 'Profile',
    description: 'How compatible apps discover this wallet',
    render: renderAgentCardPanel,
  },
  {
    id: 'pay-out',
    label: 'Pay Merchant',
    mobileLabel: 'Pay',
    description: 'Review a merchant cart and pay from this wallet',
    render: renderPayOutPanel,
  },
  {
    id: 'external-agents',
    label: 'Incoming Requests',
    mobileLabel: 'Incoming',
    description: 'Review payment requests sent to this wallet',
    render: renderExternalAgentsPanel,
    onActivate: () => {
      void fetchInbound(true);
    },
  },
];

let activeSubTabId: AgentProtocolsSubTabId = 'external-agents';

const hotModule = (import.meta as ImportMeta & {
  hot?: { accept: (callback: () => void) => void };
}).hot;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
    : c === '<' ? '&lt;'
    : c === '>' ? '&gt;'
    : c === '"' ? '&quot;'
    : '&#39;',
  );
}

function findSubTab(id: string): AgentProtocolsSubTab | undefined {
  return subTabs.find((tab) => tab.id === id);
}

function renderSubTabButton(tab: AgentProtocolsSubTab): string {
  const active = tab.id === activeSubTabId;
  return `
    <button
      type="button"
      class="${active ? 'active' : ''}"
      role="tab"
      aria-selected="${active ? 'true' : 'false'}"
      title="${escapeHtml(t(tab.description))}"
      data-agent-protocols-subtab="${escapeHtml(tab.id)}"
    >
      <span class="agent-protocols-label-full">${escapeHtml(t(tab.label))}</span>
      <span class="agent-protocols-label-mobile">${escapeHtml(t(tab.mobileLabel))}</span>
    </button>
  `;
}

function renderSubTabControl(): string {
  return `
    <div class="one-time-method-control agent-protocols-tab-control" role="presentation">
      <span class="one-time-method-label">
        <strong>${t('Agent Payments')}</strong>
        <em class="accent-note">${t('Profile, pay, receive')}</em>
      </span>
      <div class="template-filter-row one-time-method-filter agent-protocols-tab-list" role="tablist" aria-label="${escapeHtml(t('Agent payment sections'))}">
        ${subTabs.map(renderSubTabButton).join('')}
      </div>
    </div>
  `;
}

export function renderAgentProtocolsPanel(): string {
  const active = findSubTab(activeSubTabId) ?? subTabs[0]!;
  activeSubTabId = active.id;
  return `
    <div class="agent-protocols-shell" data-agent-protocols-root>
      ${renderSubTabControl()}
      <div class="agent-protocols-active-panel" role="tabpanel" data-active-agent-protocols-subtab="${escapeHtml(active.id)}">
        ${active.render()}
      </div>
    </div>
  `;
}

function rerenderPanelOnly(): void {
  if (typeof document === 'undefined') return;
  const root = document.querySelector('[data-agent-protocols-root]');
  if (!root || !root.parentNode) return;
  const template = document.createElement('template');
  template.innerHTML = renderAgentProtocolsPanel().trim();
  const next = template.content.firstElementChild;
  if (next) root.replaceWith(next);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const trigger = target.closest<HTMLElement>('[data-agent-protocols-subtab]');
    if (!trigger) return;
    const id = trigger.dataset.agentProtocolsSubtab;
    if (!id || !findSubTab(id)) return;
    event.preventDefault();
    const tab = findSubTab(id);
    if (!tab) return;
    activeSubTabId = id as AgentProtocolsSubTabId;
    rerenderPanelOnly();
    tab.onActivate?.();
  });
}

if (hotModule) {
  hotModule.accept(() => {
    rerenderPanelOnly();
  });
}

registerDevTab({
  id: 'agent-protocols',
  // Raw English — the nav re-wraps with t(item.label) at render (t() here would freeze at import time).
  label: 'Agent Payments',
  mobileLabel: 'Agents',
  guard: () => true,
  render: renderAgentProtocolsPanel,
});

export const __agentProtocolsForTests = {
  getActiveSubTab: (): AgentProtocolsSubTabId => activeSubTabId,
  setActiveSubTab(id: AgentProtocolsSubTabId): void {
    activeSubTabId = id;
  },
  renderAgentProtocolsPanel,
};
