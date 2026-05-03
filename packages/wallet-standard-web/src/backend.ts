import bs58 from 'bs58';

import {
  newSigningRequestId,
  ProtocolError,
  type AdapterCapabilities,
  type ApprovalResource,
  type Cluster,
  type SigningRequest,
  type SigningRequestId,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';

import {
  SolanaSignAndSendTransaction,
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignMessageFeature,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
} from '@wallet-standard/features';

import { type DiscoveredWallet } from './discovery.js';

export interface WalletStandardWebBackendOptions {
  wallet: Wallet | DiscoveredWallet;
  cluster: Cluster;
}

interface PendingApproval {
  approval: ApprovalResource;
  controller: AbortController;
}

export class WalletStandardWebBackend implements WalletBackend {
  private readonly wallet: Wallet;
  private readonly cluster: Cluster;
  private readonly chain: string;
  private readonly pending = new Map<SigningRequestId, PendingApproval>();
  private connectedAccount: WalletAccount | null = null;

  constructor(options: WalletStandardWebBackendOptions) {
    const wallet = isDiscovered(options.wallet) ? options.wallet.wallet : options.wallet;
    this.wallet = wallet;
    this.cluster = options.cluster;
    this.chain = clusterToChain(options.cluster);

    if (!wallet.chains.includes(this.chain as Wallet['chains'][number])) {
      throw new ProtocolError(
        'cluster_mismatch',
        `Wallet ${wallet.name} does not advertise support for chain ${this.chain}.`,
      );
    }
  }

  async capabilities(): Promise<AdapterCapabilities> {
    const features = this.wallet.features as Record<string, unknown>;
    const base: AdapterCapabilities = {
      backend: 'wallet-standard-web',
      cluster: [this.cluster],
      supports: {
        signMessage: Object.prototype.hasOwnProperty.call(features, SolanaSignMessage),
        signTransaction: Object.prototype.hasOwnProperty.call(features, SolanaSignTransaction),
        signAndSendTransaction: Object.prototype.hasOwnProperty.call(
          features,
          SolanaSignAndSendTransaction,
        ),
        multiSign: false,
        simulationPreview: false,
      },
    };
    if (this.connectedAccount) {
      return { ...base, address: this.connectedAccount.address };
    }
    return base;
  }

  async getAddress(): Promise<string> {
    const account = await this.ensureConnected();
    return account.address;
  }

  async submit(request: SigningRequest): Promise<ApprovalResource> {
    if (request.cluster !== this.cluster) {
      throw new ProtocolError(
        'cluster_mismatch',
        `Backend connected to ${this.cluster}; request targets ${request.cluster}.`,
      );
    }

    const account = await this.ensureConnected();
    const controller = new AbortController();
    const approval: ApprovalResource = {
      requestId: request.id,
      status: 'pending',
    };
    this.pending.set(request.id, { approval, controller });

    void this.execute(request, account, controller.signal)
      .then((resolved) => {
        const entry = this.pending.get(request.id);
        if (!entry) return;
        entry.approval = resolved;
      })
      .catch((err) => {
        const entry = this.pending.get(request.id);
        if (!entry) return;
        const protocolErr =
          err instanceof ProtocolError
            ? err
            : new ProtocolError(
                'wallet_unreachable',
                err instanceof Error ? err.message : 'Wallet rejected the request.',
              );
        entry.approval = {
          requestId: request.id,
          status: protocolErr.code === 'user_rejected' ? 'rejected' : 'failed',
          error: protocolErr.toPayload(),
        };
      });

    return approval;
  }

  async poll(requestId: SigningRequestId): Promise<ApprovalResource> {
    const entry = this.pending.get(requestId);
    if (!entry) {
      throw new ProtocolError('invalid_request', `Unknown request id: ${requestId}`);
    }
    return entry.approval;
  }

  async cancel(requestId: SigningRequestId): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    entry.controller.abort();
    entry.approval = {
      requestId,
      status: 'rejected',
      error: {
        code: 'user_rejected',
        message: 'Request cancelled by caller.',
        recoverable: false,
      },
    };
  }

  private async ensureConnected(): Promise<WalletAccount> {
    if (this.connectedAccount) {
      return this.connectedAccount;
    }
    const features = this.wallet.features as Record<string, unknown>;
    const connectFeature = features[StandardConnect] as StandardConnectFeature[typeof StandardConnect] | undefined;
    if (!connectFeature) {
      throw new ProtocolError(
        'unauthorized',
        `Wallet ${this.wallet.name} does not implement StandardConnect.`,
      );
    }
    const result = await connectFeature.connect();
    const account = result.accounts.find((candidate) =>
      candidate.chains.includes(this.chain as WalletAccount['chains'][number]),
    );
    if (!account) {
      throw new ProtocolError(
        'unauthorized',
        `No connected account on chain ${this.chain}. Switch wallet account to ${this.cluster}.`,
      );
    }
    this.connectedAccount = account;
    return account;
  }

  async disconnect(): Promise<void> {
    const features = this.wallet.features as Record<string, unknown>;
    const disconnectFeature = features[StandardDisconnect] as StandardDisconnectFeature[typeof StandardDisconnect] | undefined;
    if (disconnectFeature) {
      await disconnectFeature.disconnect();
    }
    this.connectedAccount = null;
  }

  private async execute(
    request: SigningRequest,
    account: WalletAccount,
    signal: AbortSignal,
  ): Promise<ApprovalResource> {
    if (signal.aborted) {
      throw new ProtocolError('user_rejected', 'Request aborted before execution.');
    }

    const features = this.wallet.features as Record<string, unknown>;

    switch (request.kind) {
      case 'sign_message': {
        const feature = features[SolanaSignMessage] as
          | SolanaSignMessageFeature[typeof SolanaSignMessage]
          | undefined;
        if (!feature) {
          throw new ProtocolError(
            'invalid_request',
            `Wallet ${this.wallet.name} does not support sign_message.`,
          );
        }
        const message = decodePayload(request.payload.data, request.payload.encoding);
        const [output] = await feature.signMessage({ account, message });
        if (!output) {
          throw new ProtocolError('wallet_unreachable', 'Wallet returned no signature.');
        }
        return {
          requestId: request.id,
          status: 'approved',
          result: { signature: bs58.encode(output.signature) },
        };
      }

      case 'sign_transaction': {
        const feature = features[SolanaSignTransaction] as
          | SolanaSignTransactionFeature[typeof SolanaSignTransaction]
          | undefined;
        if (!feature) {
          throw new ProtocolError(
            'invalid_request',
            `Wallet ${this.wallet.name} does not support sign_transaction.`,
          );
        }
        const transaction = decodePayload(request.payload.data, request.payload.encoding);
        const [output] = await feature.signTransaction({
          account,
          chain: this.chain as Parameters<typeof feature.signTransaction>[0]['chain'],
          transaction,
        });
        if (!output) {
          throw new ProtocolError('wallet_unreachable', 'Wallet returned no signed transaction.');
        }
        return {
          requestId: request.id,
          status: 'approved',
          result: { signature: encodeBase64(output.signedTransaction) },
        };
      }

      case 'sign_and_send_transaction': {
        const feature = features[SolanaSignAndSendTransaction] as
          | SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]
          | undefined;
        if (!feature) {
          throw new ProtocolError(
            'invalid_request',
            `Wallet ${this.wallet.name} does not support sign_and_send_transaction.`,
          );
        }
        const transaction = decodePayload(request.payload.data, request.payload.encoding);
        const [output] = await feature.signAndSendTransaction({
          account,
          chain: this.chain as Parameters<typeof feature.signAndSendTransaction>[0]['chain'],
          transaction,
        });
        if (!output) {
          throw new ProtocolError('wallet_unreachable', 'Wallet returned no signature.');
        }
        const signature = bs58.encode(output.signature);
        return {
          requestId: request.id,
          status: 'approved',
          result: { signature, txid: signature },
        };
      }

      default:
        throw new ProtocolError('invalid_request', `Unsupported signing kind: ${request.kind}`);
    }
  }
}

function isDiscovered(value: Wallet | DiscoveredWallet): value is DiscoveredWallet {
  return typeof value === 'object' && value !== null && 'wallet' in value;
}

function clusterToChain(cluster: Cluster): string {
  switch (cluster) {
    case 'mainnet-beta':
      return 'solana:mainnet';
    case 'testnet':
      return 'solana:testnet';
    case 'devnet':
      return 'solana:devnet';
    case 'localnet':
      return 'solana:localnet';
  }
}

function decodePayload(data: string, encoding: 'utf8' | 'base64'): Uint8Array {
  if (encoding === 'utf8') {
    return new TextEncoder().encode(data);
  }
  const buffer = Buffer.from(data, 'base64');
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// Used for newSigningRequestId import to avoid tree-shake removal warning.
void newSigningRequestId;
