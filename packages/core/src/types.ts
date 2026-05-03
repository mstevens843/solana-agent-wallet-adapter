export type Cluster = 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';

export type SigningRequestId = string;

export type SigningKind =
  | 'sign_message'
  | 'sign_transaction'
  | 'sign_and_send_transaction';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'failed';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface SigningPayload {
  data: string;
  encoding: 'utf8' | 'base64';
}

export interface SimulationResult {
  err: unknown | null;
  logs: ReadonlyArray<string>;
  unitsConsumed?: number;
  preBalances?: ReadonlyArray<bigint>;
  postBalances?: ReadonlyArray<bigint>;
}

export interface SigningDisplayHints {
  summary?: string;
  riskLevel?: RiskLevel;
  simulation?: SimulationResult;
}

export interface SigningRequest {
  id: SigningRequestId;
  kind: SigningKind;
  payload: SigningPayload;
  cluster: Cluster;
  display?: SigningDisplayHints;
  expiresAt?: number;
}

export interface SigningResult {
  signature: string;
  txid?: string;
}

export interface AdapterCapabilities {
  backend: string;
  cluster: ReadonlyArray<Cluster>;
  supports: {
    signMessage: boolean;
    signTransaction: boolean;
    signAndSendTransaction: boolean;
    multiSign: boolean;
    simulationPreview: boolean;
  };
  address?: string;
}

export interface ApprovalResource {
  requestId: SigningRequestId;
  status: ApprovalStatus;
  result?: SigningResult;
  error?: ProtocolErrorPayload;
  approvalUri?: string;
}

export interface ProtocolErrorPayload {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
}

export type ErrorCode =
  | 'user_rejected'
  | 'user_no_response'
  | 'wallet_unreachable'
  | 'invalid_request'
  | 'simulation_failed'
  | 'cluster_mismatch'
  | 'expired'
  | 'unauthorized';
