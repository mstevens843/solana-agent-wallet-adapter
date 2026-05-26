// Pure helpers that build the wallet-specific universal-link URLs we encode
// into QR codes for the desktop Discover → "Scan QR with phone" flow.
//
// Why per-wallet helpers when WalletConnect already does this?
//
// - **Phantom mobile does not implement WalletConnect v2 for Solana.** It
//   uses its own encrypted-deeplink protocol ("Phantom Connect"); a generic
//   `wc:topic@2?…` URI surfaces "This QR code is not valid" in Phantom.
//   See https://phantom.com/learn/blog/the-complete-guide-to-phantom-deeplinks
// - **Solflare's primary scanner is hardcoded for Solana Pay** (`solana:`
//   scheme) and rejects WC URIs as "not a valid Solana Pay QR code." Solflare
//   does support WalletConnect, but only via separate entry points; the
//   simplest cross-device path is its `browse` deeplink, which opens dApps
//   inside Solflare's in-app browser where the wallet-standard wallet is
//   pre-injected. See https://docs.solflare.com/solflare/technical/deeplinks
//
// These helpers are DOM-free and have no side effects — `main.ts` renders
// the QR from the returned URL. Tests exercise the URL shapes directly.

import bs58 from 'bs58';
import nacl from 'tweetnacl';

import type { SolanaClusterId } from '@solana-agent-wallet-adapter/walletconnect-solana';

export interface PhantomConnectKeypair {
  /** Base58 of the dApp's ephemeral X25519 public key, passed to Phantom as
   *  `dapp_encryption_public_key`. Phantom encrypts the session payload to
   *  this key on approve. */
  publicKey: string;
  /** Base58 of the matching secret key. Phase 1 discards this (the desktop
   *  doesn't decrypt the response yet); Phase 2 stores it to decrypt the
   *  redirect payload returned through the pairing relay. */
  secretKey: string;
}

/** Generate a fresh X25519 keypair encoded as base58 for use with Phantom's
 *  `dapp_encryption_public_key` parameter. Phantom Connect requires a NaCl
 *  box keypair (32-byte public + 32-byte secret) — `tweetnacl`'s `box.keyPair`
 *  returns exactly that. */
export function generatePhantomConnectKeypair(): PhantomConnectKeypair {
  const kp = nacl.box.keyPair();
  return {
    publicKey: bs58.encode(kp.publicKey),
    secretKey: bs58.encode(kp.secretKey),
  };
}

export interface BuildPhantomConnectUrlOptions {
  /** Base58 of the dApp's ephemeral encryption public key. Get from
   *  `generatePhantomConnectKeypair()`. */
  dappPublicKey: string;
  /** Absolute URL Phantom redirects back to after approval. The wallet's
   *  public key + encrypted session payload are appended as query params. */
  redirectLink: string;
  /** Solana cluster the dApp wants the wallet to authorize. Phantom maps
   *  internally to the underlying RPC. */
  cluster: SolanaClusterId;
  /** Absolute URL Phantom shows as the dApp identity during approval. */
  appUrl: string;
}

/** Build the `https://phantom.app/ul/v1/connect` universal-link URL for the
 *  Phantom Connect protocol. iOS / Android route this URL to Phantom mobile
 *  when scanned with the system camera. */
export function buildPhantomConnectUrl(options: BuildPhantomConnectUrlOptions): string {
  const url = new URL('https://phantom.app/ul/v1/connect');
  url.searchParams.set('app_url', options.appUrl);
  url.searchParams.set('dapp_encryption_public_key', options.dappPublicKey);
  url.searchParams.set('cluster', phantomClusterParam(options.cluster));
  url.searchParams.set('redirect_link', options.redirectLink);
  return url.toString();
}

function phantomClusterParam(cluster: SolanaClusterId): string {
  // Phantom's deeplink protocol accepts "mainnet-beta", "devnet", "testnet".
  // localnet collapses to devnet (same genesis hash on the WC side).
  return cluster === 'localnet' ? 'devnet' : cluster;
}

export interface BuildSolflareBrowseUrlOptions {
  /** Absolute URL of the dApp page Solflare should open inside its in-app
   *  browser. Typically the deployed wallet-host at
   *  `https://agentic-signer.com/app?wallet=solflare`. */
  dappUrl: string;
  /** Absolute referer URL of the dApp identity, surfaced to the user. */
  ref: string;
}

/** Build the `https://solflare.com/ul/browse/?ref=…&url=…` universal link.
 *  iOS / Android route this to Solflare mobile, which opens `url` inside
 *  Solflare's in-app browser with the wallet-standard provider injected. */
export function buildSolflareBrowseUrl(options: BuildSolflareBrowseUrlOptions): string {
  const url = new URL('https://solflare.com/ul/browse/');
  url.searchParams.set('ref', options.ref);
  url.searchParams.set('url', options.dappUrl);
  return url.toString();
}
