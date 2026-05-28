# @solana-agent-wallet-adapter/ios-capacitor-bridge

Native Capacitor iOS plugin surface for Agentic.

Implemented now:

- `AgenticSecureState.get/set/remove/clearNamespace` backed by iOS Keychain.
- Deterministic redacted `[AgentIOSApp]` logs for native calls.
- `AgenticWalletConnect` Jupiter WalletConnect v2 bridge backed by Reown Swift when the SDK resolves in SwiftPM.
- `AgenticDeviceAgent` native Swift runtime for Anthropic, OpenAI-compatible, and Gemini providers.
- `AgenticStreamingSession` Keychain-backed native streaming session signer.

The deeplink wallets do not require a custom native plugin: Phantom, Solflare, and Backpack use the browser-demo encrypted deeplink runtime and the Capacitor App URL-open listener.
