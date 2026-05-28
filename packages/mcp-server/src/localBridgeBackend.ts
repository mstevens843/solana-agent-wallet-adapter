import { randomBytes } from 'node:crypto';

import {
  ProtocolError,
  type AdapterCapabilities,
  type ApprovalResource,
  type Cluster,
  type ProtocolErrorPayload,
  type SigningRequest,
  type SigningRequestId,
  type SigningResult,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';

import { trace } from './trace.js';

interface BridgeRequest {
  request: SigningRequest;
  approval: ApprovalResource;
  createdAt: number;
  claimed: boolean;
}

export interface BridgeSigningResult {
  signature: string;
  txid?: string;
}

export interface LocalBridgeBackendOptions {
  cluster: Cluster;
  rpcUrl: string;
  token?: string;
  approvalBaseUrl?: string;
  requestTtlMs?: number;
}

export interface LocalBridgeConfig {
  cluster: Cluster;
  rpcUrl: string;
}

export class LocalBridgeBackend implements WalletBackend {
  readonly token: string;

  private readonly cluster: Cluster;
  private readonly rpcUrl: string;
  private readonly requestTtlMs: number;
  private approvalBaseUrl = '';
  private address: string | null = null;
  private hostCapabilities: AdapterCapabilities | null = null;
  private readonly pending = new Map<SigningRequestId, BridgeRequest>();

  constructor(options: LocalBridgeBackendOptions) {
    this.cluster = options.cluster;
    this.rpcUrl = options.rpcUrl;
    this.token = options.token ?? randomBytes(24).toString('base64url');
    this.approvalBaseUrl = options.approvalBaseUrl ?? '';
    this.requestTtlMs = options.requestTtlMs ?? 120000;
  }

  setApprovalBaseUrl(url: string): void {
    this.approvalBaseUrl = url;
  }

  getApprovalUrl(): string {
    if (!this.approvalBaseUrl) {
      return '';
    }
    const url = new URL(this.approvalBaseUrl);
    url.searchParams.set('token', this.token);
    return url.toString();
  }

  getConfig(): LocalBridgeConfig {
    return {
      cluster: this.cluster,
      rpcUrl: this.rpcUrl,
    };
  }

  connectHost(address: string, capabilities: AdapterCapabilities): void {
    this.address = address;
    this.hostCapabilities = { ...capabilities, address };
    trace('bridge.host.connected', {
      address,
      backend: capabilities.backend,
      cluster: capabilities.cluster,
      supports: capabilities.supports,
      walletName: capabilities.walletName,
      walletLogoId: capabilities.walletLogoId,
    });
  }

  disconnectHost(): void {
    trace('bridge.host.disconnected', { address: this.address });
    this.address = null;
    this.hostCapabilities = null;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return (
      this.hostCapabilities ?? {
        backend: 'local-browser-bridge',
        cluster: [this.cluster],
        supports: {
          signMessage: true,
          signTransaction: true,
          signAndSendTransaction: true,
          multiSign: false,
          simulationPreview: false,
        },
      }
    );
  }

  async getAddress(): Promise<string> {
    if (!this.address) {
      throw new ProtocolError(
        'unauthorized',
        `No browser wallet is connected. Open ${this.getApprovalUrl()} and connect a wallet first.`,
      );
    }
    return this.address;
  }

  async submit(request: SigningRequest): Promise<ApprovalResource> {
    if (request.cluster !== this.cluster) {
      throw new ProtocolError(
        'cluster_mismatch',
        `Bridge is configured for ${this.cluster}; request targets ${request.cluster}.`,
      );
    }
    if (!this.address) {
      throw new ProtocolError(
        'unauthorized',
        `No browser wallet is connected. Open ${this.getApprovalUrl()} and connect a wallet first.`,
      );
    }
    const approval: ApprovalResource = {
      requestId: request.id,
      status: 'pending',
      approvalUri: this.getApprovalUrl(),
    };
    this.pending.set(request.id, {
      request,
      approval,
      createdAt: Date.now(),
      claimed: false,
    });
    trace('bridge.request.submitted', {
      requestId: request.id,
      kind: request.kind,
      cluster: request.cluster,
      summary: request.display?.summary,
    });
    return approval;
  }

  async poll(requestId: SigningRequestId): Promise<ApprovalResource> {
    const entry = this.pending.get(requestId);
    if (!entry) {
      throw new ProtocolError('invalid_request', `Unknown request id: ${requestId}`);
    }
    this.expireIfNeeded(entry);
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
        message: 'Request cancelled by caller.',
        recoverable: false,
      },
    };
    trace('bridge.request.cancelled', { requestId });
  }

  nextPendingRequest(requestId?: SigningRequestId): SigningRequest | null {
    if (requestId) {
      const entry = this.pending.get(requestId);
      if (!entry) return null;
      this.expireIfNeeded(entry);
      if (entry.approval.status !== 'pending') return null;
      entry.claimed = true;
      trace('bridge.request.claimed', {
        requestId: entry.request.id,
        kind: entry.request.kind,
        cluster: entry.request.cluster,
        explicit: true,
      });
      return entry.request;
    }

    for (const entry of this.pending.values()) {
      this.expireIfNeeded(entry);
      if (entry.approval.status === 'pending' && !entry.claimed) {
        entry.claimed = true;
        trace('bridge.request.claimed', {
          requestId: entry.request.id,
          kind: entry.request.kind,
          cluster: entry.request.cluster,
        });
        return entry.request;
      }
    }
    return null;
  }

  resolveRequest(requestId: SigningRequestId, result: SigningResult): ApprovalResource {
    const entry = this.pending.get(requestId);
    if (!entry) {
      throw new ProtocolError('invalid_request', `Unknown request id: ${requestId}`);
    }
    entry.approval = {
      requestId,
      status: 'approved',
      result,
    };
    trace('bridge.request.resolved', {
      requestId,
      signature: result.signature,
      txid: result.txid,
    });
    return entry.approval;
  }

  rejectRequest(requestId: SigningRequestId, error: ProtocolErrorPayload): ApprovalResource {
    const entry = this.pending.get(requestId);
    if (!entry) {
      throw new ProtocolError('invalid_request', `Unknown request id: ${requestId}`);
    }
    entry.approval = {
      requestId,
      status: error.code === 'expired' ? 'expired' : error.code === 'user_rejected' ? 'rejected' : 'failed',
      error,
    };
    trace('bridge.request.rejected', {
      requestId,
      code: error.code,
      message: error.message,
    });
    return entry.approval;
  }

  private expireIfNeeded(entry: BridgeRequest): void {
    if (entry.approval.status !== 'pending') {
      return;
    }
    const expiresAt = entry.request.expiresAt ?? entry.createdAt + this.requestTtlMs;
    if (Date.now() <= expiresAt) {
      return;
    }
    entry.approval = {
      requestId: entry.request.id,
      status: 'expired',
      error: {
        code: 'expired',
        message: 'Wallet approval request expired.',
        recoverable: true,
      },
    };
    trace('bridge.request.expired', {
      requestId: entry.request.id,
      kind: entry.request.kind,
      claimed: entry.claimed,
    });
  }
}
