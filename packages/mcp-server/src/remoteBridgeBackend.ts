import {
  ProtocolError,
  type AdapterCapabilities,
  type ApprovalResource,
  type ProtocolErrorPayload,
  type SigningRequest,
  type SigningRequestId,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';

export interface RemoteBridgeBackendOptions {
  bridgeUrl: string;
  token: string;
}

export class RemoteBridgeBackend implements WalletBackend {
  private readonly bridgeUrl: string;
  private readonly token: string;

  constructor(options: RemoteBridgeBackendOptions) {
    this.bridgeUrl = options.bridgeUrl.endsWith('/') ? options.bridgeUrl : `${options.bridgeUrl}/`;
    this.token = options.token;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return this.request<AdapterCapabilities>('/bridge/status');
  }

  async getAddress(): Promise<string> {
    const capabilities = await this.capabilities();
    if (!capabilities.address) {
      throw new ProtocolError(
        'unauthorized',
        'No browser wallet is connected to the local bridge. Open the browser demo, connect a wallet, and connect to local bridge.',
      );
    }
    return capabilities.address;
  }

  async connectWallet(): Promise<ApprovalResource> {
    return this.request<ApprovalResource>('/bridge/connect-wallet', {
      method: 'POST',
      body: '{}',
    });
  }

  async submit(request: SigningRequest): Promise<ApprovalResource> {
    return this.request<ApprovalResource>('/bridge/submit', {
      method: 'POST',
      body: JSON.stringify({ request }),
    });
  }

  async poll(requestId: SigningRequestId): Promise<ApprovalResource> {
    return this.request<ApprovalResource>(`/bridge/poll?requestId=${encodeURIComponent(requestId)}`);
  }

  async cancel(requestId: SigningRequestId): Promise<void> {
    await this.request('/bridge/cancel', {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    });
  }

  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const url = new URL(path.startsWith('/') ? path.slice(1) : path, this.bridgeUrl);
    url.searchParams.set('token', this.token);

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...(init?.body !== undefined && { 'content-type': 'application/json' }),
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      throw new ProtocolError(
        'wallet_unreachable',
        `Local wallet bridge is not reachable at ${this.bridgeUrl}. Start solana-agent-wallet-bridge first.`,
        { cause: err },
      );
    }

    const body = (await response.json().catch(() => ({}))) as
      | T
      | { error?: ProtocolErrorPayload | string };
    if (!response.ok) {
      const error = typeof body === 'object' && body && 'error' in body ? body.error : undefined;
      if (typeof error === 'object' && error && 'code' in error) {
        throw ProtocolError.fromPayload(error);
      }
      throw new ProtocolError(
        response.status === 401 ? 'unauthorized' : 'wallet_unreachable',
        typeof error === 'string'
          ? error
          : `Local wallet bridge returned HTTP ${response.status}.`,
      );
    }
    return body as T;
  }
}
