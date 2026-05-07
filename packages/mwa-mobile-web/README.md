# @solana-agent-wallet-adapter/mwa-mobile-web

Android mobile wallet compatibility helpers for browser hosts.

This package does not sign by itself. It registers Solana Mobile's Mobile Wallet Standard implementation with the Wallet Standard event bus. After registration, `@solana-agent-wallet-adapter/wallet-standard-web` can discover the MWA wallet the same way it discovers browser extension wallets.

```ts
import { registerAgentMobileWalletAdapter } from '@solana-agent-wallet-adapter/mwa-mobile-web';

await registerAgentMobileWalletAdapter({
  appIdentity: {
    name: 'Solana Agent Wallet Adapter',
    uri: window.location.origin,
    icon: '/favicon.ico',
  },
  chains: ['solana:devnet', 'solana:mainnet'],
});
```

Platform notes:

- Android Chrome and Chrome PWAs: supported by Solana Mobile.
- iOS browsers: MWA is not supported by Solana Mobile. iOS needs a separate link-based signing transport for native wallet app approval. Wallet in-app browsers and Safari wallet extensions can still work when they inject a Wallet Standard provider.
- Desktop browsers: use normal Wallet Standard extension wallets.

Logs use deterministic `[AgentMWA] operation | key=value` lines.

See [`docs/smoke/android-mwa-web.md`](../../docs/smoke/android-mwa-web.md) for the manual mobile smoke.
