import { afterEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

import {
  buildConnectUrl,
  buildEncryptedUrl,
  detectIosLinkEnvironment,
  IosLinkBackend,
  iosLinkTransportPlan,
  walletDescriptor,
} from '../index.js';
import type { JupiterWalletConnectClient } from '../jupiterWalletConnect.js';

describe('ios-link', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects iOS Safari as eligible for a link transport attempt', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});

    const env = detectIosLinkEnvironment(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
    );

    expect(env.isIos).toBe(true);
    expect(env.isSafari).toBe(true);
    expect(env.canAttemptIosLink).toBe(true);
  });

  it('keeps iOS link transport explicit and includes Jupiter WalletConnect boundary', () => {
    const plan = iosLinkTransportPlan();

    expect(plan).toMatchObject({
      transport: 'ios-link',
      status: 'experimental',
    });
    expect(plan.wallets.map((wallet) => wallet.id)).toEqual([
      'phantom',
      'solflare',
      'backpack',
      'jupiter',
    ]);
    expect(plan.wallets.find((wallet) => wallet.id === 'jupiter')?.transport).toBe('walletconnect');
  });

  it('builds Phantom connect universal links with redirect and dapp key', () => {
    const phantom = walletDescriptor('phantom');
    expect(phantom).toBeDefined();

    const url = new URL(
      buildConnectUrl(phantom!, {
        appUrl: 'https://example.com',
        cluster: 'devnet',
        dappEncryptionPublicKey: 'DappKey111111111111111111111111111111111',
        redirectLink: 'https://agent.example/ios/callback/connect?requestId=req_1&token=t',
      }),
    );

    expect(url.origin).toBe('https://phantom.app');
    expect(url.pathname).toBe('/ul/v1/connect');
    expect(url.searchParams.get('cluster')).toBe('devnet');
    expect(url.searchParams.get('redirect_link')).toContain('/ios/callback/connect');
  });

  it('creates pending connect approvals for encrypted deeplink providers', async () => {
    const backend = new IosLinkBackend({
      provider: 'phantom',
      cluster: 'devnet',
      appUrl: 'https://example.com',
      callbackBaseUrl: 'https://agent.example',
      callbackToken: 'token',
      logLevel: 'silent',
    });

    const approval = await backend.connectWallet();

    expect(approval.status).toBe('pending');
    expect(approval.approvalUri).toContain('/ios/approval');
    expect(backend.getWalletApprovalUrl(approval.requestId)).toContain('https://phantom.app/ul/v1/connect');
  });

  it('builds encrypted signing links with deterministic nonce support', () => {
    const backpack = walletDescriptor('backpack');
    expect(backpack).toBeDefined();
    const dapp = nacl.box.keyPair();
    const wallet = nacl.box.keyPair();
    const nonce = new Uint8Array(nacl.box.nonceLength).fill(7);
    const url = new URL(
      buildEncryptedUrl(backpack!, 'signMessage', {
        dappEncryptionPublicKey: bs58.encode(dapp.publicKey),
        redirectLink: 'https://agent.example/ios/callback/sign?requestId=req_1&token=t',
        payload: { session: 'session-123', message: bs58.encode(new TextEncoder().encode('hello')) },
        session: {
          userPublicKey: 'User1111111111111111111111111111111111',
          token: 'session-123',
          walletEncryptionPublicKey: wallet.publicKey,
        },
        secretKey: dapp.secretKey,
        nonce,
      }),
    );

    expect(url.origin).toBe('https://backpack.app');
    expect(url.pathname).toBe('/ul/v1/signMessage');
    expect(url.searchParams.get('nonce')).toBe(bs58.encode(nonce));
    const encrypted = bs58.decode(url.searchParams.get('payload') ?? '');
    const plaintext = nacl.box.open(encrypted, nonce, dapp.publicKey, wallet.secretKey);
    expect(plaintext).toBeTruthy();
    expect(JSON.parse(new TextDecoder().decode(plaintext!))).toMatchObject({
      session: 'session-123',
    });
  });

  it('fails deterministically for Jupiter when Reown project id is missing', async () => {
    const backend = new IosLinkBackend({
      provider: 'jupiter',
      cluster: 'devnet',
      appUrl: 'https://example.com',
      callbackBaseUrl: 'https://agent.example',
      callbackToken: 'token',
      logLevel: 'silent',
    });

    await expect(backend.connectWallet()).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('creates Jupiter WalletConnect QR approvals and stores the approved session', async () => {
    const client = fakeWalletConnectClient({
      session: {
        topic: 'topic-123',
        namespaces: {
          solana: {
            accounts: ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:JupiterUser111111111111111111111111111'],
          },
        },
      },
      requestResult: { signature: 'sig-123' },
    });
    const backend = new IosLinkBackend({
      provider: 'jupiter',
      cluster: 'devnet',
      appUrl: 'https://example.com',
      callbackBaseUrl: 'https://agent.example',
      callbackToken: 'token',
      logLevel: 'silent',
      reownProjectId: 'project-123',
      walletConnectClientFactory: async () => client,
      walletConnectQrCodeFactory: async (uri) => `data:image/png;base64,${Buffer.from(uri).toString('base64')}`,
    });

    const approval = await backend.connectWallet();
    const view = await backend.getWalletApprovalView(approval.requestId);

    expect(approval.status).toBe('pending');
    expect(view.walletConnectUri).toBe('wc:pairing');
    expect(view.qrDataUrl).toContain('data:image/png;base64,');
    await vi.waitFor(async () => {
      expect(await backend.poll(approval.requestId)).toMatchObject({
        status: 'approved',
        result: { signature: 'JupiterUser111111111111111111111111111' },
      });
    });
    expect(await backend.getAddress()).toBe('JupiterUser111111111111111111111111111');
  });

  it('submits Jupiter WalletConnect signing requests after connect', async () => {
    const client = fakeWalletConnectClient({
      session: {
        topic: 'topic-123',
        namespaces: {
          solana: {
            accounts: ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:JupiterUser111111111111111111111111111'],
          },
        },
      },
      requestResult: { signature: 'sig-123' },
    });
    const backend = new IosLinkBackend({
      provider: 'jupiter',
      cluster: 'devnet',
      appUrl: 'https://example.com',
      callbackBaseUrl: 'https://agent.example',
      callbackToken: 'token',
      logLevel: 'silent',
      reownProjectId: 'project-123',
      walletConnectClientFactory: async () => client,
      walletConnectQrCodeFactory: async () => 'data:image/png;base64,qr',
    });

    const connect = await backend.connectWallet();
    await vi.waitFor(async () => {
      expect((await backend.poll(connect.requestId)).status).toBe('approved');
    });

    const signing = await backend.submit({
      id: 'sar_jupiter',
      kind: 'sign_message',
      cluster: 'devnet',
      payload: { data: 'hello', encoding: 'utf8' },
    });

    expect(signing.status).toBe('pending');
    await vi.waitFor(async () => {
      expect(await backend.poll('sar_jupiter')).toMatchObject({
        status: 'approved',
        result: { signature: 'sig-123' },
      });
    });
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        request: expect.objectContaining({
          method: 'solana_signMessage',
          params: expect.objectContaining({
            pubkey: 'JupiterUser111111111111111111111111111',
            message: bs58.encode(new TextEncoder().encode('hello')),
          }),
        }),
      }),
    );
  });
});

function fakeWalletConnectClient(options: {
  session: {
    topic: string;
    namespaces: Record<string, { accounts: string[] }>;
  };
  requestResult: unknown;
}): JupiterWalletConnectClient {
  const request = vi.fn(async () => options.requestResult);
  return {
    connect: vi.fn(async () => ({
      uri: 'wc:pairing',
      approval: async () => options.session,
    })),
    request: request as unknown as JupiterWalletConnectClient['request'],
    on: vi.fn(),
    session: {
      getAll: () => [],
    },
  };
}
