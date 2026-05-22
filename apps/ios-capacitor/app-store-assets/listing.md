# Agentic iOS App Store Listing

Mirrors `apps/android-twa/play-assets/listing.md`; copy intentionally identical
where possible so cross-platform messaging stays consistent.

## Form Fields

Bundle Identifier:

```text
com.agentic.wallet
```

App Name (max 30 chars):

```text
Agentic
```

Subtitle (max 30 chars):

```text
Solana agent wallet signer
```

Promotional Text (max 170 chars):

```text
AI agents ask. Your Solana wallet signs. Plans, reviews, receipts — no key handoff.
```

Description (max 4000 chars):

```text
Agentic lets AI agents request Solana wallet actions while your existing wallet stays the signer. Agents can prepare messages, transactions, approvals, and receipts; your wallet reviews and signs. Built around Solana Wallet Standard, MCP, CLI, and AI framework adapters, with no private-key handoff.

On iOS, Agentic connects to Phantom, Solflare, and Backpack via encrypted deeplinks, and to Jupiter via WalletConnect v2. Every signature is performed in your own wallet — Agentic only prepares the request and surfaces the receipt.

Features:
- Multi-provider on-device AI runtime (Anthropic, OpenAI, Gemini)
- Plan → Review → Sign workflow with structured evidence
- Streaming session signers for sub-second voucher signing
- Biometric (Face ID / Touch ID) gating on sensitive actions
- Server-driven wallet routing — fixes ship without an App Store update
- Full Privacy Manifest disclosure; no tracking, no analytics on iOS native shell
```

## Keywords (max 100 chars, comma-separated)

```text
solana,wallet,ai agent,jupiter,phantom,solflare,backpack,defi,signer,walletconnect
```

## Assets

- App icon: `icon-1024.png` (1024×1024, no alpha, PNG)
- Screenshots (Fastlane-generated into `screenshots/`):
  - 6.7" iPhone 15 Pro Max — 1290×2796 (required)
  - 6.5" iPhone 11 Pro Max — 1242×2688 (required)
  - 5.5" iPhone 8 Plus — 1242×2208 (required if app was ever submitted to older sizes)
  - 12.9" iPad Pro — 2048×2732 (required if "Designed for iPad" is enabled)

## URLs (App Store Connect required)

- Privacy Policy: `https://agenticwalletadapter.com/privacy`
- Marketing URL: `https://agenticwalletadapter.com`
- Support URL: `https://agenticwalletadapter.com/support`

## App Privacy questionnaire

Per the team's existing data-disclosure stance (see `feedback_play_store_data_safety`
in stored decisions): mirror Phantom/Solflare disclosures; do not over-declare.

- Data collected: **None** linked to identity. Wallet addresses are user-generated
  on-device.
- Data used to track: **None**.
- Crypto transactions are not categorized as "Purchase history" — they are user-
  initiated wallet actions, equivalent to Phantom/Solflare disclosures.

## Compliance

- Encryption export: ITSAppUsesNonExemptEncryption = false (no custom crypto;
  all primitives via Apple CryptoKit + standard SSL).
- Age rating: 17+ (financial transactions).
- Category: Finance (primary), Utilities (secondary).
- App Store Review Notes: include demo account / TestFlight invite for the
  reviewer so they can test wallet flows without holding real funds.
