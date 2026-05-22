# @solana-agent-wallet-adapter/embedded-wallet

A built-in software wallet for the Agentic Tauri desktop app. The package
exposes a Solana Wallet Standard adapter that signs through Tauri IPC; all
key material lives behind the Rust process (BIP-39 mnemonic → SLIP-0010
ed25519 → Argon2id-AES-GCM encrypted file with OS-keychain wrap). The
browser side never holds a private key.

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
import { registerAgenticWallet } from '@solana-agent-wallet-adapter/embedded-wallet';

// Once, on Tauri boot. No-op outside Tauri.
const unregister = registerAgenticWallet();
```

Once registered, the embedded wallet appears in any Wallet Standard picker
(`getWallets()`) as **"Agentic Wallet"**. Connect / sign flows then route
through the existing `WalletStandardWebBackend` adapter — call sites that
already work with Phantom et al. need no changes.

## Test transport

```ts
import { createAgenticWallet, type WalletIpc } from '@solana-agent-wallet-adapter/embedded-wallet';

const fakeIpc: WalletIpc = { /* … */ };
const wallet = createAgenticWallet(fakeIpc);
```

The injectable `WalletIpc` lets unit tests drive the adapter without Tauri.

## Constraints

- Desktop-only (Tauri). On web, `registerAgenticWallet()` returns a no-op
  unregister callback.
- The mnemonic is shown to the user **once**, at creation. The package
  re-derives the seed every unlock from the encrypted mnemonic; passwords
  cannot be recovered.
- Auto-locks after a configurable idle timeout (default 5 minutes); the
  Tauri side has both a lazy auto-lock check on every command and a
  background watcher thread that locks even when the UI stops polling.
