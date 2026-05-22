import { describe, expect, it } from 'vitest';

import {
  DESKTOP_BRAND_PANELS,
  desktopBrandPanelsHtml,
  initialDesktopBrandPanelsState,
  reduceDesktopBrandPanels,
  type DesktopBrandPanelsState,
} from '../embeddedWalletBrandPanels.js';

describe('initialDesktopBrandPanelsState', () => {
  it('starts collapsed with external-browser fallback off', () => {
    expect(initialDesktopBrandPanelsState()).toEqual({
      expanded: null,
      externalBrowserEnabled: false,
    });
  });
});

describe('reduceDesktopBrandPanels — togglePanel', () => {
  const initial = initialDesktopBrandPanelsState();

  it('expands a collapsed row', () => {
    const next = reduceDesktopBrandPanels(initial, {
      type: 'togglePanel',
      brandId: 'backpack',
    });
    expect(next.expanded).toBe('backpack');
  });

  it('collapses the row when clicked again (toggle)', () => {
    const open = reduceDesktopBrandPanels(initial, {
      type: 'togglePanel',
      brandId: 'phantom',
    });
    const closed = reduceDesktopBrandPanels(open, {
      type: 'togglePanel',
      brandId: 'phantom',
    });
    expect(closed.expanded).toBeNull();
  });

  it('clicking a different row collapses the first and opens the second (accordion)', () => {
    const a = reduceDesktopBrandPanels(initial, {
      type: 'togglePanel',
      brandId: 'jupiter',
    });
    const b = reduceDesktopBrandPanels(a, {
      type: 'togglePanel',
      brandId: 'solflare',
    });
    expect(b.expanded).toBe('solflare');
  });
});

describe('reduceDesktopBrandPanels — collapseAll', () => {
  it('returns the same state object when already collapsed (no churn)', () => {
    const initial = initialDesktopBrandPanelsState();
    const next = reduceDesktopBrandPanels(initial, { type: 'collapseAll' });
    expect(next).toBe(initial);
  });

  it('collapses any expanded row', () => {
    const open = reduceDesktopBrandPanels(initialDesktopBrandPanelsState(), {
      type: 'togglePanel',
      brandId: 'magicEden',
    });
    const closed = reduceDesktopBrandPanels(open, { type: 'collapseAll' });
    expect(closed.expanded).toBeNull();
  });
});

describe('reduceDesktopBrandPanels — setExternalBrowserEnabled', () => {
  it('flips the preference and preserves expansion', () => {
    const open = reduceDesktopBrandPanels(initialDesktopBrandPanelsState(), {
      type: 'togglePanel',
      brandId: 'phantom',
    });
    const enabled = reduceDesktopBrandPanels(open, {
      type: 'setExternalBrowserEnabled',
      enabled: true,
    });
    expect(enabled.externalBrowserEnabled).toBe(true);
    expect(enabled.expanded).toBe('phantom');
  });

  it('is idempotent when toggling to the same value', () => {
    const before = initialDesktopBrandPanelsState();
    const same = reduceDesktopBrandPanels(before, {
      type: 'setExternalBrowserEnabled',
      enabled: false,
    });
    expect(same).toBe(before);
  });
});

describe('desktopBrandPanelsHtml', () => {
  const collapsed = initialDesktopBrandPanelsState();

  it('renders the section header and preference checkbox', () => {
    const html = desktopBrandPanelsHtml({ state: collapsed });
    expect(html).toContain('Other wallets');
    expect(html).toContain('data-desktop-brand-pref="external-browser"');
    expect(html).not.toContain('checked');
  });

  it('shows the preference checkbox as checked when externalBrowserEnabled is true', () => {
    const html = desktopBrandPanelsHtml({
      state: { ...collapsed, externalBrowserEnabled: true },
    });
    // The checkbox carries `checked`; the markup contains exactly that attribute on the input.
    expect(html).toMatch(/<input[^>]*data-desktop-brand-pref="external-browser"[^>]*checked/);
  });

  it('renders all five default brand rows', () => {
    const html = desktopBrandPanelsHtml({ state: collapsed });
    for (const brand of DESKTOP_BRAND_PANELS) {
      expect(html).toContain(`data-desktop-brand-id="${brand.id}"`);
      expect(html).toContain(brand.name);
    }
  });

  it('keeps all rows collapsed when no expanded id is set', () => {
    const html = desktopBrandPanelsHtml({ state: collapsed });
    expect(html).not.toContain('Scan QR');
    expect(html).not.toContain('Import ');
  });

  it('expands only the matching row when expanded id is set', () => {
    const expanded: DesktopBrandPanelsState = { ...collapsed, expanded: 'phantom' };
    const html = desktopBrandPanelsHtml({ state: expanded });
    expect(html).toContain('Scan QR with Phantom mobile');
    expect(html).toContain('Import Phantom recovery phrase →');
    // Backpack stays collapsed
    expect(html).not.toContain('Import Backpack recovery phrase');
  });

  it('renders Scan QR button as disabled with a "coming soon" affordance', () => {
    const expanded: DesktopBrandPanelsState = { ...collapsed, expanded: 'backpack' };
    const html = desktopBrandPanelsHtml({ state: expanded });
    expect(html).toMatch(/data-desktop-brand-action="scan-qr"[^>]*disabled/);
    expect(html).toContain('Coming soon');
  });

  it('hides the external-browser button when toggle is OFF', () => {
    const expanded: DesktopBrandPanelsState = { ...collapsed, expanded: 'jupiter' };
    const html = desktopBrandPanelsHtml({ state: expanded });
    expect(html).not.toContain('Use external browser wallet');
    expect(html).not.toContain('data-desktop-brand-action="external-browser"');
  });

  it('shows the external-browser button on the expanded row when toggle is ON', () => {
    const expanded: DesktopBrandPanelsState = {
      expanded: 'solflare',
      externalBrowserEnabled: true,
    };
    const html = desktopBrandPanelsHtml({ state: expanded });
    expect(html).toContain('Use external browser wallet');
    // Attributes may be split across lines; match the action+id pair tolerantly.
    expect(html).toMatch(
      /data-desktop-brand-action="external-browser"[\s\S]*?data-desktop-brand-id="solflare"/,
    );
  });

  it('uses the logoUrl resolver when provided', () => {
    const expanded: DesktopBrandPanelsState = { ...collapsed, expanded: 'backpack' };
    const html = desktopBrandPanelsHtml({
      state: expanded,
      logoUrl: (id) => `/static/logos/${id}.svg`,
    });
    expect(html).toContain('src="/static/logos/backpack.svg"');
  });

  it('falls back to a placeholder when logoUrl returns null or is omitted', () => {
    const html = desktopBrandPanelsHtml({
      state: collapsed,
      logoUrl: () => null,
    });
    expect(html).toContain('embedded-wallet-brand-panel-logo placeholder');
    expect(html).not.toContain('<img class="embedded-wallet-brand-panel-logo"');
  });

  it('marks the expanded row with aria-expanded="true"', () => {
    const expanded: DesktopBrandPanelsState = { ...collapsed, expanded: 'magicEden' };
    const html = desktopBrandPanelsHtml({ state: expanded });
    expect(html).toMatch(/data-desktop-brand-id="magicEden"[^>]*aria-expanded="true"/);
    expect(html).toMatch(/data-desktop-brand-id="backpack"[^>]*aria-expanded="false"/);
  });

  it('escapes the brand name in the rendered markup', () => {
    const expanded: DesktopBrandPanelsState = { ...collapsed, expanded: 'hostile' };
    const html = desktopBrandPanelsHtml({
      state: expanded,
      brands: [{ id: 'hostile', name: '<script>alert(1)</script>', logoId: 'agentic' }],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not render the hardware-wallets section when no hardware prop is supplied', () => {
    const html = desktopBrandPanelsHtml({ state: collapsed });
    expect(html).not.toContain('Hardware wallets');
    expect(html).not.toContain('data-desktop-brand-action="connect-ledger"');
  });

  it('renders the Ledger hardware row when hardware.ledger is supplied', () => {
    const html = desktopBrandPanelsHtml({
      state: collapsed,
      hardware: { ledger: { logoUrl: '/logos/ledger.svg' } },
    });
    expect(html).toContain('Hardware wallets');
    expect(html).toContain('data-desktop-brand-action="connect-ledger"');
    expect(html).toContain('src="/logos/ledger.svg"');
    expect(html).toContain('Connect Ledger');
  });

  it('falls back to a placeholder when ledger logoUrl is null', () => {
    const html = desktopBrandPanelsHtml({
      state: collapsed,
      hardware: { ledger: { logoUrl: null } },
    });
    expect(html).toContain('embedded-wallet-hardware-logo placeholder');
    expect(html).not.toContain('<img class="embedded-wallet-hardware-logo"');
  });
});
