# Browser Wallet Standard Smoke

Date: 2026-05-03

## Environment

- Repo: `solana-agent-wallet-adapter`
- Command: `pnpm demo:browser`
- URL tested: `http://127.0.0.1:5174/`
- Browser wallet used: Backpack
- Cluster: devnet

## Harness Result

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

## Polished Demo Result

The polished browser demo at `http://127.0.0.1:5174` was also tested on devnet.

Verified flow:

1. `Agent Plan` discovered Wallet Standard providers.
2. Phantom was selected for an agent plan.
3. `Generate plan` created a capped SOL to USDC approval plan.
4. `Sign agent approval` opened Phantom and returned a real message signature.
5. `Wallet Flow` switched to Backpack through Wallet Standard.
6. Backpack signed the demo message.
7. `Create demo transaction` built a base64 devnet memo transaction.
8. `Sign transaction` opened Backpack and returned signed transaction bytes without broadcasting.
9. `Sign and send` opened Backpack and returned a devnet transaction id after RPC broadcast.

Important distinction: the `Agent Plan` tab queues a prepared swap approval into the local Approval Inbox. The final transaction is still rebuilt later at inbox approval time, so no swap executes from plan generation alone.

## Issues Fixed During Smoke

- `@solana-agent-wallet-adapter/core` imported `node:crypto`, which broke browser module loading through Vite. `newSigningRequestId()` now uses `globalThis.crypto.getRandomValues()`.
- `wallet-standard-web` had an unused import of `newSigningRequestId`, which forced the same browser-hostile module path into the backend bundle. The unused import was removed.
- `wallet-standard-web` used `Buffer` in transaction base64 helpers. The browser backend now uses `atob` and `btoa` so the transaction paths stay browser-native.
- The smoke harness did not show module-load failures in the page. It now reports initialization and runtime errors in the output panel.
- The smoke harness always selected the first registered wallet. It now includes a wallet selector after discovery, so Phantom, Solflare, Backpack, and other registered wallets can be tested explicitly.
- Backpack native sign-and-send can fail in the wallet. The Wallet Standard backend now routes Backpack through sign-then-RPC-send while keeping native sign-and-send available for wallets that handle it correctly.
- Phantom native sign-and-send receives `minContextSlot` from the latest blockhash context, matching the known mobile workaround for wallets that need the option even though it is optional in the spec.

## Follow-up

Repeat the same transaction smoke with Phantom and Solflare selected in the wallet dropdown. The Backpack path confirms discovery, connect, sign-message, sign-transaction, and sign-and-send lifecycle through a real Wallet Standard provider.
