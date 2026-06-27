// Per-brand picker panels for the Tauri desktop app (Slice D).
//
// Surfaces non-discoverable Solana wallet brands (Backpack / Phantom /
// Jupiter / Solflare) as expandable rows beneath the existing
// wallet picker. Each row offers three sub-actions: Scan QR (disabled until
// Slice E ships WalletConnect), Import recovery phrase (drives Slice C's
// overlay), and an opt-in external-browser fallback.
//
// Pure controller — no DOM, no Tauri, no `import.meta.url`. Tests in
// `__tests__/embeddedWalletBrandPanels.test.ts` exercise it directly.
// `main.ts` owns the bind handlers + state ownership.

export interface DesktopBrandDescriptor {
  /** Stable identifier used in `data-desktop-brand-id` attributes. */
  id: string;
  /** Human-readable brand label rendered in the row + button text. */
  name: string;
  /** Maps to the existing `BrandLogoId` table in `main.ts`. */
  logoId: string;
}

export const DESKTOP_BRAND_PANELS: readonly DesktopBrandDescriptor[] = [
  { id: 'backpack', name: 'Backpack', logoId: 'backpack' },
  { id: 'phantom', name: 'Phantom', logoId: 'phantom' },
  { id: 'jupiter', name: 'Jupiter', logoId: 'jupiter' },
  { id: 'solflare', name: 'Solflare', logoId: 'solflare' },
];

export interface DesktopBrandPanelsState {
  /** Brand id of the currently expanded row, or `null` if all collapsed. */
  expanded: string | null;
  /**
   * Inline preference: when true, every brand panel exposes the
   * "Use external browser wallet" button. Persisted by `main.ts` to
   * `localStorage`.
   */
  externalBrowserEnabled: boolean;
}

export type DesktopBrandPanelsAction =
  | { type: 'togglePanel'; brandId: string }
  | { type: 'collapseAll' }
  | { type: 'setExternalBrowserEnabled'; enabled: boolean };

export function initialDesktopBrandPanelsState(): DesktopBrandPanelsState {
  return { expanded: null, externalBrowserEnabled: false };
}

export function reduceDesktopBrandPanels(
  state: DesktopBrandPanelsState,
  action: DesktopBrandPanelsAction,
): DesktopBrandPanelsState {
  switch (action.type) {
    case 'togglePanel':
      // Accordion behaviour: clicking the open row closes it; clicking any
      // other row swaps the expanded id.
      if (state.expanded === action.brandId) {
        return { ...state, expanded: null };
      }
      return { ...state, expanded: action.brandId };
    case 'collapseAll':
      if (state.expanded === null) return state;
      return { ...state, expanded: null };
    case 'setExternalBrowserEnabled':
      if (state.externalBrowserEnabled === action.enabled) return state;
      return { ...state, externalBrowserEnabled: action.enabled };
  }
}

// ────────────────────────────────────────────────────────────────────────
// HTML factory
// ────────────────────────────────────────────────────────────────────────

export interface DesktopBrandPanelsRenderInput {
  state: DesktopBrandPanelsState;
  /** Override the default brand set (mainly for tests). */
  brands?: readonly DesktopBrandDescriptor[];
  /**
   * Resolves a `logoId` to a renderable URL. Optional; when omitted, rows
   * render a circular placeholder so the HTML is still valid in tests
   * (the test environment doesn't have asset URLs).
   */
  logoUrl?: (logoId: string) => string | null;
  /**
   * Returns true for brands whose Scan QR action is wired up (Slice E).
   * Brands without WC support keep the disabled "Coming soon" affordance.
   */
  scanQrEnabledFor?: (brandId: string) => boolean;
  /**
   * Optional Slice G addition: when set, a "Hardware wallets" section
   * appended beneath the brand rows surfaces a "Connect Ledger" CTA.
   * Caller pre-resolves the logo URL.
   */
  hardware?: {
    ledger?: {
      logoUrl: string | null;
    };
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function brandRow(
  brand: DesktopBrandDescriptor,
  state: DesktopBrandPanelsState,
  logoUrl?: (logoId: string) => string | null,
  scanQrEnabledFor?: (brandId: string) => boolean,
): string {
  const expanded = state.expanded === brand.id;
  const url = logoUrl ? logoUrl(brand.logoId) : null;
  const logo = url
    ? `<img class="embedded-wallet-brand-panel-logo" src="${escapeHtml(url)}" alt="" />`
    : `<span class="embedded-wallet-brand-panel-logo placeholder" aria-hidden="true"></span>`;

  const externalBrowserButton = state.externalBrowserEnabled
    ? `
        <button
          type="button"
          class="embedded-wallet-brand-panel-action external"
          data-desktop-brand-action="external-browser"
          data-desktop-brand-id="${escapeHtml(brand.id)}"
        >Use external browser wallet</button>`
    : '';

  const scanQrEnabled = scanQrEnabledFor ? scanQrEnabledFor(brand.id) : false;
  const scanQrButton = scanQrEnabled
    ? `
          <button
            type="button"
            class="embedded-wallet-brand-panel-action scan-qr"
            data-desktop-brand-action="scan-qr"
            data-desktop-brand-id="${escapeHtml(brand.id)}"
          >Scan QR with ${escapeHtml(brand.name)} mobile →</button>`
    : `
          <button
            type="button"
            class="embedded-wallet-brand-panel-action scan-qr"
            data-desktop-brand-action="scan-qr"
            data-desktop-brand-id="${escapeHtml(brand.id)}"
            disabled
            title="Coming in the next release (WalletConnect)"
          >
            Scan QR with ${escapeHtml(brand.name)} mobile
            <span class="embedded-wallet-brand-panel-soon">Coming soon</span>
          </button>`;

  return `
    <div class="embedded-wallet-brand-panel ${expanded ? 'expanded' : ''}">
      <button
        type="button"
        class="embedded-wallet-brand-panel-head"
        data-desktop-brand-action="toggle"
        data-desktop-brand-id="${escapeHtml(brand.id)}"
        aria-expanded="${expanded ? 'true' : 'false'}"
      >
        ${logo}
        <span class="embedded-wallet-brand-panel-name">${escapeHtml(brand.name)}</span>
        <span class="embedded-wallet-brand-panel-caret" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
      </button>
      ${expanded ? `
        <div class="embedded-wallet-brand-panel-body">
          ${scanQrButton}
          <button
            type="button"
            class="embedded-wallet-brand-panel-action import"
            data-desktop-brand-action="import"
            data-desktop-brand-id="${escapeHtml(brand.id)}"
          >Import ${escapeHtml(brand.name)} recovery phrase →</button>
          ${externalBrowserButton}
        </div>
      ` : ''}
    </div>
  `;
}

function hardwareSection(input: DesktopBrandPanelsRenderInput): string {
  const ledger = input.hardware?.ledger;
  if (!ledger) return '';
  const logo = ledger.logoUrl
    ? `<img class="embedded-wallet-hardware-logo" src="${escapeHtml(ledger.logoUrl)}" alt="" />`
    : `<span class="embedded-wallet-hardware-logo placeholder" aria-hidden="true"></span>`;
  return `
    <section class="embedded-wallet-hardware-section" aria-label="Hardware wallets">
      <header class="embedded-wallet-hardware-head">
        <h3>Hardware wallets</h3>
        <p>USB-HID device. Keys never leave the hardware.</p>
      </header>
      <button
        type="button"
        class="embedded-wallet-hardware-row"
        data-desktop-brand-action="connect-ledger"
      >
        ${logo}
        <span class="embedded-wallet-hardware-name">Ledger</span>
        <span class="embedded-wallet-hardware-cta">Connect Ledger →</span>
      </button>
    </section>
  `;
}

export function desktopBrandPanelsHtml(input: DesktopBrandPanelsRenderInput): string {
  const brands = input.brands ?? DESKTOP_BRAND_PANELS;
  const rows = brands
    .map((b) => brandRow(b, input.state, input.logoUrl, input.scanQrEnabledFor))
    .join('');
  return `
    <section class="embedded-wallet-brand-panels" aria-label="Other wallets on desktop">
      <header class="embedded-wallet-brand-panels-head">
        <h3>Other wallets &middot; desktop</h3>
        <p>Use your existing brand's recovery phrase or open it in a browser.</p>
      </header>
      <label class="embedded-wallet-brand-panels-pref">
        <input
          type="checkbox"
          data-desktop-brand-pref="external-browser"
          ${input.state.externalBrowserEnabled ? 'checked' : ''}
        />
        <span>Show external browser fallback (advanced)</span>
      </label>
      <div class="embedded-wallet-brand-panels-list">
        ${rows}
      </div>
      ${hardwareSection(input)}
    </section>
  `;
}
