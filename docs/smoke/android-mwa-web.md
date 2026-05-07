# Android MWA Mobile Web Smoke

This smoke verifies the additive Android Mobile Wallet Adapter path. Desktop
browser-wallet flow should keep working through `WalletStandardWebBackend`.

## What This Uses

- `@solana-agent-wallet-adapter/mwa-mobile-web` registers Solana Mobile's
  Mobile Wallet Standard implementation.
- `@solana-agent-wallet-adapter/wallet-standard-web` still performs signing.
- The local bridge stays the same MCP bridge, but runs on LAN for phone access.

## Start LAN Dev

```sh
pnpm dev:mobile
```

The script prints a URL like:

```text
http://<laptop-ip>:5174/?bridgeUrl=http://<laptop-ip>:8787&token=local-agent-wallet
```

Open that URL in Android Chrome or install it as a Chrome PWA. MWA mobile web
does not work in iOS browsers, Firefox, Opera, or Brave.

For iOS, this same browser demo can still work when a wallet injects a Wallet
Standard provider, such as inside a wallet app's in-app browser or through an
iOS Safari wallet extension. That is not MWA. A separate iOS link-based signing
transport is the native wallet app approval path for supported providers.

## Expected Flow

1. Open the LAN URL on Android Chrome.
2. Tap `Discover wallets`.
3. Confirm the Android MWA panel says registration succeeded.
4. Select the Mobile Wallet Adapter wallet option.
5. Connect, approve in the installed Android wallet.
6. Connect bridge.
7. Use the Approval Inbox or Wallet Flow tab to request a signature.

## Known Wallet Notes

- Backpack-class native `sign_and_send_transactions` crashes were seen in the
  Cocos and Unreal MWA projects. The browser demo forces MWA wallets through
  sign-then-RPC-send.
- Phantom/Solflare Android message-signing behavior varies by wallet version.
  Transaction signing is the more reliable smoke.
- Wrong-wallet selection after cached auth can surface as an authorization
  mismatch. Disconnect and reconnect with the intended wallet.

## Logs

Browser console:

```text
[AgentMWA] register | ...
```

Bridge trace:

```sh
pnpm dev:trace
```

Android device logs can still be useful for wallet-side failures:

```sh
adb logcat | grep -iE "(MobileWallet|MWA|solana|phantom|solflare|backpack)"
```
