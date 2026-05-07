# Android Native MWA Smoke

This smoke verifies the Android app as a native Mobile Wallet Adapter approval host. The raw MWA harness is an opt-in
example mode; normal Android builds launch the native Agentic app.

## Start

```sh
pnpm dev:mobile
AGENTIC_ANDROID_SHOW_EXAMPLE_APP=true pnpm android:install
```

Install Phantom, Solflare, Backpack, Jupiter, or Seed Vault Wallet on the Android device.

## Flow

1. Launch Agentic.
2. Select `devnet`, tap `Connect wallet`, and approve in the wallet.
3. Relaunch Agentic. Cached authorization should restore automatically.
4. Tap `Disconnect`, then `Reconnect cached`. The app restores the auth token and cached wallet URI so the intended
   wallet can be reused without a generic picker when the wallet supports endpoint-specific MWA links.
5. Tap `Get capabilities`.
6. Test `Connect + SIWS` with the default domain/statement if the selected wallet supports Sign In With Solana.
7. Paste a base64 devnet transaction and test `Sign transaction`.
8. Test `Sign and send`.
9. Enter the LAN bridge URL and token from `pnpm dev:mobile`, then tap `Connect bridge`.
10. From an MCP/agent client, request `solana_sign_transaction` or `solana_sign_and_send_transaction`; Android should claim, open wallet approval, and resolve the bridge request.
11. Verify `Clear transient` stops transient bridge polling but retains the wallet cache.
12. Verify `Full reset` attempts MWA remote deauthorize, then clears the active local authorization and session blacklist.
13. Verify `Clear all accounts` wipes every cached record.

## Expected Wallet Routing

- Backpack: sign-and-send routes through sign-then-RPC.
- Phantom: native sign-and-send uses an auto-fetched `minContextSlot`.
- Phantom and Solflare: MWA message signing may return a typed unsupported error.
- Jupiter: standalone transaction signing returns a typed unsupported error; use sign-and-send.
- Solflare: SIWS may return a typed unsupported error.
- Android native MWA supports mainnet-beta, devnet, and testnet. A localnet bridge config is rejected as a cluster mismatch.

## Logs

```sh
adb logcat | grep -i "AgentAndroidMWA"
```

Every user action and bridge approval should emit deterministic redacted lines:

```text
[AgentAndroidMWA] [Component] method | START/STEP/SUCCESS/FAIL key=value
```
