import bs58 from 'bs58';
import nacl from 'tweetnacl';

import {
  newSigningRequestId,
  ProtocolError,
  type AdapterCapabilities,
  type ApprovalResource,
  type Cluster,
  type SigningRequest,
  type SigningRequestId,
  type SigningResult,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';
import { Connection } from '@solana/web3.js';
import {
  JupiterWalletConnect,
  type JupiterWalletConnectClientFactory,
  type JupiterQrCodeFactory,
} from './jupiterWalletConnect.js';

export type IosLinkWalletId = 'phantom' | 'solflare' | 'backpack' | 'jupiter' | 'custom';
export type IosLinkLogLevel = 'silent' | 'error' | 'info' | 'debug';

export interface IosLinkWalletDescriptor {
  id: IosLinkWalletId;
  name: string;
  universalLinkHost?: string;
  customScheme?: string;
  connectPublicKeyParams: ReadonlyArray<string>;
  transport: 'encrypted-deeplink' | 'walletconnect';
  supportsUniversalLinks: boolean;
  supportsCustomScheme: boolean;
  status: 'experimental' | 'supported';
}

export interface IosLinkEnvironment {
  isBrowser: boolean;
  isIos: boolean;
  isSafari: boolean;
  canAttemptIosLink: boolean;
  userAgent: string;
}

export interface IosLinkBackendOptions {
  provider: IosLinkWalletId;
  cluster: Cluster;
  appUrl: string;
  callbackBaseUrl: string;
  callbackToken?: string;
  rpcUrl?: string;
  requestTtlMs?: number;
  logLevel?: IosLinkLogLevel;
  reownProjectId?: string;
  walletConnectStorageDir?: string;
  walletConnectClientFactory?: JupiterWalletConnectClientFactory;
  walletConnectQrCodeFactory?: JupiterQrCodeFactory;
}

export interface IosSession {
  userPublicKey: string;
  walletEncryptionPublicKey?: Uint8Array;
  walletConnectTopic?: string;
  token: string;
}

interface PendingIosApproval {
  approval: ApprovalResource;
  walletUrl: string;
  walletConnectUri?: string;
  qrDataUrl?: string;
  request?: SigningRequest;
  createdAt: number;
  kind: 'connect' | 'signing';
}

interface DecodedConnect {
  walletEncryptionPublicKey: Uint8Array;
  userPublicKey: string;
  session: string;
}

interface DecodedSigningPayload {
  signature?: string;
  transaction?: string;
}

export const IOS_LINK_WALLETS: ReadonlyArray<IosLinkWalletDescriptor> = [
  {
    id: 'phantom',
    name: 'Phantom',
    universalLinkHost: 'phantom.app',
    customScheme: 'phantom',
    connectPublicKeyParams: ['phantom_encryption_public_key', 'wallet_encryption_public_key'],
    transport: 'encrypted-deeplink',
    supportsUniversalLinks: true,
    supportsCustomScheme: true,
    status: 'supported',
  },
  {
    id: 'solflare',
    name: 'Solflare',
    universalLinkHost: 'solflare.com',
    customScheme: 'solflare',
    connectPublicKeyParams: ['solflare_encryption_public_key', 'wallet_encryption_public_key'],
    transport: 'encrypted-deeplink',
    supportsUniversalLinks: true,
    supportsCustomScheme: true,
    status: 'supported',
  },
  {
    id: 'backpack',
    name: 'Backpack',
    universalLinkHost: 'backpack.app',
    customScheme: 'backpack',
    connectPublicKeyParams: ['backpack_encryption_public_key', 'wallet_encryption_public_key'],
    transport: 'encrypted-deeplink',
    supportsUniversalLinks: true,
    supportsCustomScheme: true,
    status: 'supported',
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    connectPublicKeyParams: [],
    transport: 'walletconnect',
    supportsUniversalLinks: false,
    supportsCustomScheme: false,
    status: 'experimental',
  },
];

const CONNECT_METHOD = 'connect';
const SIGN_MESSAGE_METHOD = 'signMessage';
const SIGN_TRANSACTION_METHOD = 'signTransaction';

export class IosLinkBackend implements WalletBackend {
  readonly token: string;

  private readonly provider: IosLinkWalletDescriptor;
  private readonly cluster: Cluster;
  private readonly appUrl: string;
  private readonly connection: Connection;
  private readonly requestTtlMs: number;
  private readonly logLevel: IosLinkLogLevel;
  private readonly jupiterWalletConnect?: JupiterWalletConnect;
  private callbackBaseUrl: string;
  private readonly keyPair = nacl.box.keyPair();
  private readonly pending = new Map<SigningRequestId, PendingIosApproval>();
  private session: IosSession | null = null;

  constructor(options: IosLinkBackendOptions) {
    const provider = walletDescriptor(options.provider);
    if (!provider) {
      throw new ProtocolError('invalid_request', `Unsupported iOS wallet provider: ${options.provider}`);
    }
    this.provider = provider;
    this.cluster = options.cluster;
    this.appUrl = options.appUrl;
    this.callbackBaseUrl = options.callbackBaseUrl;
    this.token = options.callbackToken ?? 'local-agent-wallet';
    this.connection = new Connection(options.rpcUrl ?? defaultRpcUrl(options.cluster), 'confirmed');
    this.requestTtlMs = options.requestTtlMs ?? 120000;
    this.logLevel = options.logLevel ?? 'info';
    if (provider.id === 'jupiter') {
      this.jupiterWalletConnect = new JupiterWalletConnect({
        projectId: options.reownProjectId,
        storageDir: options.walletConnectStorageDir,
        appUrl: options.appUrl,
        cluster: options.cluster,
        requestTtlMs: this.requestTtlMs,
        log: this.log.bind(this),
        clientFactory: options.walletConnectClientFactory,
        qrCodeFactory: options.walletConnectQrCodeFactory,
      });
    }
    this.log('IosLinkBackend', 'constructor', 'STEP_1_READY', 'info', 'backend initialized', {
      wallet: provider.id,
      cluster: this.cluster,
      callback: urlShape(this.callbackBaseUrl),
      transport: provider.transport,
    });
  }

  setApprovalBaseUrl(url: string): void {
    this.callbackBaseUrl = url;
    this.log('IosLinkBackend', 'setApprovalBaseUrl', 'STEP_1_SET', 'debug', 'approval base URL set', {
      callback: urlShape(url),
    });
  }

  getApprovalUrl(): string {
    const url = new URL(ensureTrailingSlash(this.callbackBaseUrl));
    url.searchParams.set('token', this.token);
    return url.toString();
  }

  async capabilities(): Promise<AdapterCapabilities> {
    const supported = this.provider.transport === 'encrypted-deeplink' || this.provider.id === 'jupiter';
    return {
      backend: `ios-link-${this.provider.id}`,
      cluster: [this.cluster],
      supports: {
        signMessage: supported,
        signTransaction: supported,
        signAndSendTransaction: supported,
        multiSign: false,
        simulationPreview: false,
      },
      ...(this.session && { address: this.session.userPublicKey }),
    };
  }

  async getAddress(): Promise<string> {
    if (!this.session) {
      this.log('IosLinkBackend', 'getAddress', 'STEP_FAIL', 'error', 'no active iOS wallet session', {
        wallet: this.provider.id,
      });
      throw new ProtocolError(
        'unauthorized',
        'No iOS wallet session is connected. Call solana_connect_wallet and approve the iOS wallet link first.',
      );
    }
    return this.session.userPublicKey;
  }

  async connectWallet(): Promise<ApprovalResource> {
    if (this.session) {
      this.log('IosLinkBackend', 'connectWallet', 'STEP_1_ALREADY_CONNECTED', 'info', 'session already connected', {
        wallet: this.provider.id,
        address: short(this.session.userPublicKey),
      });
      return {
        requestId: newSigningRequestId(),
        status: 'approved',
        result: { signature: this.session.userPublicKey },
      };
    }
    if (this.provider.id === 'jupiter') {
      return this.connectJupiterWallet();
    }
    this.assertEncryptedProvider('connectWallet');
    const requestId = newSigningRequestId();
    const redirect = this.callbackUrl('connect', requestId);
    const walletUrl = buildConnectUrl(this.provider, {
      appUrl: this.appUrl,
      cluster: this.cluster,
      dappEncryptionPublicKey: bs58.encode(this.keyPair.publicKey),
      redirectLink: redirect,
    });
    const approval: ApprovalResource = {
      requestId,
      status: 'pending',
      approvalUri: this.approvalPageUrl(requestId),
    };
    this.pending.set(requestId, {
      approval,
      walletUrl,
      createdAt: Date.now(),
      kind: 'connect',
    });
    this.log('IosLinkBackend', 'connectWallet', 'STEP_2_URL_BUILT', 'info', 'connect approval created', {
      requestId,
      wallet: this.provider.id,
      walletUrl: urlShape(walletUrl),
      callback: urlShape(redirect),
    });
    return approval;
  }

  async submit(request: SigningRequest): Promise<ApprovalResource> {
    if (request.cluster !== this.cluster) {
      this.log('IosLinkBackend', 'submit', 'STEP_FAIL', 'error', 'cluster mismatch', {
        requestId: request.id,
        requestCluster: request.cluster,
        backendCluster: this.cluster,
      });
      throw new ProtocolError(
        'cluster_mismatch',
        `iOS backend is configured for ${this.cluster}; request targets ${request.cluster}.`,
      );
    }
    if (!this.session) {
      this.log('IosLinkBackend', 'submit', 'STEP_FAIL', 'error', 'signing requested before connect', {
        requestId: request.id,
        kind: request.kind,
      });
      throw new ProtocolError(
        'unauthorized',
        'No iOS wallet session is connected. Call solana_connect_wallet and approve the iOS wallet link first.',
      );
    }

    if (this.provider.id === 'jupiter') {
      return this.submitJupiter(request);
    }
    this.assertEncryptedProvider('submit');
    if (!this.session.walletEncryptionPublicKey) {
      throw new ProtocolError('unauthorized', 'Missing encrypted iOS wallet session.');
    }

    const method = request.kind === 'sign_message' ? SIGN_MESSAGE_METHOD : SIGN_TRANSACTION_METHOD;
    const payload = this.buildSigningPayload(request);
    const redirect = this.callbackUrl('sign', request.id);
    const walletUrl = buildEncryptedUrl(this.provider, method, {
      dappEncryptionPublicKey: bs58.encode(this.keyPair.publicKey),
      redirectLink: redirect,
      payload,
      session: { ...this.session, walletEncryptionPublicKey: this.session.walletEncryptionPublicKey },
      secretKey: this.keyPair.secretKey,
    });
    const approval: ApprovalResource = {
      requestId: request.id,
      status: 'pending',
      approvalUri: this.approvalPageUrl(request.id),
    };
    this.pending.set(request.id, {
      approval,
      walletUrl,
      request,
      createdAt: Date.now(),
      kind: 'signing',
    });
    this.log('IosLinkBackend', 'submit', 'STEP_4_URL_BUILT', 'info', 'signing approval created', {
      requestId: request.id,
      kind: request.kind,
      wallet: this.provider.id,
      method,
      payloadKeys: Object.keys(payload).sort().join(','),
      walletUrl: urlShape(walletUrl),
      callback: urlShape(redirect),
    });
    return approval;
  }

  async poll(requestId: SigningRequestId): Promise<ApprovalResource> {
    const entry = this.pending.get(requestId);
    if (!entry) {
      throw new ProtocolError('invalid_request', `Unknown iOS request id: ${requestId}`);
    }
    this.expireIfNeeded(requestId, entry);
    return entry.approval;
  }

  async cancel(requestId: SigningRequestId): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    entry.approval = {
      requestId,
      status: 'rejected',
      error: {
        code: 'user_rejected',
        message: 'iOS approval request cancelled by caller.',
        recoverable: false,
      },
    };
    this.log('IosLinkBackend', 'cancel', 'STEP_1_CANCELLED', 'info', 'approval cancelled', {
      requestId,
    });
  }

  getWalletApprovalUrl(requestId: SigningRequestId): string {
    const entry = this.pending.get(requestId);
    if (!entry) {
      throw new ProtocolError('invalid_request', `Unknown iOS request id: ${requestId}`);
    }
    return entry.walletUrl;
  }

  async getWalletApprovalView(requestId: SigningRequestId): Promise<{
    walletUrl: string;
    walletConnectUri?: string;
    qrDataUrl?: string;
    wallet: string;
    kind: PendingIosApproval['kind'];
  }> {
    const entry = this.pending.get(requestId);
    if (!entry) {
      throw new ProtocolError('invalid_request', `Unknown iOS request id: ${requestId}`);
    }
    if (entry.walletConnectUri && !entry.qrDataUrl && this.jupiterWalletConnect) {
      entry.qrDataUrl = await this.jupiterWalletConnect.qrDataUrl(entry.walletConnectUri);
    }
    return {
      walletUrl: entry.walletUrl,
      ...(entry.walletConnectUri !== undefined && { walletConnectUri: entry.walletConnectUri }),
      ...(entry.qrDataUrl !== undefined && { qrDataUrl: entry.qrDataUrl }),
      wallet: this.provider.name,
      kind: entry.kind,
    };
  }

  async handleCallback(callbackUrl: string | URL): Promise<ApprovalResource> {
    const url = typeof callbackUrl === 'string' ? new URL(callbackUrl) : callbackUrl;
    const requestId = url.searchParams.get('requestId') ?? '';
    const phase = url.searchParams.get('phase') ?? '';
    this.log('IosLinkBackend', 'handleCallback', 'STEP_1_START', 'info', 'wallet callback received', {
      requestId,
      phase,
      callback: urlShape(url.toString()),
      queryKeys: queryKeys(url),
    });
    if (!requestId) {
      throw new ProtocolError('invalid_request', 'Missing iOS requestId in callback.');
    }
    const entry = this.pending.get(requestId);
    if (!entry) {
      throw new ProtocolError('invalid_request', `Unknown iOS request id: ${requestId}`);
    }

    const walletError = walletErrorFromCallback(url);
    if (walletError) {
      entry.approval = {
        requestId,
        status: walletError.code === 'user_rejected' ? 'rejected' : 'failed',
        error: walletError.toPayload(),
      };
      this.log('IosLinkBackend', 'handleCallback', 'STEP_FAIL', 'error', 'wallet returned error', {
        requestId,
        code: walletError.code,
        message: walletError.message,
      });
      return entry.approval;
    }

    if (entry.kind === 'connect') {
      const decoded = this.decodeConnect(url);
      this.session = {
        userPublicKey: decoded.userPublicKey,
        token: decoded.session,
        walletEncryptionPublicKey: decoded.walletEncryptionPublicKey,
      };
      entry.approval = {
        requestId,
        status: 'approved',
        result: { signature: decoded.userPublicKey },
      };
      this.log('IosLinkBackend', 'handleCallback', 'STEP_5_SESSION_STORED', 'info', 'connect callback decoded', {
        requestId,
        address: short(decoded.userPublicKey),
        walletKey: short(bs58.encode(decoded.walletEncryptionPublicKey)),
      });
      return entry.approval;
    }

    if (!entry.request || !this.session) {
      throw new ProtocolError('invalid_request', 'Signing callback does not have matching request/session state.');
    }
    const payload = this.decodeSigning(url);
    entry.approval = await this.resolveSigning(entry.request, payload);
    this.log('IosLinkBackend', 'handleCallback', 'STEP_5_RESULT_DECODED', 'info', 'signing callback resolved', {
      requestId,
      kind: entry.request.kind,
      status: entry.approval.status,
      txid: entry.approval.result?.txid ? short(entry.approval.result.txid) : '',
    });
    return entry.approval;
  }

  private async connectJupiterWallet(): Promise<ApprovalResource> {
    if (!this.jupiterWalletConnect) {
      throw new ProtocolError('unsupported_method', 'Jupiter WalletConnect is not configured.');
    }
    const pairing = await this.jupiterWalletConnect.connect();
    if (!pairing.uri) {
      const session = await pairing.approval();
      this.session = {
        userPublicKey: session.address,
        walletConnectTopic: session.topic,
        token: session.topic,
      };
      return {
        requestId: newSigningRequestId(),
        status: 'approved',
        result: { signature: session.address },
      };
    }
    const requestId = newSigningRequestId();
    const approval: ApprovalResource = {
      requestId,
      status: 'pending',
      approvalUri: this.approvalPageUrl(requestId),
    };
    this.pending.set(requestId, {
      approval,
      walletUrl: pairing.uri,
      walletConnectUri: pairing.uri,
      createdAt: Date.now(),
      kind: 'connect',
    });
    this.log('IosLinkBackend', 'connectJupiterWallet', 'STEP_2_URL_BUILT', 'info', 'WalletConnect approval created', {
      requestId,
      wallet: this.provider.id,
      uriBytes: String(pairing.uri.length),
    });
    void pairing
      .approval()
      .then((session) => {
        this.session = {
          userPublicKey: session.address,
          walletConnectTopic: session.topic,
          token: session.topic,
        };
        const entry = this.pending.get(requestId);
        if (!entry || entry.approval.status !== 'pending') {
          return;
        }
        entry.approval = {
          requestId,
          status: 'approved',
          result: { signature: session.address },
        };
      })
      .catch((err: unknown) => {
        const entry = this.pending.get(requestId);
        if (!entry || entry.approval.status !== 'pending') {
          return;
        }
        const protocolErr = protocolErrorFromUnknown(err, 'Jupiter WalletConnect session approval failed.');
        entry.approval = {
          requestId,
          status: protocolErr.code === 'user_rejected' ? 'rejected' : 'failed',
          error: protocolErr.toPayload(),
        };
        this.log('IosLinkBackend', 'connectJupiterWallet', 'STEP_FAIL', 'error', 'WalletConnect approval failed', {
          requestId,
          code: protocolErr.code,
          message: protocolErr.message,
        });
      });
    return approval;
  }

  private submitJupiter(request: SigningRequest): ApprovalResource {
    if (!this.jupiterWalletConnect) {
      throw new ProtocolError('unsupported_method', 'Jupiter WalletConnect is not configured.');
    }
    const approval: ApprovalResource = {
      requestId: request.id,
      status: 'pending',
      approvalUri: this.approvalPageUrl(request.id),
    };
    this.pending.set(request.id, {
      approval,
      walletUrl: 'walletconnect:jupiter',
      request,
      createdAt: Date.now(),
      kind: 'signing',
    });
    void this.jupiterWalletConnect
      .requestSigning(request)
      .then(async (payload) => {
        const entry = this.pending.get(request.id);
        if (!entry || entry.approval.status !== 'pending') {
          return;
        }
        entry.approval = await this.resolveJupiterSigning(request, payload);
      })
      .catch((err: unknown) => {
        const entry = this.pending.get(request.id);
        if (!entry || entry.approval.status !== 'pending') {
          return;
        }
        const protocolErr = protocolErrorFromUnknown(err, 'Jupiter WalletConnect signing failed.');
        entry.approval = {
          requestId: request.id,
          status: protocolErr.code === 'user_rejected' ? 'rejected' : 'failed',
          error: protocolErr.toPayload(),
        };
        this.log('IosLinkBackend', 'submitJupiter', 'STEP_FAIL', 'error', 'WalletConnect signing failed', {
          requestId: request.id,
          code: protocolErr.code,
          message: protocolErr.message,
        });
      });
    return approval;
  }

  private assertEncryptedProvider(method: string): void {
    if (this.provider.transport === 'encrypted-deeplink') {
      return;
    }
    this.log('IosLinkBackend', method, 'STEP_FAIL', 'error', 'walletconnect provider not wired', {
      wallet: this.provider.id,
    });
    throw new ProtocolError(
      'unsupported_method',
      'This iOS wallet provider does not use encrypted deeplinks.',
    );
  }

  private buildSigningPayload(request: SigningRequest): Record<string, unknown> {
    if (!this.session) {
      throw new ProtocolError('unauthorized', 'Missing iOS session.');
    }
    switch (request.kind) {
      case 'sign_message': {
        const message = decodePayload(request.payload.data, request.payload.encoding);
        this.log('IosLinkBackend', 'buildSigningPayload', 'STEP_3_PAYLOAD_BUILD', 'debug', 'message payload built', {
          requestId: request.id,
          messageBytes: String(message.length),
        });
        return {
          session: this.session.token,
          message: bs58.encode(message),
          display: 'utf8',
        };
      }
      case 'sign_transaction':
      case 'sign_and_send_transaction': {
        const transaction = decodePayload(request.payload.data, request.payload.encoding);
        this.log('IosLinkBackend', 'buildSigningPayload', 'STEP_3_PAYLOAD_BUILD', 'debug', 'transaction payload built', {
          requestId: request.id,
          transactionBytes: String(transaction.length),
          signAndSendMode: request.kind === 'sign_and_send_transaction' ? 'sign-then-send' : 'sign-only',
        });
        return {
          session: this.session.token,
          transaction: bs58.encode(transaction),
        };
      }
    }
  }

  private decodeConnect(url: URL): DecodedConnect {
    const params = paramsFromUrl(url);
    const walletKey = findWalletEncryptionKey(params, this.provider);
    if (!walletKey) {
      this.log('WalletResponseDecoder', 'connect', 'STEP_FAIL', 'error', 'missing wallet encryption public key', {
        queryKeys: queryKeys(url),
        expectedKeys: walletEncryptionKeyAliases(this.provider).join(','),
      });
      throw new ProtocolError('invalid_request', 'iOS connect callback is missing wallet encryption public key.');
    }
    const walletPublicKey = decodeBase58(walletKey.value, 'wallet encryption public key');
    this.log('WalletResponseDecoder', 'connect', 'STEP_2_WALLET_KEY_OK', 'debug', 'wallet encryption public key found', {
      alias: walletKey.alias,
      walletKey: short(walletKey.value),
    });
    const payload = this.decryptPayload(params, walletPublicKey, 'connect');
    const publicKey = stringField(payload, 'public_key');
    const session = stringField(payload, 'session');
    return { walletEncryptionPublicKey: walletPublicKey, userPublicKey: publicKey, session };
  }

  private decodeSigning(url: URL): DecodedSigningPayload {
    if (!this.session?.walletEncryptionPublicKey) {
      throw new ProtocolError('unauthorized', 'Missing iOS session.');
    }
    return this.decryptPayload(paramsFromUrl(url), this.session.walletEncryptionPublicKey, 'signing') as DecodedSigningPayload;
  }

  private decryptPayload(
    params: URLSearchParams,
    walletPublicKey: Uint8Array,
    method: string,
  ): Record<string, unknown> {
    const nonceString = params.get('nonce');
    const dataString = params.get('data');
    if (!nonceString) {
      this.log('WalletResponseDecoder', method, 'STEP_FAIL', 'error', 'response missing nonce', {
        queryKeys: [...params.keys()].sort().join(','),
      });
      throw new ProtocolError('invalid_request', 'iOS wallet callback is missing nonce.');
    }
    if (!dataString) {
      this.log('WalletResponseDecoder', method, 'STEP_FAIL', 'error', 'response missing data', {
        queryKeys: [...params.keys()].sort().join(','),
      });
      throw new ProtocolError('invalid_request', 'iOS wallet callback is missing data.');
    }
    const nonce = decodeBase58(nonceString, 'nonce');
    const data = decodeBase58(dataString, 'encrypted data');
    if (nonce.length !== nacl.box.nonceLength) {
      this.log('WalletResponseDecoder', method, 'STEP_FAIL', 'error', 'invalid nonce length', {
        nonceBytes: String(nonce.length),
      });
      throw new ProtocolError('invalid_request', 'iOS wallet callback nonce has invalid length.');
    }
    this.log('WalletResponseDecoder', method, 'STEP_3_ENVELOPE_OK', 'debug', 'encrypted envelope decoded', {
      nonceBytes: String(nonce.length),
      ciphertextBytes: String(data.length),
    });
    const plaintext = nacl.box.open(data, nonce, walletPublicKey, this.keyPair.secretKey);
    if (!plaintext) {
      this.log('WalletResponseDecoder', method, 'STEP_FAIL', 'error', 'response decryption failed', {
        nonceBytes: String(nonce.length),
        ciphertextBytes: String(data.length),
      });
      throw new ProtocolError('unauthorized', 'Unable to decrypt iOS wallet response.');
    }
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    this.log('WalletResponseDecoder', method, 'STEP_4_PAYLOAD_DECRYPTED', 'debug', 'payload decrypted', {
      plaintextBytes: String(plaintext.length),
      payloadKeys: Object.keys(parsed).sort().join(','),
    });
    return parsed;
  }

  private async resolveSigning(
    request: SigningRequest,
    payload: DecodedSigningPayload,
  ): Promise<ApprovalResource> {
    switch (request.kind) {
      case 'sign_message': {
        if (!payload.signature) {
          throw new ProtocolError('wallet_unreachable', 'iOS wallet returned no message signature.');
        }
        return {
          requestId: request.id,
          status: 'approved',
          result: { signature: payload.signature },
        };
      }
      case 'sign_transaction': {
        if (!payload.transaction) {
          throw new ProtocolError('wallet_unreachable', 'iOS wallet returned no signed transaction.');
        }
        const transaction = decodeBase58(payload.transaction, 'signed transaction');
        return {
          requestId: request.id,
          status: 'approved',
          result: { signature: encodeBase64(transaction) },
        };
      }
      case 'sign_and_send_transaction': {
        if (!payload.transaction) {
          throw new ProtocolError('wallet_unreachable', 'iOS wallet returned no signed transaction.');
        }
        const transaction = decodeBase58(payload.transaction, 'signed transaction');
        this.log('IosLinkBackend', 'resolveSigning', 'STEP_6_RPC_SEND', 'info', 'sending signed transaction', {
          requestId: request.id,
          transactionBytes: String(transaction.length),
        });
        const txid = await this.connection.sendRawTransaction(transaction, {
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
        await this.connection.confirmTransaction(txid, 'confirmed');
        return {
          requestId: request.id,
          status: 'approved',
          result: { signature: txid, txid },
        };
      }
    }
  }

  private async resolveJupiterSigning(
    request: SigningRequest,
    payload: DecodedSigningPayload,
  ): Promise<ApprovalResource> {
    switch (request.kind) {
      case 'sign_message': {
        if (!payload.signature) {
          throw new ProtocolError('wallet_unreachable', 'Jupiter WalletConnect returned no message signature.');
        }
        return {
          requestId: request.id,
          status: 'approved',
          result: { signature: payload.signature },
        };
      }
      case 'sign_transaction': {
        if (payload.transaction) {
          return {
            requestId: request.id,
            status: 'approved',
            result: { signature: payload.transaction },
          };
        }
        if (payload.signature) {
          return {
            requestId: request.id,
            status: 'approved',
            result: { signature: payload.signature },
          };
        }
        throw new ProtocolError('wallet_unreachable', 'Jupiter WalletConnect returned no signed transaction.');
      }
      case 'sign_and_send_transaction': {
        if (!payload.signature) {
          throw new ProtocolError('wallet_unreachable', 'Jupiter WalletConnect returned no transaction signature.');
        }
        return {
          requestId: request.id,
          status: 'approved',
          result: { signature: payload.signature, txid: payload.signature },
        };
      }
    }
  }

  private callbackUrl(phase: 'connect' | 'sign', requestId: string): string {
    const url = new URL(`ios/callback/${phase}`, ensureTrailingSlash(this.callbackBaseUrl));
    url.searchParams.set('requestId', requestId);
    url.searchParams.set('phase', phase);
    url.searchParams.set('token', this.token);
    return url.toString();
  }

  private approvalPageUrl(requestId: string): string {
    const url = new URL('ios/approval', ensureTrailingSlash(this.callbackBaseUrl));
    url.searchParams.set('requestId', requestId);
    url.searchParams.set('token', this.token);
    return url.toString();
  }

  private expireIfNeeded(requestId: SigningRequestId, entry: PendingIosApproval): void {
    if (entry.approval.status !== 'pending') {
      return;
    }
    if (Date.now() <= entry.createdAt + this.requestTtlMs) {
      return;
    }
    entry.approval = {
      requestId,
      status: 'expired',
      error: {
        code: 'expired',
        message: 'iOS wallet approval request expired.',
        recoverable: true,
      },
    };
    this.log('IosLinkBackend', 'expireIfNeeded', 'STEP_EXPIRED', 'info', 'request expired', {
      requestId,
      kind: entry.kind,
    });
  }

  private log(
    component: string,
    method: string,
    step: string,
    level: Exclude<IosLinkLogLevel, 'silent'>,
    message: string,
    metadata: Record<string, string> = {},
  ): void {
    if (!shouldLog(this.logLevel, level)) {
      return;
    }
    const suffix = Object.entries(metadata)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${quoteLogValue(value)}`)
      .join(' ');
    console.info(
      `[AgentIOS] [${component}] ${method} | ${step} phase=${level === 'error' ? 'FAIL' : 'INFO'} message="${message}"${suffix ? ` ${suffix}` : ''}`,
    );
  }
}

export function detectIosLinkEnvironment(userAgent = globalUserAgent()): IosLinkEnvironment {
  const globals = globalThis as { window?: unknown; document?: unknown };
  const isBrowser = globals.window !== undefined && globals.document !== undefined;
  const normalized = userAgent.toLowerCase();
  const isIos =
    normalized.includes('iphone') ||
    normalized.includes('ipad') ||
    normalized.includes('ipod') ||
    (normalized.includes('macintosh') && normalized.includes('mobile/'));
  const isSafari =
    normalized.includes('safari/') &&
    !normalized.includes('chrome/') &&
    !normalized.includes('crios/') &&
    !normalized.includes('fxios/') &&
    !normalized.includes('edgios/');

  return {
    isBrowser,
    isIos,
    isSafari,
    canAttemptIosLink: isBrowser && isIos,
    userAgent,
  };
}

export function iosLinkTransportPlan(): {
  transport: 'ios-link';
  status: 'experimental';
  reason: string;
  wallets: ReadonlyArray<IosLinkWalletDescriptor>;
} {
  return {
    transport: 'ios-link',
    status: 'experimental',
    reason:
      'iOS uses wallet-specific encrypted links for Phantom/Solflare/Backpack and WalletConnect/Reown QR approvals for Jupiter.',
    wallets: IOS_LINK_WALLETS,
  };
}

export function walletDescriptor(id: IosLinkWalletId): IosLinkWalletDescriptor | undefined {
  return IOS_LINK_WALLETS.find((wallet) => wallet.id === id);
}

export function buildConnectUrl(
  provider: IosLinkWalletDescriptor,
  params: {
    appUrl: string;
    cluster: Cluster;
    dappEncryptionPublicKey: string;
    redirectLink: string;
  },
): string {
  assertUniversalLinkProvider(provider);
  const url = providerUrl(provider, CONNECT_METHOD);
  url.searchParams.set('app_url', params.appUrl);
  url.searchParams.set('dapp_encryption_public_key', params.dappEncryptionPublicKey);
  url.searchParams.set('redirect_link', params.redirectLink);
  url.searchParams.set('cluster', params.cluster);
  return url.toString();
}

function encryptedUrlFromCipher(
  provider: IosLinkWalletDescriptor,
  method: string,
  params: {
    dappEncryptionPublicKey: string;
    redirectLink: string;
    nonce: Uint8Array;
    encrypted: Uint8Array;
  },
): string {
  const url = providerUrl(provider, method);
  url.searchParams.set('dapp_encryption_public_key', params.dappEncryptionPublicKey);
  url.searchParams.set('nonce', bs58.encode(params.nonce));
  url.searchParams.set('redirect_link', params.redirectLink);
  url.searchParams.set('payload', bs58.encode(params.encrypted));
  return url.toString();
}

function assertUniversalLinkProvider(provider: IosLinkWalletDescriptor): void {
  if (!provider.universalLinkHost) {
    throw new ProtocolError('unsupported_method', `${provider.name} does not expose encrypted iOS deeplinks.`);
  }
}

function providerUrl(provider: IosLinkWalletDescriptor, method: string): URL {
  assertUniversalLinkProvider(provider);
  return new URL(`https://${provider.universalLinkHost}/ul/v1/${method}`);
}

function paramsFromUrl(url: URL): URLSearchParams {
  const clean = url.toString().replace(/#$/, '');
  return new URL(clean).searchParams;
}

function walletErrorFromCallback(url: URL): ProtocolError | null {
  const code = url.searchParams.get('errorCode');
  if (!code) return null;
  const message = url.searchParams.get('errorMessage') ?? 'iOS wallet returned an error.';
  switch (code) {
    case 'USER_REJECTED':
      return new ProtocolError('user_rejected', message);
    case 'INVALID_SESSION':
      return new ProtocolError('unauthorized', message);
    case 'UNSUPPORTED_METHOD':
      return new ProtocolError('unsupported_method', message);
    case 'CLUSTER_MISMATCH':
      return new ProtocolError('cluster_mismatch', message);
    case 'WALLET_UNREACHABLE':
      return new ProtocolError('wallet_unreachable', message);
    default:
      return new ProtocolError('wallet_unreachable', `${message} (wallet code: ${code})`);
  }
}

function protocolErrorFromUnknown(err: unknown, fallbackMessage: string): ProtocolError {
  if (err instanceof ProtocolError) {
    return err;
  }
  if (err instanceof Error) {
    const message = err.message || fallbackMessage;
    const lower = message.toLowerCase();
    if (lower.includes('reject') || lower.includes('denied') || lower.includes('cancel')) {
      return new ProtocolError('user_rejected', message);
    }
    if (lower.includes('timeout') || lower.includes('expired')) {
      return new ProtocolError('expired', message);
    }
    return new ProtocolError('wallet_unreachable', message);
  }
  return new ProtocolError('wallet_unreachable', fallbackMessage);
}

function findWalletEncryptionKey(
  params: URLSearchParams,
  provider: IosLinkWalletDescriptor,
): { alias: string; value: string } | null {
  for (const alias of walletEncryptionKeyAliases(provider)) {
    const value = params.get(alias);
    if (value) {
      return { alias, value };
    }
  }
  return null;
}

function walletEncryptionKeyAliases(provider: IosLinkWalletDescriptor): ReadonlyArray<string> {
  const aliases = new Set<string>(provider.connectPublicKeyParams);
  for (const wallet of IOS_LINK_WALLETS) {
    if (wallet.transport !== 'encrypted-deeplink') {
      continue;
    }
    for (const alias of wallet.connectPublicKeyParams) {
      aliases.add(alias);
    }
  }
  aliases.add('wallet_encryption_public_key');
  return [...aliases];
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `iOS wallet response is missing ${field}.`);
  }
  return value;
}

function decodeBase58(value: string, label: string): Uint8Array {
  try {
    return bs58.decode(value);
  } catch {
    throw new ProtocolError('invalid_request', `Invalid base58 ${label}.`);
  }
}

function decodePayload(data: string, encoding: 'utf8' | 'base64'): Uint8Array {
  if (encoding === 'utf8') {
    return new TextEncoder().encode(data);
  }
  return new Uint8Array(Buffer.from(data, 'base64'));
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function defaultRpcUrl(cluster: Cluster): string {
  switch (cluster) {
    case 'mainnet-beta':
      return 'https://api.mainnet-beta.solana.com';
    case 'devnet':
      return 'https://api.devnet.solana.com';
    case 'testnet':
      return 'https://api.testnet.solana.com';
    case 'localnet':
      return 'http://127.0.0.1:8899';
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function urlShape(value: string): string {
  try {
    const url = new URL(value);
    return `scheme=${url.protocol.replace(':', '')} host=${url.host} path=${url.pathname} query_keys=${[...url.searchParams.keys()].sort().join(',')}`;
  } catch {
    return 'invalid_url';
  }
}

function queryKeys(url: URL): string {
  return [...url.searchParams.keys()].sort().join(',');
}

function short(value: string, prefix = 8, suffix = 8): string {
  if (value.length <= prefix + suffix) return value;
  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}

function quoteLogValue(value: string): string {
  if (!/[\s"'{}[\]]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function shouldLog(configured: IosLinkLogLevel, event: Exclude<IosLinkLogLevel, 'silent'>): boolean {
  const rank = { silent: 0, error: 1, info: 2, debug: 3 } as const;
  return rank[event] <= rank[configured];
}

function globalUserAgent(): string {
  const globals = globalThis as { navigator?: { userAgent?: string } };
  if (globals.navigator === undefined) {
    return '';
  }
  return globals.navigator.userAgent ?? '';
}

export function buildEncryptedUrl(
  provider: IosLinkWalletDescriptor,
  method: string,
  params: {
    dappEncryptionPublicKey: string;
    redirectLink: string;
    payload: Record<string, unknown>;
    session: IosSession & { walletEncryptionPublicKey: Uint8Array };
    secretKey: Uint8Array;
    nonce?: Uint8Array;
  },
): string {
  const nonce = params.nonce ?? nacl.randomBytes(nacl.box.nonceLength);
  const plaintext = new TextEncoder().encode(JSON.stringify(params.payload));
  const encrypted = nacl.box(plaintext, nonce, params.session.walletEncryptionPublicKey, params.secretKey);
  return encryptedUrlFromCipher(provider, method, {
    dappEncryptionPublicKey: params.dappEncryptionPublicKey,
    redirectLink: params.redirectLink,
    nonce,
    encrypted,
  });
}
