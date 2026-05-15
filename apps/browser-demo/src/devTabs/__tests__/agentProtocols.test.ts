import { afterEach, describe, expect, it } from 'vitest';

import { __agentProtocolsForTests } from '../agentProtocols.js';

describe('Agent Payments dev tab', () => {
  afterEach(() => {
    __agentProtocolsForTests.setActiveSubTab('agent-card');
  });

  it('renders the agent payment sections as a New Request-style segmented control', () => {
    __agentProtocolsForTests.setActiveSubTab('pay-out');

    const html = __agentProtocolsForTests.renderAgentProtocolsPanel();

    expect(html).toContain('one-time-method-control agent-protocols-tab-control');
    expect(html).toContain('<strong>Agent Payments</strong>');
    expect(html).toContain('Profile, send, receive');
    expect(html).toContain('template-filter-row one-time-method-filter agent-protocols-tab-list');
    expect(html).toContain('data-agent-protocols-subtab="agent-card"');
    expect(html).toContain('data-agent-protocols-subtab="pay-out"');
    expect(html).toContain('data-agent-protocols-subtab="external-agents"');
    expect(html).toContain('data-active-agent-protocols-subtab="pay-out"');
    expect(html).toContain('<h2>Pay Out</h2>');
  });
});
