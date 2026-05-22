// Wallet Standard icon: a Saturn-themed SVG matching the Agentic brand
// (per the user's memory, the green Saturn variant is used in the agentic
// pitch surfaces). Encoded as a base64 data URI so the picker can render it
// without a separate asset fetch.
//
// The SVG is intentionally tiny and self-contained — Wallet Standard's
// `icon` field is a data URI passed to `<img src=...>` in the picker.

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <defs>
    <radialGradient id="g" cx="32" cy="28" r="22" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#7be39e"/>
      <stop offset="65%" stop-color="#1f8a4a"/>
      <stop offset="100%" stop-color="#0b3a20"/>
    </radialGradient>
  </defs>
  <circle cx="32" cy="32" r="14" fill="url(#g)"/>
  <ellipse cx="32" cy="32" rx="26" ry="6" stroke="#9ff0ba" stroke-width="2.4" fill="none" transform="rotate(-18 32 32)"/>
  <ellipse cx="32" cy="32" rx="22" ry="5" stroke="#bff7d0" stroke-width="1.2" fill="none" opacity="0.6" transform="rotate(-18 32 32)"/>
</svg>
`.trim();

function encodeBase64(input: string): string {
  if (typeof btoa !== 'undefined') return btoa(input);
  return Buffer.from(input, 'utf8').toString('base64');
}

export const AGENTIC_WALLET_ICON =
  `data:image/svg+xml;base64,${encodeBase64(SVG)}` as `data:image/svg+xml;base64,${string}`;
