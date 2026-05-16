import { describe, expect, it } from 'vitest';

import { legacyTabsEnabled } from '../legacyTabs.js';

describe('legacy tab feature flag', () => {
  it('always enables legacy tabs', () => {
    expect(legacyTabsEnabled()).toBe(true);
  });
});
