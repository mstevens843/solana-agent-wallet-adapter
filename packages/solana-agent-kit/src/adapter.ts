import bs58 from 'bs58';

import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type SendOptions,
  type TransactionSignature,
} from '@solana/web3.js';

import {
  ProtocolError,
  SolanaSigningClient,
  type Cluster,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';

/**
 * Minimal subset of `BaseWallet` from `solana-agent-kit` v2.
 *
 * Reproduced here so this package works without forcing consumers to install
 * a specific solana-agent-kit version at type-check time. The peer dep range
 * in package.json governs runtime compatibility.
 */
export interface BaseWallet {
  readonly publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
  sendTransaction?: <T extends Transaction | VersionedTransaction>(
    transaction: T,
  ) => Promise<TransactionSignature>;
  signAndSendTransaction?: <T extends Transaction | VersionedTransaction>(
    transaction: T,
    options?: SendOptions,
  ) => Promise<{ signature: TransactionSignature }>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export interface AgentWalletAdapterBackendOptions {
  /** Underlying wallet backend (web Wallet Standard, Android MWA, planned iOS link transport, mock). */
  backend: WalletBackend;
  /** Solana cluster every signing request will target. */
  cluster: Cluster;
  /** Optional polling interval forwarded to SolanaSigningClient. */
  pollIntervalMs?: number;
  /** Optional per-request timeout forwarded to SolanaSigningClient. */
  timeoutMs?: number;
  /** Optional override for the connected address (skips lazy lookup on construction). */
  address?: string;
}

/**
 * `BaseWallet` implementation that routes every Solana Agent Kit signing call
 * through a `WalletBackend` from `@solana-agent-wallet-adapter/core`.
 *
 * The agent never sees the user's private key. Each `signTransaction`,
 * `signMessage`, and `signAndSendTransaction` call submits a request to the
 * configured wallet backend (browser Wallet Standard, Android MWA, planned iOS
 * link transport, or mock) and resolves only when the user has approved or
 * rejected the request in their wallet.
 *
 * Plug into `SolanaAgentKit`:
 *
 * ```ts
 * import { SolanaAgentKit } from 'solana-agent-kit';
 * import { WalletStandardWebBackend, requireWallet } from '@solana-agent-wallet-adapter/wallet-standard-web';
 * import { AgentWalletAdapterBackend } from '@solana-agent-wallet-adapter/solana-agent-kit';
 *
 * const backend = new WalletStandardWebBackend({ wallet: requireWallet('Phantom'), cluster: 'devnet' });
 * const wallet  = await AgentWalletAdapterBackend.create({ backend, cluster: 'devnet' });
 * const agent   = new SolanaAgentKit(wallet, 'https://api.devnet.solana.com', {});
 * ```
 */
export class AgentWalletAdapterBackend implements BaseWallet {
  readonly publicKey: PublicKey;

  private readonly backend: WalletBackend;
  private readonly cluster: Cluster;
  private readonly client: SolanaSigningClient;

  private constructor(options: AgentWalletAdapterBackendOptions, address: string) {
    this.backend = options.backend;
    this.cluster = options.cluster;
    this.publicKey = new PublicKey(address);
    this.client = new SolanaSigningClient({
      backend: options.backend,
      ...(options.pollIntervalMs !== undefined && { pollIntervalMs: options.pollIntervalMs }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    });
  }

  /**
   * Construct an adapter, lazily fetching the wallet's address from the backend
   * if one wasn't passed in `options`. Triggers a wallet connect prompt if the
   * underlying backend hasn't been authorized yet.
   */
  static async create(options: AgentWalletAdapterBackendOptions): Promise<AgentWalletAdapterBackend> {
    const address = options.address ?? (await options.backend.getAddress());
    return new AgentWalletAdapterBackend(options, address);
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    const result = await this.client.signTransaction(serializeTx(transaction), {
      cluster: this.cluster,
      summary: summarizeTransaction(transaction),
    });
    return deserializeTx<T>(result.signature, transaction);
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[],
  ): Promise<T[]> {
    const signed: T[] = [];
    for (const tx of transactions) {
      signed.push(await this.signTransaction(tx));
    }
    return signed;
  }

  async signAndSendTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
    _options?: SendOptions,
  ): Promise<{ signature: TransactionSignature }> {
    const caps = await this.backend.capabilities();
    if (!caps.supports.signAndSendTransaction) {
      throw new ProtocolError(
        'invalid_request',
        `Wallet backend ${caps.backend} does not support sign_and_send_transaction; sign and broadcast separately instead.`,
      );
    }
    const result = await this.client.signAndSendTransaction(serializeTx(transaction), {
      cluster: this.cluster,
      summary: summarizeTransaction(transaction),
    });
    return { signature: (result.txid ?? result.signature) as TransactionSignature };
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const text = decodeUtf8(message);
    // decodeUtf8 is lossy for non-UTF-8 input. Signing the lossy string would
    // return a signature over corrupted bytes that does not verify against the
    // original `message` — fail loudly instead of silently corrupting.
    if (!utf8RoundTrips(message, text)) {
      throw new ProtocolError(
        'invalid_request',
        'signMessage requires a UTF-8 message on this backend; binary (non-UTF-8) messages are not supported.',
      );
    }
    const result = await this.client.signMessage(text, {
      cluster: this.cluster,
      summary: 'Sign message',
    });
    return bs58.decode(result.signature);
  }
}

function serializeTx(tx: Transaction | VersionedTransaction): string {
  if (tx instanceof VersionedTransaction) {
    return Buffer.from(tx.serialize()).toString('base64');
  }
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function deserializeTx<T extends Transaction | VersionedTransaction>(
  signedBase64: string,
  source: T,
): T {
  const bytes = Buffer.from(signedBase64, 'base64');
  if (source instanceof VersionedTransaction) {
    return VersionedTransaction.deserialize(new Uint8Array(bytes)) as T;
  }
  return Transaction.from(bytes) as T;
}

function summarizeTransaction(tx: Transaction | VersionedTransaction): string {
  const ixCount =
    tx instanceof VersionedTransaction ? tx.message.compiledInstructions.length : tx.instructions.length;
  return `Sign Solana transaction (${ixCount} instruction${ixCount === 1 ? '' : 's'})`;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** True if encoding `text` back to UTF-8 bytes reproduces `original` exactly. */
function utf8RoundTrips(original: Uint8Array, text: string): boolean {
  const reencoded = new TextEncoder().encode(text);
  if (reencoded.length !== original.length) return false;
  for (let i = 0; i < reencoded.length; i += 1) {
    if (reencoded[i] !== original[i]) return false;
  }
  return true;
}
