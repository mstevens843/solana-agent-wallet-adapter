# Agentic iOS Capacitor App

This is the default iOS app path while `CAPACITOR_IOS_APP=true` (or the legacy alias `CAPACITATOR_IOS_APP=true`).

The shell packages the browser demo and lets the real iOS wallet runtime use:

- Phantom, Solflare, Backpack: encrypted universal/deep links with `agenticwallet://callback/...`.
- Jupiter: WalletConnect/Reown through the native bridge surface when the native plugin is present and configured.
- Extended auth cache: secure native state via `AgenticSecureState`, with browser localStorage fallback for development.
- Clear state: transient clear, full reset, and clear-all cache methods from the Launch App iOS maintenance controls.

Useful commands:

```sh
pnpm ios:mode
pnpm ios:build
pnpm ios:sync
pnpm ios:open
```

Set `CAPACITOR_IOS_APP=false` to route the root iOS scripts to the native SwiftUI app scaffold in `apps/ios-native`.
