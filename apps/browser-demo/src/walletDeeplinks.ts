// Pure helpers that build wallet-specific universal-link URLs for legacy
// mobile deeplink flows.
//
// Why per-wallet helpers when WalletConnect already does this?
//
// - **Phantom mobile does not implement WalletConnect v2 for Solana.** It
//   uses its own encrypted-deeplink protocol ("Phantom Connect"); a generic
//   `wc:topic@2?…` URI surfaces "This QR code is not valid" in Phantom.
//   See https://phantom.com/learn/blog/the-complete-guide-to-phantom-deeplinks
// - **Solflare encrypted connect links** now mirror Phantom for desktop QR
//   pairing. Browse links are retained only for callers that explicitly want
//   to open a dApp inside Solflare's in-app browser.
//
// These helpers are DOM-free and have no side effects. Tests exercise the
// URL shapes directly.

import type { SolanaClusterId } from '@solana-agent-wallet-adapter/walletconnect-solana';
import { generateEncryptedDeeplinkKeypair } from './encryptedDeeplink.js';

export interface PhantomConnectKeypair {
  /** Base58 of the dApp's ephemeral X25519 public key, passed to Phantom as
   *  `dapp_encryption_public_key`. Phantom encrypts the session payload to
   *  this key on approve. */
  publicKey: string;
  /** Base58 of the matching secret key. The desktop stores this on the
   *  pairing relay so `/qr-connect` can decrypt the wallet redirect. */
  secretKey: string;
}

/** Generate a fresh X25519 keypair encoded as base58 for use with Phantom's
 *  `dapp_encryption_public_key` parameter. Phantom Connect requires a NaCl
 *  box keypair (32-byte public + 32-byte secret) — `tweetnacl`'s `box.keyPair`
 *  returns exactly that. */
export function generatePhantomConnectKeypair(): PhantomConnectKeypair {
  return generateEncryptedDeeplinkKeypair();
}

/** Appends a `pairing=<uuid>` query parameter to an absolute URL. Preserves
 *  any existing query params. Used by both wallet builders so the redirect
 *  destination carries the pairing id through to the wallet-host page. */
function appendPairingParam(rawUrl: string, pairing: string): string {
  const u = new URL(rawUrl);
  u.searchParams.set('pairing', pairing);
  return u.toString();
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
  /** Optional pairing UUID — when set, gets appended to `redirectLink` so
   *  the wallet-host page that loads in Phantom's in-app browser knows
   *  which cloud-relay pairing record to POST its connected address to. */
  pairing?: string;
}

/** Build the `https://phantom.app/ul/v1/connect` universal-link URL for the
 *  Phantom Connect protocol. iOS / Android route this URL to Phantom mobile
 *  when scanned with the system camera. */
export function buildPhantomConnectUrl(options: BuildPhantomConnectUrlOptions): string {
  const redirectLink = options.pairing
    ? appendPairingParam(options.redirectLink, options.pairing)
    : options.redirectLink;
  const url = new URL('https://phantom.app/ul/v1/connect');
  url.searchParams.set('app_url', options.appUrl);
  url.searchParams.set('dapp_encryption_public_key', options.dappPublicKey);
  url.searchParams.set('cluster', phantomClusterParam(options.cluster));
  url.searchParams.set('redirect_link', redirectLink);
  return url.toString();
}

export interface BuildSolflareConnectUrlOptions {
  /** Base58 of the dApp's ephemeral encryption public key. */
  dappPublicKey: string;
  /** Absolute URL Solflare redirects back to after approval. */
  redirectLink: string;
  /** Solana cluster the dApp wants the wallet to authorize. */
  cluster: SolanaClusterId;
  /** Absolute URL Solflare uses to retrieve app metadata during approval. */
  appUrl: string;
  /** Optional pairing UUID appended to `redirectLink`. */
  pairing?: string;
}

/** Build the `https://solflare.com/ul/v1/connect` universal-link URL for
 *  Solflare's encrypted deeplink protocol. */
export function buildSolflareConnectUrl(options: BuildSolflareConnectUrlOptions): string {
  const redirectLink = options.pairing
    ? appendPairingParam(options.redirectLink, options.pairing)
    : options.redirectLink;
  const url = new URL('https://solflare.com/ul/v1/connect');
  url.searchParams.set('app_url', options.appUrl);
  url.searchParams.set('dapp_encryption_public_key', options.dappPublicKey);
  url.searchParams.set('cluster', phantomClusterParam(options.cluster));
  url.searchParams.set('redirect_link', redirectLink);
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
  /** Optional pairing UUID — appended to `dappUrl` before encoding so the
   *  wallet-host page that loads in Solflare's in-app browser knows which
   *  cloud-relay pairing record to register its address with. */
  pairing?: string;
}

/** Build the Solflare browse universal link. Solflare's universal-link
 *  handler registers `https://solflare.com/ul/v1/browse/<encoded-url>?ref=…`
 *  (per their `deep-link-sample-app`) — destination URL is a **path segment**,
 *  not a query param, and the `v1` version is mandatory. The earlier
 *  `https://solflare.com/ul/browse/?url=…` shape we used did not match the
 *  registered universal-link pattern, so iOS/Android opened it as a plain
 *  HTTPS URL instead of routing to Solflare.
 *  See https://docs.solflare.com/solflare/technical/deeplinks/other-methods/browse */
export function buildSolflareBrowseUrl(options: BuildSolflareBrowseUrlOptions): string {
  const dappUrl = options.pairing
    ? appendPairingParam(options.dappUrl, options.pairing)
    : options.dappUrl;
  const url = new URL(`https://solflare.com/ul/v1/browse/${encodeURIComponent(dappUrl)}`);
  url.searchParams.set('ref', options.ref);
  return url.toString();
}
