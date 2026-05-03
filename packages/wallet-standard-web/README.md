# @solana-agent-wallet-adapter/wallet-standard-web

Browser `WalletBackend` implementation for the Solana Agent Wallet Adapter, built on the [Wallet Standard](https://github.com/wallet-standard/wallet-standard). Routes signing through any installed Solana browser wallet (Phantom, Solflare, Backpack, Glow) without holding the user's keys.

```ts
import { listAvailableWallets, WalletStandardWebBackend } from '@solana-agent-wallet-adapter/wallet-standard-web';
import { createServer } from '@solana-agent-wallet-adapter/mcp-server';

const wallets = listAvailableWallets();
const phantom = wallets.find((entry) => entry.name === 'Phantom');
if (!phantom) throw new Error('Phantom not installed.');

const backend = new WalletStandardWebBackend({
  wallet: phantom,
  cluster: 'devnet',
});

const server = createServer({ backend });
// then connect over your transport of choice (stdio, HTTP)
```

## How it works

- `listAvailableWallets()` enumerates browser wallets registered through the Wallet Standard `wallets` event bus and filters to those declaring `solana:*` chain support.
- `WalletStandardWebBackend` implements `WalletBackend` from `@solana-agent-wallet-adapter/core`. It uses the `StandardConnect`, `SolanaSignMessage`, `SolanaSignTransaction`, and `SolanaSignAndSendTransaction` features.
- Submitting a signing request returns a pending `ApprovalResource` immediately, then resolves it asynchronously when the wallet's popup confirmation completes. The MCP server polls or subscribes against the same backend.

## Caveats

- Browser-only. Cannot run in plain Node — needs `window` and a Wallet Standard registry. Use the mock backend (`@solana-agent-wallet-adapter/mcp-server` ships one) for CI tests.
- One backend instance per cluster; switching clusters requires a new instance.
- The wallet must already be installed and registered with `getWallets()` before the backend constructs.

## Status

Phase 1 implementation. Smoke-tested against the build pipeline; browser end-to-end smoke pending (B2d in the plan file).
