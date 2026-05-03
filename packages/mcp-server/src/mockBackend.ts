import {
  ProtocolError,
  type AdapterCapabilities,
  type ApprovalResource,
  type SigningRequest,
  type SigningRequestId,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';

const MOCK_ADDRESS = '11111111111111111111111111111111';

export function createMockBackend(): WalletBackend {
  const pending = new Map<SigningRequestId, ApprovalResource>();

  const capabilities: AdapterCapabilities = {
    backend: 'mock',
    cluster: ['devnet', 'localnet'],
    supports: {
      signMessage: true,
      signTransaction: true,
      signAndSendTransaction: true,
      multiSign: false,
      simulationPreview: false,
    },
    address: MOCK_ADDRESS,
  };

  return {
    async capabilities() {
      return capabilities;
    },
    async getAddress() {
      return MOCK_ADDRESS;
    },
    async submit(request: SigningRequest) {
      const approval: ApprovalResource = {
        requestId: request.id,
        status: 'pending',
        approvalUri: `mock://approve/${request.id}`,
      };
      pending.set(request.id, approval);
      return approval;
    },
    async poll(requestId: SigningRequestId) {
      const approval = pending.get(requestId);
      if (!approval) {
        throw new ProtocolError('invalid_request', `Unknown request id: ${requestId}`);
      }
      return approval;
    },
  };
}
