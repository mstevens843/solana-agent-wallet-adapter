import { describe, expect, it, vi } from 'vitest';

// vi.mock() is hoisted to the top of the file by vitest. The factory cannot
// reference top-level identifiers from this file (they aren't initialized
// when the factory runs). Mirror the existing externalAgents.test.ts pattern:
// inline the dev-wallet literal inside the factory.
vi.mock('../../devGate.js', () => ({
  DEV_LAYER1_ENABLED: true,
  DEV_WALLET_ALLOWLIST: Object.freeze(['4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd']),
  isDevWallet: (addr?: string | null) => addr === '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
}));

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

import { findDevTab, listDevTabs } from '../../devTabRegistry.js';
import { setConnectedAddress } from '../../walletState.js';
import '../sessions.js';

describe('sessions devTab scaffolding', () => {
  it('registers the sessions tab with the registry', () => {
    const tab = findDevTab('sessions');
    expect(tab).toBeDefined();
    expect(tab?.label).toBe('Sessions');
  });

  it('appears in listDevTabs output', () => {
    const ids = listDevTabs().map((t) => t.id);
    expect(ids).toContain('sessions');
  });

  it('guard returns true when a dev wallet is connected', () => {
    const tab = findDevTab('sessions');
    expect(tab).toBeDefined();
    if (!tab) return;
    setConnectedAddress(DEV_WALLET);
    try {
      expect(tab.guard()).toBe(true);
    } finally {
      setConnectedAddress(undefined);
    }
  });

  it('render returns Phase 0 placeholder markup', () => {
    const tab = findDevTab('sessions');
    expect(tab).toBeDefined();
    const html = tab?.render() ?? '';
    expect(html).toContain('Sessions');
    expect(html).toContain('Coming soon');
  });
});
