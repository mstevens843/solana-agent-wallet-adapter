import type {
  AdapterCapabilities,
  ApprovalResource,
  SimulationResult,
  SigningRequest,
  SigningRequestId,
} from './types.js';

export interface WalletBackend {
  capabilities(): Promise<AdapterCapabilities>;
  getAddress(): Promise<string>;
  submit(request: SigningRequest): Promise<ApprovalResource>;
  poll(requestId: SigningRequestId): Promise<ApprovalResource>;
  simulate?(request: SigningRequest): Promise<SimulationResult>;
  cancel?(requestId: SigningRequestId): Promise<void>;
}
