import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import QRCode from 'qrcode';
import SignClient from '@walletconnect/sign-client';
import bs58 from 'bs58';

import { ProtocolError, type Cluster, type SigningRequest } from '@solana-agent-wallet-adapter/core';

export type JupiterWalletConnectLogLevel = 'silent' | 'error' | 'info' | 'debug';

export interface JupiterWalletConnectSession {
  topic: string;
  address: string;
}

export interface JupiterWalletConnectPairing {
  uri: string;
  approval: () => Promise<JupiterWalletConnectSession>;
}

export interface JupiterWalletConnectClient {
  connect(params: {
    requiredNamespaces: Record<string, {
      chains: string[];
      methods: string[];
      events: string[];
    }>;
  }): Promise<{
    uri?: string;
    approval: () => Promise<WalletConnectSessionStruct>;
  }>;
  request<T>(params: {
    topic: string;
    chainId: string;
    request: {
      method: string;
      params: unknown;
    };
    expiry?: number;
  }): Promise<T>;
  disconnect?(params: { topic: string; reason: { code: number; message: string } }): Promise<void>;
  on?(event: 'session_delete' | 'session_expire', listener: (args: { topic: string }) => void): unknown;
  session?: {
    getAll(filter?: Partial<WalletConnectSessionStruct>): WalletConnectSessionStruct[];
  };
}

export interface JupiterWalletConnectOptions {
  projectId?: string;
  storageDir?: string;
  appUrl: string;
  appName?: string;
  appDescription?: string;
  appIcon?: string;
  cluster: Cluster;
  requestTtlMs: number;
  log: JupiterWalletConnectLogger;
  clientFactory?: JupiterWalletConnectClientFactory;
  qrCodeFactory?: JupiterQrCodeFactory;
}

export type JupiterWalletConnectClientFactory = (
  options: Required<Pick<JupiterWalletConnectOptions, 'projectId'>> &
    Pick<JupiterWalletConnectOptions, 'storageDir' | 'appUrl' | 'appName' | 'appDescription' | 'appIcon'>,
) => Promise<JupiterWalletConnectClient>;

export type JupiterQrCodeFactory = (uri: string) => Promise<string>;

export type JupiterWalletConnectLogger = (
  component: string,
  method: string,
  step: string,
  level: Exclude<JupiterWalletConnectLogLevel, 'silent'>,
  message: string,
  metadata?: Record<string, string>,
) => void;

interface WalletConnectSessionStruct {
  topic: string;
  namespaces: Record<string, { accounts: string[]; methods?: string[]; events?: string[] }>;
}

export interface JupiterWalletConnectRequestResult {
  signature?: string;
  transaction?: string;
}

const SOLANA_NAMESPACE = 'solana';
const SOLANA_METHODS = ['solana_signMessage', 'solana_signTransaction', 'solana_signAndSendTransaction'];

export class JupiterWalletConnect {
  private readonly projectId?: string;
  private readonly storageDir?: string;
  private readonly appUrl: string;
  private readonly appName: string;
  private readonly appDescription: string;
  private readonly appIcon?: string;
  private readonly cluster: Cluster;
  private readonly requestTtlMs: number;
  private readonly log: JupiterWalletConnectLogger;
  private readonly clientFactory: JupiterWalletConnectClientFactory;
  private readonly qrCodeFactory: JupiterQrCodeFactory;
  private client: JupiterWalletConnectClient | null = null;
  private session: JupiterWalletConnectSession | null = null;

  constructor(options: JupiterWalletConnectOptions) {
    this.projectId = options.projectId;
    this.storageDir = options.storageDir;
    this.appUrl = options.appUrl;
    this.appName = options.appName ?? 'Solana Agent Wallet Adapter';
    this.appDescription = options.appDescription ?? 'Non-custodial Solana agent approvals';
    this.appIcon = options.appIcon;
    this.cluster = options.cluster;
    this.requestTtlMs = options.requestTtlMs;
    this.log = options.log;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.qrCodeFactory = options.qrCodeFactory ?? defaultQrCodeFactory;
    this.log('JupiterWalletConnect', 'constructor', 'STEP_1_READY', 'info', 'backend initialized', {
      cluster: this.cluster,
      chainId: this.chainId(),
      hasProjectId: String(Boolean(this.projectId)),
    });
  }

  currentSession(): JupiterWalletConnectSession | null {
    return this.session;
  }

  async connect(): Promise<JupiterWalletConnectPairing> {
    const existing = await this.findExistingSession();
    if (existing) {
      this.session = existing;
      this.log('JupiterWalletConnect', 'connect', 'STEP_1_EXISTING_SESSION', 'info', 'existing session reused', {
        topic: short(existing.topic),
        address: short(existing.address),
      });
      return {
        uri: '',
        approval: async () => existing,
      };
    }

    const client = await this.getClient('connect');
    const chainId = this.chainId();
    this.log('JupiterWalletConnect', 'connect', 'STEP_1_CLIENT_INIT', 'info', 'client ready', {
      chainId,
    });
    const pairing = await client.connect({
      requiredNamespaces: {
        [SOLANA_NAMESPACE]: {
          chains: [chainId],
          methods: SOLANA_METHODS,
          events: [],
        },
      },
    });
    if (!pairing.uri) {
      throw new ProtocolError('wallet_unreachable', 'WalletConnect did not return a pairing URI.');
    }
    this.log('JupiterWalletConnect', 'connect', 'STEP_2_PAIRING_CREATED', 'info', 'pairing URI created', {
      uriBytes: String(pairing.uri.length),
    });
    return {
      uri: pairing.uri,
      approval: async () => {
        const session = normalizeSession(await pairing.approval(), chainId);
        this.session = session;
        this.log('JupiterWalletConnect', 'connect', 'STEP_3_SESSION_APPROVED', 'info', 'session approved', {
          topic: short(session.topic),
          address: short(session.address),
        });
        return session;
      },
    };
  }

  async requestSigning(request: SigningRequest): Promise<JupiterWalletConnectRequestResult> {
    const session = await this.requireSession();
    const client = await this.getClient('submit');
    const method = walletConnectMethod(request.kind);
    const params = walletConnectParams(request, session.address);
    this.log('JupiterWalletConnect', 'submit', 'STEP_1_SESSION_CHECK', 'info', 'session ready', {
      requestId: request.id,
      method,
      topic: short(session.topic),
      address: short(session.address),
    });
    this.log('JupiterWalletConnect', 'submit', 'STEP_2_REQUEST_SENT', 'info', 'request sent', {
      requestId: request.id,
      method,
      payloadKeys: Object.keys(params).sort().join(','),
    });
    const result = await client.request<unknown>({
      topic: session.topic,
      chainId: this.chainId(),
      request: { method, params },
      expiry: Math.floor(Date.now() / 1000) + Math.ceil(this.requestTtlMs / 1000),
    });
    const normalized = normalizeRequestResult(result);
    this.log('JupiterWalletConnect', 'submit', 'STEP_3_RESULT_RECEIVED', 'info', 'request resolved', {
      requestId: request.id,
      method,
      resultKeys: Object.keys(normalized).sort().join(','),
    });
    return normalized;
  }

  async qrDataUrl(uri: string): Promise<string> {
    return this.qrCodeFactory(uri);
  }

  async disconnect(): Promise<void> {
    if (!this.session || !this.client?.disconnect) {
      this.session = null;
      return;
    }
    await this.client.disconnect({
      topic: this.session.topic,
      reason: { code: 6000, message: 'Solana Agent Wallet Adapter disconnected.' },
    });
    this.session = null;
  }

  private async requireSession(): Promise<JupiterWalletConnectSession> {
    if (this.session) {
      return this.session;
    }
    const existing = await this.findExistingSession();
    if (existing) {
      this.session = existing;
      return existing;
    }
    this.log('JupiterWalletConnect', 'submit', 'STEP_FAIL', 'error', 'signing requested before session connect', {
      chainId: this.chainId(),
    });
    throw new ProtocolError(
      'unauthorized',
      'No Jupiter WalletConnect session is connected. Call solana_connect_wallet and scan the QR code first.',
    );
  }

  private async findExistingSession(): Promise<JupiterWalletConnectSession | null> {
    const client = await this.getClient('getSession');
    const sessions = client.session?.getAll() ?? [];
    for (const session of sessions) {
      const normalized = normalizeSessionOrNull(session, this.chainId());
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  private async getClient(method: string): Promise<JupiterWalletConnectClient> {
    if (this.client) {
      return this.client;
    }
    if (!this.projectId) {
      this.log('JupiterWalletConnect', method, 'STEP_FAIL', 'error', 'missing Reown project id');
      throw new ProtocolError(
        'invalid_request',
        'Jupiter WalletConnect requires a Reown project id. Set REOWN_PROJECT_ID or pass --reown-project-id.',
      );
    }
    this.client = await this.clientFactory({
      projectId: this.projectId,
      storageDir: this.storageDir,
      appUrl: this.appUrl,
      appName: this.appName,
      appDescription: this.appDescription,
      appIcon: this.appIcon,
    });
    this.client.on?.('session_delete', ({ topic }) => {
      if (this.session?.topic === topic) {
        this.session = null;
      }
    });
    this.client.on?.('session_expire', ({ topic }) => {
      if (this.session?.topic === topic) {
        this.session = null;
      }
    });
    return this.client;
  }

  private chainId(): string {
    return solanaWalletConnectChainId(this.cluster);
  }
}

export function solanaWalletConnectChainId(cluster: Cluster): string {
  switch (cluster) {
    case 'mainnet-beta':
      return 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
    case 'devnet':
      return 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
    case 'testnet':
      return 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z';
    case 'localnet':
      return 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  }
}

function walletConnectMethod(kind: SigningRequest['kind']): string {
  switch (kind) {
    case 'sign_message':
      return 'solana_signMessage';
    case 'sign_transaction':
      return 'solana_signTransaction';
    case 'sign_and_send_transaction':
      return 'solana_signAndSendTransaction';
  }
}

function walletConnectParams(request: SigningRequest, pubkey: string): Record<string, unknown> {
  switch (request.kind) {
    case 'sign_message':
      return {
        pubkey,
        message: bs58.encode(decodePayload(request.payload.data, request.payload.encoding)),
      };
    case 'sign_transaction':
      return {
        transaction: encodeBase64(decodePayload(request.payload.data, request.payload.encoding)),
      };
    case 'sign_and_send_transaction':
      return {
        transaction: encodeBase64(decodePayload(request.payload.data, request.payload.encoding)),
        sendOptions: {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        },
      };
  }
}

function normalizeRequestResult(result: unknown): JupiterWalletConnectRequestResult {
  if (typeof result === 'string') {
    return { signature: result };
  }
  if (!result || typeof result !== 'object') {
    throw new ProtocolError('wallet_unreachable', 'Jupiter WalletConnect returned an empty signing result.');
  }
  const record = result as Record<string, unknown>;
  const signature = typeof record.signature === 'string' ? record.signature : undefined;
  const transaction = typeof record.transaction === 'string' ? record.transaction : undefined;
  if (!signature && !transaction) {
    throw new ProtocolError('wallet_unreachable', 'Jupiter WalletConnect result is missing signature or transaction.');
  }
  return {
    ...(signature !== undefined && { signature }),
    ...(transaction !== undefined && { transaction }),
  };
}

function normalizeSession(session: WalletConnectSessionStruct, chainId: string): JupiterWalletConnectSession {
  const normalized = normalizeSessionOrNull(session, chainId);
  if (!normalized) {
    throw new ProtocolError('wallet_unreachable', 'Jupiter did not approve a Solana account for this cluster.');
  }
  return normalized;
}

function normalizeSessionOrNull(
  session: WalletConnectSessionStruct,
  chainId: string,
): JupiterWalletConnectSession | null {
  const accounts = session.namespaces[SOLANA_NAMESPACE]?.accounts ?? [];
  const account = accounts.find((value) => value.startsWith(`${chainId}:`));
  if (!account) {
    return null;
  }
  const address = account.split(':').at(-1);
  if (!address) {
    return null;
  }
  return { topic: session.topic, address };
}

async function defaultClientFactory(
  options: Required<Pick<JupiterWalletConnectOptions, 'projectId'>> &
    Pick<JupiterWalletConnectOptions, 'storageDir' | 'appUrl' | 'appName' | 'appDescription' | 'appIcon'>,
): Promise<JupiterWalletConnectClient> {
  const metadata = {
    name: options.appName ?? 'Solana Agent Wallet Adapter',
    description: options.appDescription ?? 'Non-custodial Solana agent approvals',
    url: options.appUrl,
    icons: options.appIcon ? [options.appIcon] : [],
  };
  const storageOptions = options.storageDir
    ? { database: ensureWalletConnectStorage(options.storageDir) }
    : undefined;
  return SignClient.init({
    projectId: options.projectId,
    metadata,
    ...(storageOptions !== undefined && { storageOptions }),
  }) as Promise<JupiterWalletConnectClient>;
}

function ensureWalletConnectStorage(storageDir: string): string {
  mkdirSync(storageDir, { recursive: true });
  return join(storageDir, 'walletconnect.db');
}

async function defaultQrCodeFactory(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
  });
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

function short(value: string, prefix = 8, suffix = 8): string {
  if (value.length <= prefix + suffix) return value;
  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}
