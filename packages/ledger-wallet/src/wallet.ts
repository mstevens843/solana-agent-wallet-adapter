// Wallet Standard adapter backed by a connected Ledger hardware wallet.
//
// Mirrors `packages/embedded-wallet/src/wallet.ts` and
// `packages/walletconnect-solana/src/wallet.ts` — same `Wallet` shape, same
// feature names — but routes signing through `LedgerIpc` (which Tauri-side
// resolves to `hidapi → Ledger HID framing → Solana APDU`).
//
// Exposes `standard:connect`/`disconnect`/`events`, `solana:signTransaction`,
// and `solana:signMessage`. The off-chain message signing path uses
// INS=0x07 SIGN_OFFCHAIN_MESSAGE with the SIMD-32 envelope (the Rust
// `wrap_offchain_message` helper builds the magic-prefixed payload).

import type {
  IdentifierArray,
  Wallet,
  WalletAccount,
  WalletIcon,
} from '@wallet-standard/base';
import type {
  SolanaSignMessageFeature,
  SolanaSignMessageOutput,
  SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features';
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
  StandardEventsListeners,
} from '@wallet-standard/features';
import bs58 from 'bs58';

import { LEDGER_WALLET_ICON } from './icon.js';
import type { LedgerIpc } from './ipc.js';

export const LEDGER_WALLET_NAME = 'Ledger';
const SOLANA_CHAINS = ['solana:mainnet', 'solana:devnet', 'solana:testnet'] as const;
const SUPPORTED_TX_VERSIONS = ['legacy', 0] as const;
const ACCOUNT_FEATURES: IdentifierArray = [
  'solana:signMessage',
  'solana:signTransaction',
];

export interface CreateLedgerWalletOptions {
  ipc: LedgerIpc;
  address: string;
  /** Decoded 32-byte ed25519 public key bytes (we trust the caller to align with `address`). */
  publicKey: Uint8Array;
  /** BIP-32 derivation path used for this account, e.g. `m/44'/501'/0'/0'`. */
  derivationPath: string;
  /** Optional override; defaults to the embedded SVG icon. */
  icon?: WalletIcon;
}

export function createLedgerWallet(options: CreateLedgerWalletOptions): Wallet {
  const { ipc, address, publicKey, derivationPath } = options;
  const icon = options.icon ?? LEDGER_WALLET_ICON;

  const account: WalletAccount = {
    address,
    publicKey,
    chains: SOLANA_CHAINS,
    features: ACCOUNT_FEATURES,
  };

  let accounts: readonly WalletAccount[] = [];
  const listeners = new Set<StandardEventsListeners['change']>();

  function emitChange(): void {
    const props = { accounts };
    for (const listener of listeners) {
      try {
        listener(props);
      } catch {
        // listener errors are not our concern
      }
    }
  }

  function ensureAccount(addr: string): WalletAccount {
    if (addr !== account.address) {
      throw new Error(`Address ${addr} is not authorized on this Ledger wallet.`);
    }
    return account;
  }

  const connectFeature: StandardConnectFeature['standard:connect'] = {
    version: '1.0.0',
    connect: async () => {
      if (accounts.length === 0) {
        accounts = [account];
        emitChange();
      }
      return { accounts };
    },
  };

  const disconnectFeature: StandardDisconnectFeature['standard:disconnect'] = {
    version: '1.0.0',
    disconnect: async () => {
      const had = accounts.length > 0;
      accounts = [];
      try {
        await ipc.disconnect();
      } catch {
        // ledger transport is single-use per command today; nothing to release.
      }
      if (had) emitChange();
    },
  };

  const eventsFeature: StandardEventsFeature['standard:events'] = {
    version: '1.0.0',
    on: (event, listener) => {
      if (event !== 'change') return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const signMessageFeature: SolanaSignMessageFeature['solana:signMessage'] = {
    version: '1.1.0',
    signMessage: async (...inputs) => {
      const outputs: SolanaSignMessageOutput[] = [];
      for (const input of inputs) {
        ensureAccount(input.account.address);
        const messageB64 = bytesToBase64(input.message);
        const signatureB64 = await ipc.signMessage(derivationPath, messageB64);
        const signature = base64ToBytes(signatureB64);
        if (signature.length !== 64) {
          throw new Error(
            `Ledger signature length unexpected: ${signature.length}`,
          );
        }
        outputs.push({
          signedMessage: input.message,
          signature,
          signatureType: 'ed25519',
        });
      }
      return outputs;
    },
  };

  const signTransactionFeature: SolanaSignTransactionFeature['solana:signTransaction'] = {
    version: '1.0.0',
    supportedTransactionVersions: SUPPORTED_TX_VERSIONS,
    signTransaction: async (...inputs) => {
      const outputs: { signedTransaction: Uint8Array }[] = [];
      for (const input of inputs) {
        ensureAccount(input.account.address);
        const base64Tx = bytesToBase64(input.transaction);
        const signedBase64 = await ipc.signTransaction(derivationPath, base64Tx);
        outputs.push({ signedTransaction: base64ToBytes(signedBase64) });
      }
      return outputs;
    },
  };

  return {
    get version() {
      return '1.0.0' as const;
    },
    get name() {
      return LEDGER_WALLET_NAME;
    },
    get icon(): WalletIcon {
      return icon;
    },
    get chains() {
      return SOLANA_CHAINS;
    },
    get features() {
      return {
        'standard:connect': connectFeature,
        'standard:disconnect': disconnectFeature,
        'standard:events': eventsFeature,
        'solana:signMessage': signMessageFeature,
        'solana:signTransaction': signTransactionFeature,
      };
    },
    get accounts() {
      return accounts;
    },
  };
}

/**
 * Decode the base64 public key returned by `ledger_get_address` and confirm
 * it matches the supplied base58 address. Throws on mismatch — protects
 * against accidental swapping of address/publicKey at the call site.
 */
export function decodeLedgerPublicKey(address: string, publicKeyB64: string): Uint8Array {
  const bytes = base64ToBytes(publicKeyB64);
  if (bytes.length !== 32) {
    throw new Error(`Ledger public key length ${bytes.length} != 32`);
  }
  const fromAddress = bs58.decode(address);
  if (fromAddress.length !== 32) {
    throw new Error(`Ledger address decode length ${fromAddress.length} != 32`);
  }
  for (let i = 0; i < 32; i += 1) {
    if (bytes[i] !== fromAddress[i]) {
      throw new Error('Ledger public key bytes do not match the address');
    }
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  if (typeof btoa !== 'undefined') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob !== 'undefined') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
