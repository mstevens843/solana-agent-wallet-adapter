# Solana Agent Wallet Adapter Protocol (draft v0.2)

> **Status:** draft. Subject to breaking changes until v1.0.

## Changelog

- v0.2, 2026-05-03: added optional backend simulation, added `unsupported_method`, and made MCP SEP-1036 URL elicitation the preferred approval UX when a client supports it.
- v0.1: initial transport-agnostic signing request, approval resource, and wallet backend shape.

## Goal

Define a transport-agnostic protocol for AI agents to request Solana wallet operations from a user-controlled wallet with explicit user approval. The agent never sees the user's private key. Every signing operation routes through a `WalletBackend` that can be backed by Wallet Standard in the browser, Android MWA, iOS deeplinks, or a mock backend for local smoke tests.

The public product promise is real-wallet signing for agents: the user signs with the wallet they already trust, not a custodial env-var key and not a vendor-created embedded agent wallet.

## Core Types

```ts
type SigningRequestId = string;

interface SigningRequest {
  id: SigningRequestId;
  kind: 'sign_message' | 'sign_transaction' | 'sign_and_send_transaction';
  payload: {
    data: string;
    encoding: 'utf8' | 'base64';
  };
  cluster: 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';
  display?: {
    summary?: string;
    riskLevel?: 'low' | 'medium' | 'high';
    simulation?: SimulationResult;
  };
  expiresAt?: number;
}

interface SimulationResult {
  err: unknown | null;
  logs: string[];
  unitsConsumed?: number;
  preBalances?: ReadonlyArray<bigint>;
  postBalances?: ReadonlyArray<bigint>;
}

interface ApprovalResource {
  requestId: SigningRequestId;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'failed';
  result?: SigningResult;
  error?: ProtocolError;
  approvalUri?: string;
}

interface SigningResult {
  signature: string;
  txid?: string;
}

type ErrorCode =
  | 'user_rejected'
  | 'user_no_response'
  | 'wallet_unreachable'
  | 'invalid_request'
  | 'unsupported_method'
  | 'simulation_failed'
  | 'cluster_mismatch'
  | 'expired'
  | 'unauthorized';
```

## WalletBackend

```ts
interface WalletBackend {
  capabilities(): Promise<AdapterCapabilities>;
  getAddress(): Promise<string>;
  submit(request: SigningRequest): Promise<ApprovalResource>;
  poll(requestId: SigningRequestId): Promise<ApprovalResource>;
  simulate?(request: SigningRequest): Promise<SimulationResult>;
  cancel?(requestId: SigningRequestId): Promise<void>;
}
```

`simulate` is optional because Wallet Standard does not define a generic simulation feature. Backends that do not implement it should surface `unsupported_method`, not pretend simulation succeeded.

## MCP Tool Surface

The MCP server exposes:

- `solana_get_address`
- `solana_sign_message`
- `solana_sign_transaction`
- `solana_sign_and_send_transaction`
- `solana_simulate_transaction`
- `solana_check_approval`

The default compatibility flow remains pending plus poll: signing tools return an `ApprovalResource`, then the client or agent calls `solana_check_approval` until the approval resolves.

For clients that advertise URL elicitation support, the preferred UX is MCP SEP-1036 URL Mode Elicitation. The server should direct the user to `approvalUri` with `mode: "url"` and keep `solana_check_approval` as the compatibility path. This aligns wallet approval with MCP's secure out-of-band pattern for sensitive flows and payments.

## Safety Rules

- Every `SigningRequest` must declare its target cluster.
- Backends must reject cluster mismatches.
- Signing requests must not expose private keys, seed phrases, session keys, or wallet auth tokens to the agent.
- Simulation is advisory. It must not replace wallet approval.
- `sign_and_send_transaction` must return an on-chain `txid` when available.

## Open Questions

- Multi-transaction approvals: keep `supports.multiSign` as a capability until the payload shape is specified.
- iOS deeplink response normalization: Phantom, Solflare, and Backpack session formats still need a shared adapter shape.
- Resource subscription push: Streamable HTTP can add resource update notifications later, but polling remains the compatibility baseline.
