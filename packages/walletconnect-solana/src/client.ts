// Thin DI-friendly wrapper around `@walletconnect/sign-client` for Solana.
//
// The production path imports the real `SignClient` lazily (because its
// constructor opens a WebSocket to the WC relay and we don't want that work
// at module load time). Tests inject a `SignClientLike` fake so the package
// can be exercised end-to-end without a real WC project ID or network.
//
// Methods mirror what the Wallet Standard adapter and the browser-demo UI
// actually need:
//   - connect():      proposes a session, returns the `wc:` URI + an
//                     approval promise that settles once the user's mobile
//                     wallet approves
//   - signMessage:    routes to `solana_signMessage`
//   - signTransaction: routes to `solana_signTransaction`
//   - disconnect:     ends a topic
//   - listSessions:   enumerate currently-paired sessions (for restore on
//                     next launch)
//   - on:             session_delete / session_expire forwarder

import bs58 from 'bs58';

const SOLANA_NAMESPACE = 'solana';
const DEFAULT_METHODS = ['solana_signMessage', 'solana_signTransaction'];

export interface WalletConnectSession {
  topic: string;
  address: string;
  chainId: string;
  /** Self-reported name of the wallet that approved the session, e.g.
   *  "Phantom" or "Solflare". Populated from the raw WC session's
   *  `peer.metadata.name` when available; absent for older WC peers. */
  peerName?: string;
  /** Icon URLs the peer advertised in its metadata. The first entry is the
   *  recommended display icon. */
  peerIcons?: string[];
}

export interface WalletConnectSignTransactionResult {
  /** Base64-encoded signed transaction bytes. Optional in the WC Solana spec. */
  transaction?: string;
  /** Base58 wallet signature. Some wallets, including Backpack, return this without transaction bytes. */
  signature?: string;
}

// Narrow shape of @walletconnect/sign-client's exported SignClient that we
// actually rely on. Keeping it in a single interface lets tests stub easily.
export interface SignClientLike {
  connect(opts: {
    requiredNamespaces: Record<
      string,
      { chains: string[]; methods: string[]; events: string[] }
    >;
  }): Promise<{
    uri?: string;
    approval(): Promise<WalletConnectSessionStruct>;
  }>;
  request<T = unknown>(opts: {
    topic: string;
    chainId: string;
    request: { method: string; params: unknown };
    expiry?: number;
  }): Promise<T>;
  disconnect(opts: {
    topic: string;
    reason: { code: number; message: string };
  }): Promise<void>;
  session?: {
    getAll(filter?: Partial<WalletConnectSessionStruct>): WalletConnectSessionStruct[];
  };
  on?(
    event: 'session_delete' | 'session_expire',
    listener: (args: { topic: string }) => void,
  ): void;
  off?(
    event: 'session_delete' | 'session_expire',
    listener: (args: { topic: string }) => void,
  ): void;
}

export interface WalletConnectSessionStruct {
  topic: string;
  namespaces: Record<
    string,
    { accounts: string[]; methods?: string[]; events?: string[] }
  >;
  /** Peer metadata as advertised by the responder wallet — present on real
   *  SignClient session structs but omitted by some tests. */
  peer?: {
    metadata?: {
      name?: string;
      icons?: string[];
      url?: string;
      description?: string;
    };
  };
}

export interface WalletConnectSolanaClient {
  /** Begin a new pairing for the given chain IDs. */
  connect(opts: { chains: string[] }): Promise<{
    uri: string;
    approval(): Promise<WalletConnectSession>;
  }>;

  /**
   * Sign an arbitrary message. Phantom / Solflare expect the message as the
   * base58 encoding of the bytes; the signature comes back base58-encoded.
   */
  signMessage(opts: {
    topic: string;
    chainId: string;
    pubkey: string;
    message: Uint8Array;
  }): Promise<Uint8Array>;

  /**
   * Sign a serialized Solana transaction. The transaction is passed as
   * base64. WalletConnect Solana peers may return signed transaction bytes,
   * a raw signature, or both.
   */
  signTransaction(opts: {
    topic: string;
    chainId: string;
    transactionBase64: string;
  }): Promise<WalletConnectSignTransactionResult>;

  disconnect(topic: string): Promise<void>;

  /** Currently paired Solana sessions matching the configured chains. */
  listSessions(): WalletConnectSession[];

  /** Subscribe to peer-initiated session termination. Returns an unsubscribe. */
  on(
    event: 'session_delete' | 'session_expire',
    listener: (topic: string) => void,
  ): () => void;
}

export interface WalletConnectSolanaClientOptions {
  /** Required for real-world use; tests can pass any string. */
  projectId: string;
  /** dApp identity shown to the user during pairing. */
  metadata: {
    name: string;
    description: string;
    url: string;
    icons: string[];
  };
  /** Injected for tests; production path creates a real SignClient. */
  signClient: SignClientLike;
}

export function createWalletConnectSolanaClient(
  options: WalletConnectSolanaClientOptions,
): WalletConnectSolanaClient {
  void options.metadata; // metadata is supplied to SignClient.init() upstream; kept here for future use
  void options.projectId;
  const client = options.signClient;

  async function connect(opts: { chains: string[] }) {
    const { uri, approval } = await client.connect({
      requiredNamespaces: {
        [SOLANA_NAMESPACE]: {
          chains: opts.chains,
          methods: DEFAULT_METHODS,
          events: [],
        },
      },
    });
    if (!uri) {
      throw new Error('WalletConnect did not return a pairing URI.');
    }
    return {
      uri,
      approval: async (): Promise<WalletConnectSession> => {
        const session = await approval();
        const resolved = resolveSession(session, opts.chains);
        if (!resolved) {
          throw new Error(
            `WalletConnect peer did not authorize a Solana account on the requested chains.`,
          );
        }
        return resolved;
      },
    };
  }

  async function signMessage(opts: {
    topic: string;
    chainId: string;
    pubkey: string;
    message: Uint8Array;
  }): Promise<Uint8Array> {
    const result = await client.request<unknown>({
      topic: opts.topic,
      chainId: opts.chainId,
      request: {
        method: 'solana_signMessage',
        params: {
          pubkey: opts.pubkey,
          message: bs58.encode(opts.message),
        },
      },
    });
    const signature = extractSignature(result);
    let decoded: Uint8Array;
    try {
      decoded = bs58.decode(signature);
    } catch (err) {
      // Peer returned a `signature` field that isn't valid base58. Surface
      // a domain-meaningful error instead of letting the bs58 stack trace
      // bubble up to the dApp.
      throw new Error(
        `WalletConnect signMessage returned a malformed signature: ${(err as Error).message}`,
      );
    }
    if (decoded.length !== 64) {
      throw new Error(
        `WalletConnect signMessage signature length unexpected: ${decoded.length}`,
      );
    }
    return decoded;
  }

  async function signTransaction(opts: {
    topic: string;
    chainId: string;
    transactionBase64: string;
  }): Promise<WalletConnectSignTransactionResult> {
    const result = await client.request<unknown>({
      topic: opts.topic,
      chainId: opts.chainId,
      request: {
        method: 'solana_signTransaction',
        params: { transaction: opts.transactionBase64 },
      },
    });
    return extractSignTransactionResult(result);
  }

  async function disconnect(topic: string): Promise<void> {
    await client.disconnect({
      topic,
      reason: { code: 6000, message: 'user_disconnected' },
    });
  }

  function listSessions(): WalletConnectSession[] {
    const raw = client.session?.getAll() ?? [];
    const out: WalletConnectSession[] = [];
    for (const session of raw) {
      const ns = session.namespaces[SOLANA_NAMESPACE];
      if (!ns) continue;
      for (const account of ns.accounts ?? []) {
        const parts = account.split(':');
        if (parts.length < 3) continue;
        const chainId = `${parts[0]}:${parts[1]}`;
        const address = parts.slice(2).join(':');
        if (!address) continue;
        out.push({ topic: session.topic, chainId, address });
      }
    }
    return out;
  }

  function on(
    event: 'session_delete' | 'session_expire',
    listener: (topic: string) => void,
  ): () => void {
    if (!client.on) return () => undefined;
    const wrapped = (args: { topic: string }) => listener(args.topic);
    client.on(event, wrapped);
    return () => {
      client.off?.(event, wrapped);
    };
  }

  return { connect, signMessage, signTransaction, disconnect, listSessions, on };
}

function resolveSession(
  session: WalletConnectSessionStruct,
  chains: string[],
): WalletConnectSession | null {
  const ns = session.namespaces[SOLANA_NAMESPACE];
  if (!ns) return null;
  const peerName = session.peer?.metadata?.name?.trim() || undefined;
  const peerIcons = session.peer?.metadata?.icons?.filter((s) => typeof s === 'string' && s.length > 0);
  for (const account of ns.accounts ?? []) {
    const parts = account.split(':');
    if (parts.length < 3) continue;
    const chainId = `${parts[0]}:${parts[1]}`;
    if (!chains.includes(chainId)) continue;
    const address = parts.slice(2).join(':');
    if (!address) continue;
    return {
      topic: session.topic,
      chainId,
      address,
      ...(peerName ? { peerName } : {}),
      ...(peerIcons && peerIcons.length > 0 ? { peerIcons } : {}),
    };
  }
  return null;
}

function extractSignature(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.signature === 'string') return record.signature;
  }
  throw new Error('WalletConnect signMessage returned no signature field.');
}

function extractSignTransactionResult(result: unknown): WalletConnectSignTransactionResult {
  if (typeof result === 'string') {
    // Legacy peers returned a bare string without naming whether it was the
    // signed transaction or the signature. Preserve it as both so the wallet
    // adapter can try signed bytes first and signature stitching second.
    return { transaction: result, signature: result };
  }
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    const transaction = typeof record.transaction === 'string'
      ? record.transaction
      : typeof record.signedTransaction === 'string'
        ? record.signedTransaction
        : undefined;
    const signature = typeof record.signature === 'string' ? record.signature : undefined;
    if (transaction || signature) {
      return {
        ...(transaction !== undefined && { transaction }),
        ...(signature !== undefined && { signature }),
      };
    }
  }
  throw new Error('WalletConnect signTransaction returned no transaction or signature field.');
}
