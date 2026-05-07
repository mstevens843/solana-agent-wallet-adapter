# Brand Asset Provenance

This repo uses `Agentic` as the original public brand. The Saturn-style Agentic mark in
`apps/browser-demo/public/icons/agentic.svg` and `apps/browser-demo/src/assets/logos/agentic-orbit.svg` is original
project artwork.

Third-party marks in `apps/browser-demo/src/assets/logos/` are used only as compact integration or wallet identifiers.
Each production release review must verify the source below or remove the SVG import and use the existing text chip.

## Checked-In Marks

| File | Usage | Source status |
| --- | --- | --- |
| `solana.svg` | Solana network and Wallet Standard context | Official Solana brand page: `https://solana.com/branding` |
| `solana-mobile.svg` | Android MWA and Seed Vault context | Provider-site reference required before production release |
| `solana-mobile-wordmark.svg` | Solana Mobile docs/wordmark context | Provider-site reference required before production release |
| `phantom.svg` | Phantom wallet context | Provider-site reference required before production release |
| `solflare.svg` | Solflare wallet context | Provider-site reference required before production release |
| `backpack.svg` | Backpack wallet context | Provider-site reference required before production release |
| `jupiter.svg` | Jupiter Mobile wallet/swap context | Provider-site reference required before production release |
| `claude.svg` | Claude agent runtime context | Provider-site reference required before production release |
| `codex.svg` | Codex/OpenAI agent runtime context | Provider-site reference required before production release |
| `vercel.svg` | Vercel runtime context | Provider-site reference required before production release |

## Fallback Rule

If any provider source, permission, or trademark status is unclear during release review, remove that SVG from
`BRAND_LOGOS` in `apps/browser-demo/src/main.ts` and let the UI render text-only chips. Do not replace these with random
logo aggregator assets.
