# Agentic Native Swift iOS App

This is the future non-Capacitor iOS path. Root scripts route here when:

```sh
CAPACITOR_IOS_APP=false pnpm ios:build
```

The default remains the Capacitor app (`CAPACITOR_IOS_APP=true`) so the current shipped iOS build keeps the same web UI and wallet runtime.

Native Swift parity included here:

- Wallet list for Phantom, Solflare, Backpack, Jupiter.
- Encrypted deeplink connect and sign URL construction for Phantom/Solflare/Backpack.
- Callback parsing, encrypted payload decrypt, extended auth cache, reconnect from cache, disconnect with cache retained, transient clear, full reset, and clear-all.
- Deterministic redacted `[AgentIOSNative]` logging.
- Jupiter method surface is modeled separately because it needs Reown WalletConnect SDK wiring in an iOS app target.

SwiftPM can build the package directly; Xcode can open the package for iterative native UI work.
