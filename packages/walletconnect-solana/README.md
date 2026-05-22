# @solana-agent-wallet-adapter/walletconnect-solana

A WalletConnect v2 → Solana Wallet Standard adapter. Use this in a Tauri
desktop app to let users pair Phantom / Solflare / Backpack / Jupiter /
Magic Eden mobile via QR code without opening the OS browser.

## Features

| Wallet Standard feature        | Status |
|--------------------------------|--------|
| `standard:connect`             | ✅     |
| `standard:disconnect`          | ✅     |
| `standard:events`              | ✅     |
| `solana:signMessage`           | ✅     |
| `solana:signTransaction`       | ✅     |
| `solana:signAndSendTransaction`| ⛔ (delegated to RPC by the dApp side) |

## Usage

```ts
import SignClient from '@walletconnect/sign-client';
import {
  createWalletConnectSolanaClient,
  registerWalletConnectSolanaWallet,
  solanaWalletConnectChainId,
} from '@solana-agent-wallet-adapter/walletconnect-solana';

const signClient = await SignClient.init({
  projectId: import.meta.env.VITE_AGENTIC_WC_PROJECT_ID!,
  metadata: { name: 'Agentic', description: '…', url: 'https://agentic.example', icons: [] },
});

const client = createWalletConnectSolanaClient({
  projectId: import.meta.env.VITE_AGENTIC_WC_PROJECT_ID!,
  metadata: { name: 'Agentic', description: '…', url: 'https://agentic.example', icons: [] },
  signClient,
});

const { uri, approval } = await client.connect({
  chains: [solanaWalletConnectChainId('mainnet-beta')],
});
// Render `uri` as a QR code; show a brand deep-link button that opens
// `phantom://wc?uri=<encoded>` (or solflare://, backpack://, etc.)

const session = await approval();
const { wallet } = registerWalletConnectSolanaWallet({
  brand: { id: 'phantom', name: 'Phantom (mobile)' },
  session,
  client,
  icon: 'data:image/svg+xml;base64,…',
});

// Wallet Standard discovery now surfaces this wallet; the picker can connect.
```

## Brand-agnostic by design

The package doesn't bake brand metadata in. Callers pass their own brand
descriptor (id + display name + icon URI). Slice F.1 in the parent project
configures Phantom / Solflare / Backpack / Jupiter / Magic Eden in
`WALLET_CONNECT_BRANDS` at the call site — see
`apps/browser-demo/src/walletConnectQrOverlay.ts`.

## Idempotent registration

`registerWalletConnectSolanaWallet` is keyed by `${brand.id}|${address}`,
not by WC topic. A re-pair on a new topic but the same address replaces the
prior entry — no phantom duplicates in the picker.

## Session restore

```ts
for (const session of client.listSessions()) {
  registerWalletConnectSolanaWallet({ brand, session, client, icon });
}
```

WalletConnect's `SignClient` persists pairings via its own storage
(localStorage in browser, file system in Node). Iterate `listSessions()`
on boot and re-register so the picker shows previously-paired wallets.

## Test transport

`createWalletConnectSolanaClient` takes an injectable `signClient` matching
the `SignClientLike` interface. Tests pass a fake; production wires the
real `@walletconnect/sign-client` instance.
