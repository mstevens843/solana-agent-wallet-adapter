// Browser-side `WalletBackend` that routes all signing through the local
// Agentic bridge. Used by the Tauri desktop when the wallet itself lives
// in a separate browser tab (the wallet-host) that has registered with the
// bridge via `/bridge/connect`. Sibling of `packages/mcp-server/src/
// remoteBridgeBackend.ts` — same protocol, but uses the `x-agent-wallet-
// token` header for auth to match this app's `bridgeRequest()` style.
//
// DOM-free and Tauri-free; pure `fetch`. Tests in
// `__tests__/remoteBridgeBackend.test.ts` exercise it directly.

import {
  ProtocolError,
  type AdapterCapabilities,
  type ApprovalResource,
  type SigningRequest,
  type SigningRequestId,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';

export interface RemoteBridgeBackendOptions {
  /** Base URL of the local bridge — e.g. `http://127.0.0.1:8787`. */
  bridgeUrl: string;
  /** Bridge token printed by the bridge process / surfaced by the Tauri
   *  runtime. Authenticates every request via `x-agent-wallet-token`. */
  token: string;
  /** Called after the bridge accepts a signing request and marks it pending. */
  onPendingApproval?: (approval: ApprovalResource, request: SigningRequest) => void | Promise<void>;
}

export class RemoteBridgeBackend implements WalletBackend {
  private readonly bridgeUrl: string;
  private readonly token: string;
  private readonly onPendingApproval?: RemoteBridgeBackendOptions['onPendingApproval'];

  constructor(options: RemoteBridgeBackendOptions) {
    this.bridgeUrl = options.bridgeUrl.endsWith('/') ? options.bridgeUrl : `${options.bridgeUrl}/`;
    this.token = options.token;
    this.onPendingApproval = options.onPendingApproval;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return this.request<AdapterCapabilities>('/bridge/status');
  }

  async getAddress(): Promise<string> {
    const capabilities = await this.capabilities();
    if (!capabilities.address) {
      throw new ProtocolError(
        'unauthorized',
        'No browser wallet is connected to the local bridge. Open the wallet host in your browser, connect a wallet, then retry.',
      );
    }
    return capabilities.address;
  }

  async submit(request: SigningRequest): Promise<ApprovalResource> {
    const approval = await this.request<ApprovalResource>('/bridge/submit', {
      method: 'POST',
      body: JSON.stringify({ request }),
    });
    if (approval.status === 'pending') {
      try {
        await this.onPendingApproval?.(approval, request);
      } catch (err) {
        await this.cancel(approval.requestId).catch(() => undefined);
        throw err;
      }
    }
    return approval;
  }

  async poll(requestId: SigningRequestId): Promise<ApprovalResource> {
    return this.request<ApprovalResource>(
      `/bridge/poll?requestId=${encodeURIComponent(requestId)}`,
    );
  }

  async cancel(requestId: SigningRequestId): Promise<void> {
    await this.request('/bridge/cancel', {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    });
  }

  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const url = new URL(path.startsWith('/') ? path.slice(1) : path, this.bridgeUrl);
    const headers = new Headers(init?.headers);
    headers.set('x-agent-wallet-token', this.token);
    if (init?.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    let response: Response;
    try {
      response = await fetch(url, { ...init, headers });
    } catch (err) {
      throw new ProtocolError(
        'wallet_unreachable',
        `Local bridge unreachable at ${this.bridgeUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      const message = extractError(payload) ?? `Bridge returned ${response.status}.`;
      if (response.status === 401) {
        throw new ProtocolError('unauthorized', 'Bridge token rejected.');
      }
      throw new ProtocolError('wallet_unreachable', message);
    }
    return payload as T;
  }
}

function extractError(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.error === 'string') return obj.error;
    if (
      obj.error &&
      typeof obj.error === 'object' &&
      typeof (obj.error as Record<string, unknown>).message === 'string'
    ) {
      return (obj.error as { message: string }).message;
    }
    if (typeof obj.message === 'string') return obj.message;
  }
  return null;
}
