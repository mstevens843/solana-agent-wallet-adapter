import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import {
  attachSolanaSignature,
  DEFAULT_IOS_APP_URL,
  IosNativeWalletBackend,
  iosNativeAppUrl,
  iosNativeIsWalletConnectReturnUrl,
  iosNativeRedirectForWallet,
  iosNativeResolveCallbackWaiterKey,
  iosNativeWalletLaunchStrategy,
  iosNativeWalletConnectTransactionParam,
  restoreLatestIosNativeWallet,
  type IosNativeWalletId,
} from '../iosNative.js';

const IOS_AUTH_CACHE_KEY = 'agentic-ios-auth-cache-v1';

describe('iosNativeAppUrl', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AGENTIC_IOS_APP_URL', '');
    vi.stubEnv('VITE_AGENTIC_CLOUD_API_BASE_URL', '');
    vi.stubEnv('AGENTIC_CLOUD_API_BASE_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('defaults to the production HTTPS origin for native wallet sessions', () => {
    expect(iosNativeAppUrl()).toBe(DEFAULT_IOS_APP_URL);
  });

  it('uses an explicit iOS app URL as a normalized origin', () => {
    vi.stubEnv('VITE_AGENTIC_IOS_APP_URL', 'https://staging.agentic-signer.com/app?surface=ios');

    expect(iosNativeAppUrl()).toBe('https://staging.agentic-signer.com');
  });

  it('ignores non-HTTPS native webview origins and falls back to a hosted API origin', () => {
    vi.stubEnv('VITE_AGENTIC_IOS_APP_URL', 'capacitor://localhost');
    vi.stubEnv('VITE_AGENTIC_CLOUD_API_BASE_URL', 'https://agentic-signer.com/api/mobile-config');

    expect(iosNativeAppUrl()).toBe('https://agentic-signer.com');
  });
});

describe('IosNativeWalletBackend cache restore', () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not restore another wallet authorization for the selected iOS wallet', async () => {
    seedIosAuthCache([
      iosAuthRecord('phantom', 'Phantom111111111111111111111111111111111', 1),
    ]);

    const solflare = iosBackend('solflare');

    await expect(solflare.reconnectLatest()).resolves.toBeNull();
  });

  it('ignores disconnected iOS authorization records during restore', async () => {
    seedIosAuthCache([
      iosAuthRecord('phantom', 'Phantom111111111111111111111111111111111', 1, false),
    ]);

    await expect(
      restoreLatestIosNativeWallet({
        cluster: 'mainnet-beta',
        appUrl: DEFAULT_IOS_APP_URL,
        logLevel: 'silent',
      }),
    ).resolves.toBeNull();
  });

  it('restores a requested wallet even when another wallet is the latest cache entry', async () => {
    seedIosAuthCache([
      iosAuthRecord('solflare', 'Solflare1111111111111111111111111111111', 1),
      iosAuthRecord('phantom', 'Phantom111111111111111111111111111111111', 2),
    ]);

    const restored = await restoreLatestIosNativeWallet({
      walletId: 'solflare',
      cluster: 'mainnet-beta',
      appUrl: DEFAULT_IOS_APP_URL,
      logLevel: 'silent',
    });

    expect(restored).toMatchObject({
      address: 'Solflare1111111111111111111111111111111',
      walletId: 'solflare',
      walletName: 'Solflare',
    });
  });

  it('clears only the selected iOS wallet during a full reset', async () => {
    seedIosAuthCache([
      iosAuthRecord('phantom', 'Phantom111111111111111111111111111111111', 1),
      iosAuthRecord('solflare', 'Solflare1111111111111111111111111111111', 2),
    ]);

    await iosBackend('solflare').clearStateFullReset('test');

    await expect(iosBackend('solflare').reconnectLatest()).resolves.toBeNull();
    await expect(iosBackend('phantom').reconnectLatest()).resolves.toMatchObject({
      publicKey: 'Phantom111111111111111111111111111111111',
      walletId: 'phantom',
    });
  });
});

describe('iOS native Backpack deeplink compatibility', () => {
  it('uses associated-domain callbacks for Backpack only', () => {
    expect(iosNativeRedirectForWallet('backpack', 'agenticwallet', 'connect', 'req_1')).toBe(
      'https://agentic-signer.com/ios/callback/connect',
    );
    expect(iosNativeRedirectForWallet('backpack', 'agenticwallet', 'sign', 'req_2')).toBe(
      'https://agentic-signer.com/ios/callback/sign',
    );
    expect(iosNativeRedirectForWallet('phantom', 'agenticwallet', 'connect', 'req_3')).toBe(
      'agenticwallet://callback/connect?requestId=req_3&phase=connect',
    );
  });

  it('keeps Backpack callbacks on the production associated domain', () => {
    expect(
      iosNativeRedirectForWallet(
        'backpack',
        'agenticwallet',
        'connect',
        'req_1',
        'https://staging.agentic-signer.com/app',
      ),
    ).toBe('https://agentic-signer.com/ios/callback/connect');
  });

  it('uses WebView location launch for Backpack and native open for other iOS wallets', () => {
    expect(iosNativeWalletLaunchStrategy('backpack')).toBe('webview-location');
    expect(iosNativeWalletLaunchStrategy('phantom')).toBe('native-open');
    expect(iosNativeWalletLaunchStrategy('solflare')).toBe('native-open');
    expect(iosNativeWalletLaunchStrategy('jupiter')).toBe('native-open');
  });

  it('recognizes WalletConnect return callbacks without matching connect or sign callbacks', () => {
    expect(iosNativeIsWalletConnectReturnUrl('agenticwallet://callback/walletconnect')).toBe(true);
    expect(iosNativeIsWalletConnectReturnUrl('agenticwallet://callback/walletconnect?phase=walletconnect')).toBe(true);
    expect(iosNativeIsWalletConnectReturnUrl('https://agentic-signer.com/ios/callback/walletconnect')).toBe(true);
    expect(iosNativeIsWalletConnectReturnUrl('agenticwallet://callback/sign?requestId=req_1&phase=sign')).toBe(false);
    expect(iosNativeIsWalletConnectReturnUrl('https://agentic-signer.com/ios/callback/connect')).toBe(false);
  });

  it('matches plain Backpack callbacks to the single active waiter for that phase', () => {
    expect(iosNativeResolveCallbackWaiterKey(['connect:req_1'], 'connect', null)).toMatchObject({
      status: 'match',
      key: 'connect:req_1',
      requestId: 'req_1',
      matchKind: 'active',
    });
    expect(iosNativeResolveCallbackWaiterKey(['connect:req_1', 'connect:req_2'], 'connect', null)).toMatchObject({
      status: 'ambiguous',
      matchKind: 'active',
    });
    expect(iosNativeResolveCallbackWaiterKey(['sign:req_1'], 'connect', null)).toMatchObject({
      status: 'no_match',
      matchKind: 'active',
    });
    expect(iosNativeResolveCallbackWaiterKey(['connect:req_1'], 'connect', 'req_explicit')).toMatchObject({
      status: 'match',
      key: 'connect:req_explicit',
      requestId: 'req_explicit',
      matchKind: 'explicit',
    });
  });
});

describe('iosNativeWalletConnectTransactionParam', () => {
  it('keeps Jupiter WalletConnect transaction payloads in base64', () => {
    expect(iosNativeWalletConnectTransactionParam({
      data: 'AQIDBA==',
      encoding: 'base64',
    })).toBe('AQIDBA==');
  });

  it('base64-encodes non-base64 transaction payloads before WalletConnect submission', () => {
    expect(iosNativeWalletConnectTransactionParam({
      data: 'tx',
      encoding: 'utf8',
    })).toBe('dHg=');
  });
});

describe('attachSolanaSignature', () => {
  it('reconstructs a signed legacy transaction from a signature-only WalletConnect response', () => {
    const signer = Keypair.generate();
    const recipient = Keypair.generate();
    const signature = new Uint8Array(64).fill(17);
    const tx = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
    }).add(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 1,
      }),
    );
    const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    const signedBytes = attachSolanaSignature(
      new Uint8Array(unsigned),
      signer.publicKey.toBase58(),
      bs58.encode(signature),
    );

    const signed = Transaction.from(signedBytes);
    expect(signed.signatures[0]?.publicKey.equals(signer.publicKey)).toBe(true);
    expect(new Uint8Array(signed.signatures[0]!.signature!)).toEqual(signature);
  });

  it('reconstructs a signed versioned transaction from a signature-only WalletConnect response', () => {
    const signer = Keypair.generate();
    const recipient = Keypair.generate();
    const signature = new Uint8Array(64).fill(23);
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: recipient.publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);

    const signedBytes = attachSolanaSignature(
      tx.serialize(),
      signer.publicKey.toBase58(),
      bs58.encode(signature),
    );

    const signed = VersionedTransaction.deserialize(signedBytes);
    expect(signed.signatures[0]).toEqual(signature);
  });
});

function iosBackend(walletId: IosNativeWalletId): IosNativeWalletBackend {
  return new IosNativeWalletBackend({
    walletId,
    cluster: 'mainnet-beta',
    appUrl: DEFAULT_IOS_APP_URL,
    logLevel: 'silent',
  });
}

function installLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
  });
}

function seedIosAuthCache(records: Array<Record<string, unknown>>): void {
  localStorage.setItem(
    IOS_AUTH_CACHE_KEY,
    JSON.stringify({
      schema: 1,
      latest: String(records[records.length - 1]?.publicKey ?? ''),
      records: Object.fromEntries(records.map((record) => [String(record.publicKey), record])),
    }),
  );
}

function iosAuthRecord(
  walletId: Exclude<IosNativeWalletId, 'jupiter'>,
  publicKey: string,
  timestampUnixSeconds: number,
  authenticated = true,
): Record<string, unknown> {
  const walletName = walletId === 'phantom' ? 'Phantom' : walletId === 'solflare' ? 'Solflare' : 'Backpack';
  return {
    publicKey,
    walletId,
    walletName,
    cluster: 'mainnet-beta',
    session: `${walletId}-session`,
    walletEncryptionPublicKeyBase64: `${walletId}-wallet-key-b64`,
    walletEncryptionPublicKeyBase58: `${walletId}-wallet-key-b58`,
    sharedSecretBase64: `${walletId}-shared-secret`,
    dappPublicKeyBase64: `${walletId}-dapp-key`,
    dappSecretKeyBase64: `${walletId}-dapp-secret`,
    timestampUnixSeconds,
    authenticated,
  };
}
