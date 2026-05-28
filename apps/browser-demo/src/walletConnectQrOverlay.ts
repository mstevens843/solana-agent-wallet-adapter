// Pure controller for the WalletConnect QR pairing overlay (Slice E).
//
// Same shape as `embeddedWalletOverlay.ts` and `embeddedWalletBrandPanels.ts`
// — state + reducer + HTML factory + brand metadata. No DOM, no Tauri, no
// `qrcode` runtime: `main.ts` generates the QR data URL and dispatches it
// in via `setQrDataUrl`.

export type WalletConnectQrOverlayMode =
  | 'closed'
  /** Lazily starting SignClient.init; not yet awaiting a URI. */
  | 'connecting'
  /** URI generated, waiting for the user's mobile wallet to approve. */
  | 'awaiting-scan'
  /** Approval received, finishing wallet registration + auto-connect. */
  | 'completing'
  | 'error';

export interface WalletConnectQrOverlayState {
  mode: WalletConnectQrOverlayMode;
  /** Which brand initiated this pairing (e.g. 'phantom'). */
  brandId: string | null;
  /** Raw WalletConnect pairing URI (the `wc:…` string). */
  uri: string | null;
  /** Pre-rendered QR data URL (`data:image/png;base64,…`). */
  qrDataUrl: string | null;
  /** Last error message rendered inline. */
  error: string;
}

export interface WalletConnectBrandDescriptor {
  id: string;
  name: string;
  /**
   * Deep-link prefix the mobile wallet listens on. The pairing URI is
   * URL-encoded and appended for same-device launches.
   */
  deepLinkPrefix: string;
  /** Maps to the existing BrandLogoId table in main.ts (resolved at render). */
  logoId: string;
}

export const WALLET_CONNECT_BRANDS: Record<string, WalletConnectBrandDescriptor> = {
  phantom: {
    id: 'phantom',
    name: 'Phantom',
    deepLinkPrefix: 'phantom://wc?uri=',
    logoId: 'phantom',
  },
  solflare: {
    id: 'solflare',
    name: 'Solflare',
    deepLinkPrefix: 'solflare://wc?uri=',
    logoId: 'solflare',
  },
  backpack: {
    id: 'backpack',
    name: 'Backpack',
    deepLinkPrefix: 'backpack://wc?uri=',
    logoId: 'backpack',
  },
  jupiter: {
    id: 'jupiter',
    name: 'Jupiter',
    deepLinkPrefix: 'jupiter://wc?uri=',
    logoId: 'jupiter',
  },
  magicEden: {
    id: 'magicEden',
    name: 'Magic Eden',
    deepLinkPrefix: 'magiceden://wc?uri=',
    logoId: 'magiceden',
  },
};

/** Brands whose Scan QR button is functional in this slice. */
export function isWalletConnectSupportedBrand(brandId: string): boolean {
  return brandId in WALLET_CONNECT_BRANDS;
}

export function initialWalletConnectQrOverlayState(): WalletConnectQrOverlayState {
  return {
    mode: 'closed',
    brandId: null,
    uri: null,
    qrDataUrl: null,
    error: '',
  };
}

// ────────────────────────────────────────────────────────────────────────
// Reducer
// ────────────────────────────────────────────────────────────────────────

export type WalletConnectQrOverlayAction =
  | { type: 'openConnecting'; brandId: string }
  | { type: 'setUri'; uri: string; qrDataUrl: string }
  | { type: 'completing' }
  | { type: 'setError'; error: string }
  | { type: 'close' };

export function reduceWalletConnectQrOverlay(
  state: WalletConnectQrOverlayState,
  action: WalletConnectQrOverlayAction,
): WalletConnectQrOverlayState {
  switch (action.type) {
    case 'openConnecting':
      return {
        mode: 'connecting',
        brandId: action.brandId,
        uri: null,
        qrDataUrl: null,
        error: '',
      };
    case 'setUri':
      // Only meaningful while still pairing.
      if (state.mode !== 'connecting' && state.mode !== 'awaiting-scan') {
        return state;
      }
      return {
        ...state,
        mode: 'awaiting-scan',
        uri: action.uri,
        qrDataUrl: action.qrDataUrl,
        error: '',
      };
    case 'completing':
      if (state.mode === 'closed') return state;
      return { ...state, mode: 'completing', error: '' };
    case 'setError':
      return { ...state, mode: 'error', error: action.error };
    case 'close':
      return initialWalletConnectQrOverlayState();
  }
}

// ────────────────────────────────────────────────────────────────────────
// HTML factory
// ────────────────────────────────────────────────────────────────────────

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

export interface WalletConnectQrOverlayRenderInput {
  state: WalletConnectQrOverlayState;
  /**
   * Resolves a `brandId` to a brand descriptor. Defaults to the built-in
   * `WALLET_CONNECT_BRANDS` map.
   */
  brand?: (brandId: string) => WalletConnectBrandDescriptor | undefined;
  /** Resolves a logoId to an image URL (for `<img src>`). */
  logoUrl?: (logoId: string) => string | null;
  /**
   * When true, render brand-agnostic copy ("Scan with your Solana mobile
   * wallet") and omit the brand-specific deep-link button + logo. Used by
   * the desktop Discover flow where the user hasn't pre-picked a wallet —
   * the wallet identifies itself in the session response post-approval.
   */
  agnostic?: boolean;
  /** Render copy for desktop app vs website/browser contexts. */
  surface?: 'desktop' | 'website';
  /** On mobile web, put the same-device wallet launch before the QR. */
  preferDeepLink?: boolean;
}

function brandPlaceholder(): WalletConnectBrandDescriptor {
  return { id: 'unknown', name: 'WalletConnect', deepLinkPrefix: '', logoId: '' };
}

function bodyForMode(
  state: WalletConnectQrOverlayState,
  brand: WalletConnectBrandDescriptor,
  logoUrl?: (logoId: string) => string | null,
  agnostic?: boolean,
  surface: 'desktop' | 'website' = 'desktop',
  preferDeepLink = false,
): string {
  const promptName = agnostic ? 'your Solana mobile wallet' : `${brand.name} mobile`;
  const completingName = agnostic ? 'your wallet' : brand.name;
  const footnoteName = agnostic ? 'your Solana mobile wallet (Phantom, Solflare, Backpack, Jupiter, Magic Eden, …)' : `${brand.name} mobile app`;
  const targetLabel = surface === 'website' ? 'this browser session' : 'this desktop app';
  if (state.mode === 'connecting') {
    return `<p class="walletconnect-qr-overlay-lede">Preparing a WalletConnect session${agnostic ? '' : ` with ${escapeHtml(brand.name)}`}…</p>`;
  }
  if (state.mode === 'completing') {
    return `<p class="walletconnect-qr-overlay-lede">Linking ${escapeHtml(completingName)} to ${escapeHtml(targetLabel)}…</p>`;
  }
  if (state.mode === 'error') {
    return `
      <p class="walletconnect-qr-overlay-error" role="alert">${escapeHtml(state.error || 'Pairing failed.')}</p>
      <div class="walletconnect-qr-overlay-actions">
        <button type="button" class="utility" data-walletconnect-action="cancel">Close</button>
      </div>
    `;
  }
  // awaiting-scan
  const uri = state.uri ?? '';
  const qr = state.qrDataUrl;
  // Brand-specific deep-link only matters for same-device launches; the
  // agnostic desktop flow always cross-device scans, so omit it entirely.
  const deepLink = !agnostic && brand.deepLinkPrefix
    ? `${brand.deepLinkPrefix}${encodeURIComponent(uri)}`
    : '';
  const qrMarkup = qr
    ? `<img class="walletconnect-qr-overlay-qr" src="${escapeHtml(qr)}" alt="" />`
    : `<div class="walletconnect-qr-overlay-qr placeholder" aria-hidden="true"></div>`;
  const brandLogoUrl = !agnostic && logoUrl ? logoUrl(brand.logoId) : null;
  const brandLogo = brandLogoUrl
    ? `<img class="walletconnect-qr-overlay-brand-logo" src="${escapeHtml(brandLogoUrl)}" alt="" />`
    : '';
  const deepLinkAction = deepLink
    ? `<a class="utility walletconnect-qr-overlay-open-wallet" href="${escapeHtml(deepLink)}" data-walletconnect-action="open-deeplink">Open ${escapeHtml(brand.name)}</a>`
    : '';
  return `
    <div class="walletconnect-qr-overlay-brand">${brandLogo}<span>Scan with ${escapeHtml(promptName)}</span></div>
    ${preferDeepLink && deepLinkAction ? `<div class="walletconnect-qr-overlay-mobile-open">${deepLinkAction}</div>` : ''}
    ${qrMarkup}
    <div class="walletconnect-qr-overlay-actions">
      ${!preferDeepLink ? deepLinkAction : ''}
      <button type="button" class="utility" data-walletconnect-action="copy-uri">Copy URI</button>
      <button type="button" class="utility" data-walletconnect-action="cancel">Cancel</button>
    </div>
    <p class="walletconnect-qr-overlay-footnote">${preferDeepLink && deepLinkAction ? `Open ${escapeHtml(brand.name)} on this device, or scan the code with ${escapeHtml(footnoteName)}.` : `Scan the code with ${escapeHtml(footnoteName)}.`} The pairing happens over the WalletConnect relay; your keys never leave your phone.</p>
  `;
}

export function walletConnectQrOverlayHtml(
  input: WalletConnectQrOverlayRenderInput,
): string {
  const { state } = input;
  if (state.mode === 'closed') return '';
  const brand =
    (state.brandId && (input.brand ?? ((id) => WALLET_CONNECT_BRANDS[id]))(state.brandId)) ||
    brandPlaceholder();
  const agnostic = Boolean(input.agnostic);
  const title = agnostic
    ? state.mode === 'error'
      ? "Couldn't pair WalletConnect"
      : 'Connect via WalletConnect'
    : state.mode === 'error'
      ? `Couldn't pair ${brand.name}`
      : `Connect ${brand.name} via WalletConnect`;
  return `
    <div class="walletconnect-qr-overlay-scrim" data-walletconnect-action="cancel" aria-hidden="true"></div>
    <aside class="walletconnect-qr-overlay" role="dialog" aria-modal="true" aria-labelledby="walletconnect-qr-overlay-title">
      <header class="walletconnect-qr-overlay-head">
        <h2 id="walletconnect-qr-overlay-title">${escapeHtml(title)}</h2>
        <button type="button" class="walletconnect-qr-overlay-close" data-walletconnect-action="cancel" aria-label="Close">&times;</button>
      </header>
      <div class="walletconnect-qr-overlay-body">
        ${bodyForMode(state, brand, input.logoUrl, agnostic, input.surface ?? 'desktop', Boolean(input.preferDeepLink))}
      </div>
    </aside>
  `;
}

/**
 * Returns the same QR / scan-status markup as `walletConnectQrOverlayHtml`
 * but without the modal scrim and `<aside role="dialog">` wrapper. The
 * desktop rail renders this inline inside its discover-flow panel; the same
 * `data-walletconnect-action` handlers still apply.
 */
export function walletConnectQrBodyHtml(
  input: WalletConnectQrOverlayRenderInput,
): string {
  const { state } = input;
  if (state.mode === 'closed') return '';
  const brand =
    (state.brandId && (input.brand ?? ((id) => WALLET_CONNECT_BRANDS[id]))(state.brandId)) ||
    brandPlaceholder();
  return bodyForMode(
    state,
    brand,
    input.logoUrl,
    Boolean(input.agnostic),
    input.surface ?? 'desktop',
    Boolean(input.preferDeepLink),
  );
}
