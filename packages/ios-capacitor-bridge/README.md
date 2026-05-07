# @solana-agent-wallet-adapter/ios-capacitor-bridge

Native Capacitor iOS plugin surface for Agentic.

Implemented now:

- `AgenticSecureState.get/set/remove/clearNamespace` backed by iOS Keychain.
- Deterministic redacted `[AgentIOSApp]` logs for native calls.
- `AgenticWalletConnect` method names for Jupiter parity, with deterministic clear/disconnect/session checks and explicit `WC_REOWN_NOT_CONFIGURED` failures for Reown-backed methods until the Reown Swift SDK is added to the generated Xcode project.

The deeplink wallets do not require a custom native plugin: Phantom, Solflare, and Backpack use the browser-demo encrypted deeplink runtime and the Capacitor App URL-open listener.
