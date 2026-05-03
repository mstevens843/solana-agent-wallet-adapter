import type { WalletBackend } from './backend.js';
import { ProtocolError } from './errors.js';
import { newSigningRequestId } from './ids.js';
import type {
  AdapterCapabilities,
  ApprovalResource,
  Cluster,
  SimulationResult,
  SigningRequest,
  SigningResult,
} from './types.js';

export interface SolanaSigningClientOptions {
  backend: WalletBackend;
  /** Polling interval while an approval is in flight, in milliseconds. Default: 500. */
  pollIntervalMs?: number;
  /** Hard timeout per signing request, in milliseconds. Default: 120000 (2 minutes). */
  timeoutMs?: number;
}

export interface SignRequestOptions {
  cluster: Cluster;
  summary?: string;
  /** Override the default poll interval for this single request. */
  pollIntervalMs?: number;
  /** Override the default timeout for this single request. */
  timeoutMs?: number;
}

/**
 * Higher-level wrapper around `WalletBackend` that submits a signing request
 * and resolves only when the user has approved (or rejected, expired, failed).
 *
 * Intended for framework adapters (Vercel AI SDK, LangChain, etc.) that want
 * "give me the signed result" semantics rather than the lower-level
 * pending/poll lifecycle exposed by `WalletBackend`.
 */
export class SolanaSigningClient {
  private readonly backend: WalletBackend;
  private readonly defaultPollIntervalMs: number;
  private readonly defaultTimeoutMs: number;

  constructor(options: SolanaSigningClientOptions) {
    this.backend = options.backend;
    this.defaultPollIntervalMs = options.pollIntervalMs ?? 500;
    this.defaultTimeoutMs = options.timeoutMs ?? 120_000;
  }

  capabilities(): Promise<AdapterCapabilities> {
    return this.backend.capabilities();
  }

  getAddress(): Promise<string> {
    return this.backend.getAddress();
  }

  signMessage(message: string, options: SignRequestOptions): Promise<SigningResult> {
    return this.run({
      kind: 'sign_message',
      payload: { data: message, encoding: 'utf8' },
      ...options,
    });
  }

  signTransaction(transactionBase64: string, options: SignRequestOptions): Promise<SigningResult> {
    return this.run({
      kind: 'sign_transaction',
      payload: { data: transactionBase64, encoding: 'base64' },
      ...options,
    });
  }

  signAndSendTransaction(
    transactionBase64: string,
    options: SignRequestOptions,
  ): Promise<SigningResult> {
    return this.run({
      kind: 'sign_and_send_transaction',
      payload: { data: transactionBase64, encoding: 'base64' },
      ...options,
    });
  }

  async simulateTransaction(
    transactionBase64: string,
    options: Pick<SignRequestOptions, 'cluster' | 'summary'>,
  ): Promise<SimulationResult> {
    if (!this.backend.simulate) {
      throw new ProtocolError(
        'unsupported_method',
        'The configured wallet backend does not support transaction simulation.',
      );
    }
    const request = this.buildRequest({
      kind: 'sign_transaction',
      payload: { data: transactionBase64, encoding: 'base64' },
      ...options,
    });
    return this.backend.simulate(request);
  }

  cancel(requestId: string): Promise<void> {
    if (!this.backend.cancel) {
      return Promise.resolve();
    }
    return this.backend.cancel(requestId);
  }

  private async run(spec: {
    kind: SigningRequest['kind'];
    payload: SigningRequest['payload'];
    cluster: Cluster;
    summary?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }): Promise<SigningResult> {
    const request = this.buildRequest(spec);
    const initial = await this.backend.submit(request);
    const resolved = await this.waitForResolution(
      initial,
      spec.pollIntervalMs ?? this.defaultPollIntervalMs,
      spec.timeoutMs ?? this.defaultTimeoutMs,
    );

    if (resolved.status === 'approved') {
      if (!resolved.result) {
        throw new ProtocolError(
          'wallet_unreachable',
          `Backend approved request ${request.id} but returned no signing result.`,
        );
      }
      return resolved.result;
    }

    const errorPayload = resolved.error ?? {
      code: resolved.status === 'rejected' ? 'user_rejected' : 'wallet_unreachable',
      message: `Approval ${resolved.status} for request ${request.id}`,
      recoverable: false,
    };
    throw ProtocolError.fromPayload(errorPayload);
  }

  private buildRequest(spec: {
    kind: SigningRequest['kind'];
    payload: SigningRequest['payload'];
    cluster: Cluster;
    summary?: string;
  }): SigningRequest {
    const request: SigningRequest = {
      id: newSigningRequestId(),
      kind: spec.kind,
      payload: spec.payload,
      cluster: spec.cluster,
    };
    if (spec.summary !== undefined) {
      request.display = { summary: spec.summary };
    }
    return request;
  }

  private async waitForResolution(
    initial: ApprovalResource,
    pollIntervalMs: number,
    timeoutMs: number,
  ): Promise<ApprovalResource> {
    if (initial.status !== 'pending') {
      return initial;
    }

    const start = Date.now();
    let current = initial;
    while (current.status === 'pending') {
      if (Date.now() - start > timeoutMs) {
        if (this.backend.cancel) {
          await this.backend.cancel(current.requestId).catch(() => undefined);
        }
        throw new ProtocolError(
          'expired',
          `Approval request ${current.requestId} timed out after ${timeoutMs}ms.`,
        );
      }
      await sleep(pollIntervalMs);
      current = await this.backend.poll(current.requestId);
    }
    return current;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
