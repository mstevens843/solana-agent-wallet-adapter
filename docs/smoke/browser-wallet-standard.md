# Browser Wallet Standard Smoke

Date: 2026-05-03

## Environment

- Repo: `solana-agent-wallet-adapter`
- Command: `pnpm smoke:web --host 127.0.0.1`
- URL tested: `http://localhost:5173/test.html`
- Browser wallet used: Backpack
- Cluster: devnet

## Result

The Wallet Standard browser backend completed the real-wallet happy path:

1. `List wallets` discovered Backpack, Phantom, MetaMask, Solflare, Jupiter, Magic Eden, and Leap Wallet.
2. `Get address` connected Backpack and returned:

```text
9W6pmAzjQGxNiu3yQAZ4dE1FwmvHexWEuWGdYZnnyEu1
```

3. `Sign 'hello' on devnet` opened the wallet approval flow and returned:

```json
{
  "signature": "AfVhSRZmGuomfo4P6Pop2h2tB4ZgRq17bCMQ1gbkUUid1AdWoRHpekWnRYGdiEsx4MBhE4dt94i3QcHjuoQwziV"
}
```

## Issues Fixed During Smoke

- `@solana-agent-wallet-adapter/core` imported `node:crypto`, which broke browser module loading through Vite. `newSigningRequestId()` now uses `globalThis.crypto.getRandomValues()`.
- `wallet-standard-web` had an unused import of `newSigningRequestId`, which forced the same browser-hostile module path into the backend bundle. The unused import was removed.
- `wallet-standard-web` used `Buffer` in transaction base64 helpers. The browser backend now uses `atob` and `btoa` so the transaction paths stay browser-native.
- The smoke harness did not show module-load failures in the page. It now reports initialization and runtime errors in the output panel.
- The smoke harness always selected the first registered wallet. It now includes a wallet selector after discovery, so Phantom, Solflare, Backpack, and other registered wallets can be tested explicitly.

## Follow-up

Repeat the same smoke with Phantom and Solflare selected in the wallet dropdown. The Backpack path confirms the backend protocol, discovery, connect, and sign-message lifecycle through a real Wallet Standard provider.
