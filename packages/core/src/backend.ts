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
  /**
   * Drop any cached signing session / browser-wallet authorization so the
   * next `getAddress`/`submit` re-prompts the user. Optional — adapters
   * without a notion of "active session" (e.g. embedded software wallets
   * that re-derive on every call) skip this.
   */
  disconnect?(): Promise<void>;
}
