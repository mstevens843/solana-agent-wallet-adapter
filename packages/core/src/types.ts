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
  // For wallets that don't implement MWA sign_messages (Phantom + Solflare today),
  // the Android backend substitutes a memo-only legacy transaction containing the
  // proof bytes and signs THAT instead. The signed transaction is never broadcast.
  // When this fallback path runs:
  //   encoding === 'transaction_memo'
  //   transactionBase64 contains the full signed transaction so the server can
  //   ed25519-verify the signature against the transaction message bytes and assert
  //   the memo data matches the expected proof payload.
  // For the default sign-message / sign-transaction / sign-and-send paths the
  // backend omits both fields (or sets encoding to 'utf8') and existing verifiers
  // continue to work unchanged.
  encoding?: 'utf8' | 'transaction_memo';
  transactionBase64?: string;
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
  /** Display-only wallet provider label, for bridged hosts where signing runs elsewhere. */
  walletName?: string;
  /** Display-only app-specific logo id, when the host can map the provider to a bundled logo. */
  walletLogoId?: string;
  /** Display-only Wallet Standard icon URL/data URI for providers without a bundled logo. */
  walletIcon?: string;
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
  | 'unsupported_method'
  | 'simulation_failed'
  | 'cluster_mismatch'
  | 'expired'
  | 'unauthorized';
