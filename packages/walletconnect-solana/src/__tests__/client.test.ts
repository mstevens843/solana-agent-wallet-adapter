import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';

import {
  createWalletConnectSolanaClient,
  type SignClientLike,
  type WalletConnectSessionStruct,
} from '../client.js';
import { solanaWalletConnectChainId } from '../chains.js';

const MAINNET = solanaWalletConnectChainId('mainnet-beta');
const DEVNET = solanaWalletConnectChainId('devnet');
const ADDR = 'EmaginedRust11111111111111111111111111111111';

function buildSession(
  chainId: string,
  topic = 'topic-1',
  address = ADDR,
): WalletConnectSessionStruct {
  return {
    topic,
    namespaces: {
      solana: {
        accounts: [`${chainId}:${address}`],
        methods: ['solana_signMessage', 'solana_signTransaction'],
        events: [],
      },
    },
  };
}

function makeSignClient(overrides: Partial<SignClientLike> = {}): SignClientLike & {
  calls: { method: string; args: unknown }[];
} {
  const calls: { method: string; args: unknown }[] = [];
  const stub: SignClientLike & { calls: { method: string; args: unknown }[] } = {
    calls,
    async connect(args) {
      calls.push({ method: 'connect', args });
      return overrides.connect
        ? overrides.connect(args)
        : ({
            uri: 'wc:fake-uri',
            approval: async () => buildSession(MAINNET),
          } as Awaited<ReturnType<SignClientLike['connect']>>);
    },
    async request(args) {
      calls.push({ method: 'request', args });
      return overrides.request ? overrides.request(args) : ('' as unknown as never);
    },
    async disconnect(args) {
      calls.push({ method: 'disconnect', args });
      if (overrides.disconnect) await overrides.disconnect(args);
    },
    session: overrides.session,
    on: overrides.on,
    off: overrides.off,
  };
  return stub;
}

const METADATA = {
  name: 'Test',
  description: 'Test',
  url: 'https://example.invalid',
  icons: [],
};

describe('createWalletConnectSolanaClient.connect', () => {
  it('returns the pairing URI and resolves the session on approval', async () => {
    const sign = makeSignClient();
    const client = createWalletConnectSolanaClient({
      projectId: 'test',
      metadata: METADATA,
      signClient: sign,
    });
    const { uri, approval } = await client.connect({ chains: [MAINNET] });
    expect(uri).toBe('wc:fake-uri');
    const session = await approval();
    expect(session).toEqual({ topic: 'topic-1', address: ADDR, chainId: MAINNET });
  });

  it('throws if WalletConnect returns no URI', async () => {
    const sign = makeSignClient({
      connect: async () =>
        ({ approval: async () => buildSession(MAINNET) } as Awaited<ReturnType<SignClientLike['connect']>>),
    });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    await expect(client.connect({ chains: [MAINNET] })).rejects.toThrow(/pairing URI/);
  });

  it('throws when the peer authorizes a chain we did not request', async () => {
    const sign = makeSignClient({
      connect: async () =>
        ({
          uri: 'wc:fake',
          approval: async () => buildSession(DEVNET),
        } as Awaited<ReturnType<SignClientLike['connect']>>),
    });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    const { approval } = await client.connect({ chains: [MAINNET] });
    await expect(approval()).rejects.toThrow(/authorize a Solana account/);
  });

  it('forwards required namespaces with Solana methods and an empty events list', async () => {
    const sign = makeSignClient();
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    await client.connect({ chains: [DEVNET] });
    expect(sign.calls[0]).toEqual({
      method: 'connect',
      args: {
        requiredNamespaces: {
          solana: {
            chains: [DEVNET],
            methods: ['solana_signMessage', 'solana_signTransaction'],
            events: [],
          },
        },
      },
    });
  });
});

describe('signMessage', () => {
  it('routes solana_signMessage with base58 message + decodes base58 signature', async () => {
    const sig = new Uint8Array(64).fill(7);
    const sign = makeSignClient({
      request: async () => ({ signature: bs58.encode(sig) }),
    });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    const message = new TextEncoder().encode('hello');
    const result = await client.signMessage({
      topic: 'topic-1',
      chainId: MAINNET,
      pubkey: ADDR,
      message,
    });
    expect(result).toEqual(sig);

    const request = sign.calls.find((c) => c.method === 'request')!.args as {
      topic: string;
      chainId: string;
      request: { method: string; params: { pubkey: string; message: string } };
    };
    expect(request.request.method).toBe('solana_signMessage');
    expect(request.request.params).toEqual({ pubkey: ADDR, message: bs58.encode(message) });
  });

  it('throws when the response is missing signature', async () => {
    const sign = makeSignClient({ request: async () => ({}) });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    await expect(
      client.signMessage({ topic: 't', chainId: MAINNET, pubkey: ADDR, message: new Uint8Array() }),
    ).rejects.toThrow(/no signature/);
  });

  it('accepts a bare string signature too (legacy peer)', async () => {
    const sig = new Uint8Array(64).fill(3);
    const sign = makeSignClient({ request: async () => bs58.encode(sig) });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    const result = await client.signMessage({
      topic: 't',
      chainId: MAINNET,
      pubkey: ADDR,
      message: new Uint8Array([1, 2, 3]),
    });
    expect(result).toEqual(sig);
  });

  it('throws a clear error when the peer returns non-base58 in the signature field (Slice R.6)', async () => {
    // Peer returns 'not base58!!!' — char '!' is outside the bs58 alphabet.
    const sign = makeSignClient({ request: async () => ({ signature: 'not base58!!!' }) });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    await expect(
      client.signMessage({ topic: 't', chainId: MAINNET, pubkey: ADDR, message: new Uint8Array([1]) }),
    ).rejects.toThrow(/malformed signature/);
  });

  it('throws when the peer returns a valid-base58 string of the wrong byte length', async () => {
    // 16-byte buffer base58-encoded — valid base58, wrong length for ed25519.
    const sign = makeSignClient({
      request: async () => ({ signature: bs58.encode(new Uint8Array(16).fill(1)) }),
    });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    await expect(
      client.signMessage({ topic: 't', chainId: MAINNET, pubkey: ADDR, message: new Uint8Array([1]) }),
    ).rejects.toThrow(/length unexpected/);
  });
});

describe('signTransaction', () => {
  it('routes solana_signTransaction and returns the base64 signed tx', async () => {
    const sign = makeSignClient({
      request: async () => ({ transaction: 'signed-base64' }),
    });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    const result = await client.signTransaction({
      topic: 'topic-1',
      chainId: MAINNET,
      transactionBase64: 'pending-base64',
    });
    expect(result).toBe('signed-base64');
    const request = sign.calls.find((c) => c.method === 'request')!.args as {
      request: { method: string; params: { transaction: string } };
    };
    expect(request.request.method).toBe('solana_signTransaction');
    expect(request.request.params).toEqual({ transaction: 'pending-base64' });
  });

  it('accepts `signedTransaction` as a fallback field name', async () => {
    const sign = makeSignClient({
      request: async () => ({ signedTransaction: 'fallback' }),
    });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    const result = await client.signTransaction({
      topic: 't',
      chainId: MAINNET,
      transactionBase64: 'x',
    });
    expect(result).toBe('fallback');
  });

  it('throws when no transaction field is present', async () => {
    const sign = makeSignClient({ request: async () => ({}) });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    await expect(
      client.signTransaction({ topic: 't', chainId: MAINNET, transactionBase64: 'x' }),
    ).rejects.toThrow(/no transaction/);
  });
});

describe('disconnect', () => {
  it('forwards topic + reason code', async () => {
    const sign = makeSignClient();
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    await client.disconnect('topic-1');
    expect(sign.calls.find((c) => c.method === 'disconnect')!.args).toEqual({
      topic: 'topic-1',
      reason: { code: 6000, message: 'user_disconnected' },
    });
  });
});

describe('listSessions', () => {
  it('enumerates Solana-namespaced sessions only', async () => {
    const sessions: WalletConnectSessionStruct[] = [
      buildSession(MAINNET, 'topic-1', ADDR),
      {
        topic: 'topic-eth',
        namespaces: { eip155: { accounts: ['eip155:1:0xabc'] } },
      },
    ];
    const sign = makeSignClient({
      session: { getAll: () => sessions },
    });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    const out = client.listSessions();
    expect(out).toEqual([{ topic: 'topic-1', chainId: MAINNET, address: ADDR }]);
  });

  it('returns empty when the underlying client has no session helper', () => {
    const sign = makeSignClient();
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    expect(client.listSessions()).toEqual([]);
  });
});

describe('on', () => {
  it('subscribes to session_delete and returns an unsubscribe', () => {
    const listeners: Array<(args: { topic: string }) => void> = [];
    const sign = makeSignClient({
      on: vi.fn((event, listener) => {
        if (event === 'session_delete') listeners.push(listener);
      }),
      off: vi.fn((event, listener) => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      }),
    });
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    const received: string[] = [];
    const off = client.on('session_delete', (topic) => received.push(topic));
    listeners[0]?.({ topic: 'topic-x' });
    expect(received).toEqual(['topic-x']);
    off();
    expect(listeners).toHaveLength(0);
  });

  it('returns a no-op unsubscribe when the underlying client lacks .on', () => {
    const sign = makeSignClient();
    const client = createWalletConnectSolanaClient({
      projectId: 't',
      metadata: METADATA,
      signClient: sign,
    });
    const off = client.on('session_delete', () => undefined);
    expect(typeof off).toBe('function');
  });
});
