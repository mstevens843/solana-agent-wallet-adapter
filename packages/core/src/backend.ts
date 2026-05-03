import type {
  AdapterCapabilities,
  ApprovalResource,
  SigningRequest,
  SigningRequestId,
} from './types.js';

export interface WalletBackend {
  capabilities(): Promise<AdapterCapabilities>;
  getAddress(): Promise<string>;
  submit(request: SigningRequest): Promise<ApprovalResource>;
  poll(requestId: SigningRequestId): Promise<ApprovalResource>;
  cancel?(requestId: SigningRequestId): Promise<void>;
}
