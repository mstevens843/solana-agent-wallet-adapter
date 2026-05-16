import { afterEach, describe, expect, it, vi } from 'vitest';

import { legacyTabsEnabled } from '../legacyTabs.js';

describe('legacy tab feature flag', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('only enables legacy tabs for legacy-tabs=1', () => {
    vi.stubGlobal('window', { location: { href: 'https://wallet.example/?legacy-tabs=1' } });
    expect(legacyTabsEnabled()).toBe(true);

    vi.stubGlobal('window', { location: { href: 'https://wallet.example/?legacy-tabs=0' } });
    expect(legacyTabsEnabled()).toBe(false);
  });
});
