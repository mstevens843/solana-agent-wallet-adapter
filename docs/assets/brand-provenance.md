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
| `gemini.svg` | Gemini AI provider context | Wikimedia Commons `Google_Gemini_icon_2025.svg`; attributed there to Google LLC. Verify trademark/source before production release. |
| `agent-router.svg` | Generic AI gateway/router context for OpenRouter/custom providers | Original project artwork; not an OpenRouter trademark. |
| `vercel.svg` | Vercel runtime context | Provider-site reference required before production release |
| `jito.svg` | Jito liquid staking connector context | SVG mark adapted from the Realms official integration logo at `https://app.realms.today/images/logos/jito.svg`; Jito homepage access was Cloudflare-blocked during verification. Re-verify with Jito brand assets before production release. |
| `marinade.svg` | Marinade liquid staking connector context | Marinade official press kit was checked at `https://docs.marinade.finance/partnerships/marinade-press-kit`; SVG mark adapted from the Realms official integration logo at `https://app.realms.today/images/logos/marinade.svg` because the press kit surfaced PNG assets during verification. |
| `sanctum.svg` | Sanctum LST and Infinity connector context | Official Sanctum docs press-kit asset from `https://learn.sanctum.so/docs/misc/press-kit` (`Cloud Symbol (Circle, Blue).svg`). |
| `magiceden.svg` | Magic Eden NFT marketplace connector context | Official Magic Eden homepage inline header mark from `https://magiceden.io`; visually cross-checked with the site maskable icon. |
| `tensor.svg` | Tensor NFT marketplace connector context | Vector recreation from Tensor official homepage OG/logo image at `https://www.tensor.trade`; re-verify against a first-party SVG before production release. |
| `wormhole.svg` | Wormhole bridge connector context | Official Wormhole brand-and-press logomark from `https://wormhole.com/brand-and-press`. |
| `mayan.svg` | Mayan cross-chain swap connector context | Official Mayan docs logo SVG loaded from the Mintlify-backed docs site at `https://docs.mayan.finance/`. |
| `pyth.svg` | Pyth oracle connector context | SVG mark adapted from the Realms official integration logo at `https://app.realms.today/images/logos/pyth.svg`; re-verify against Pyth brand assets before production release. |
| `squads.svg` | Squads multisig connector context | Vector recreation from the official Squads site favicon/mark at `https://squads.so`; re-verify against a first-party SVG before production release. |
| `realms.svg` | Realms governance connector context | Official Realms app logo from `https://app.realms.today/img/logo-realms.svg`. |

## Fallback Rule

If any provider source, permission, or trademark status is unclear during release review, remove that SVG from
`BRAND_LOGOS` in `apps/browser-demo/src/main.ts` and let the UI render text-only chips. Do not replace these with random
logo aggregator assets.
