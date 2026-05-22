# @solana-agent-wallet-adapter/ledger-wallet

A Ledger USB-HID → Solana Wallet Standard adapter for the Agentic Tauri
desktop app. The package wires the Wallet Standard interface to Tauri IPC
commands that the Rust shell implements via the `hidapi` crate + Ledger's
HID packet-framing protocol + Solana app APDU.

## Features

| Wallet Standard feature        | Status |
|--------------------------------|--------|
| `standard:connect`             | ✅     |
| `standard:disconnect`          | ✅     |
| `standard:events`              | ✅     |
| `solana:signMessage`           | ✅ via SIGN_OFFCHAIN_MESSAGE (SIMD-32 envelope) |
| `solana:signTransaction`       | ✅     |
| `solana:signAndSendTransaction`| ⛔ (delegated to RPC by the dApp side) |

## Usage

```ts
import {
  createTauriLedgerIpc,
  decodeLedgerPublicKey,
  detectLedgerTauriInvoke,
  registerLedgerWallet,
} from '@solana-agent-wallet-adapter/ledger-wallet';

const invoke = detectLedgerTauriInvoke();
if (!invoke) throw new Error('Ledger pairing requires the Tauri desktop app');
const ipc = createTauriLedgerIpc(invoke);

await ipc.connect(); // verifies the Solana app is open
const result = await ipc.getAddress("m/44'/501'/0'/0'");

const publicKey = decodeLedgerPublicKey(result.address, result.publicKeyB64);
registerLedgerWallet({
  ipc,
  address: result.address,
  publicKey,
  derivationPath: "m/44'/501'/0'/0'",
});
// Wallet Standard discovery now surfaces a "Ledger" entry; the picker can connect.
```

## Constraints

- **Single-APDU sign cap (~232 bytes of transaction).** Larger transactions
  (multi-instruction CPI bundles, or many address-lookup-table references)
  exceed the 255-byte Lc limit and currently fail with a clear error.
  Multi-chunk SIGN ships in a follow-up slice.
- **Default derivation path `m/44'/501'/0'/0'`** matches
  Phantom / Solflare / Backpack defaults. Pass a different path via
  `derivationPath` if needed; the IPC accepts any BIP-32 hardened path.
- **Linux**: `hidapi` needs udev permissions to read the Ledger HID
  interface without sudo. The standard
  [LedgerHQ udev rules](https://github.com/LedgerHQ/udev-rules) install
  works.
- **No persistent pairing** — Ledger sessions are per-launch. The user
  re-plugs (or just keeps the device plugged in) at each app start.

## Off-chain messages

`solana:signMessage` routes through Ledger's INS=0x07 SIGN_OFFCHAIN_MESSAGE
opcode. The Rust side wraps the user's bytes in the SIMD-32 envelope
(magic `\xffsolana offchain` + version + format + length prefix). The
device displays the message inline when it's printable ASCII; otherwise it
displays a hash and asks the user to confirm.

## Test transport

`LedgerIpc` is an interface; tests pass a fake implementation, production
uses `createTauriLedgerIpc(invoke)`. All path/byte translation happens at
the TS layer; the Rust side never sees user-typed strings.
