// Wallet Standard icon for the Ledger adapter — a stylized Ledger nano
// silhouette in the project's accent palette.

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect x="12" y="20" width="40" height="24" rx="4" fill="#1a1a1a" stroke="#9ff0ba" stroke-width="2"/>
  <rect x="44" y="26" width="4" height="12" rx="1" fill="#9ff0ba"/>
  <circle cx="20" cy="32" r="2.4" fill="#7be39e"/>
  <circle cx="28" cy="32" r="2.4" fill="#7be39e" opacity="0.6"/>
  <circle cx="36" cy="32" r="2.4" fill="#7be39e" opacity="0.3"/>
</svg>
`.trim();

function encodeBase64(input: string): string {
  if (typeof btoa !== 'undefined') return btoa(input);
  return Buffer.from(input, 'utf8').toString('base64');
}

export const LEDGER_WALLET_ICON =
  `data:image/svg+xml;base64,${encodeBase64(SVG)}` as `data:image/svg+xml;base64,${string}`;
