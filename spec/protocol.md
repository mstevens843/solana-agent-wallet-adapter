# Solana Agent Wallet Adapter Protocol (draft v0.1)

> **Status:** draft. Subject to breaking changes until v1.0.

## Goal

Define a transport-agnostic protocol for AI agents to request Solana wallet operations (signing, address lookup) from a user-controlled wallet, with explicit user approval. The protocol must work over:

- **MCP** (Model Context Protocol) — for Claude Desktop, Cursor, Anthropic Agents, any MCP client
- **Mobile WebView / native module** — for agents running on Android (real MWA) or iOS (deeplinks)
- **Browser** — for agents running in a tab (Wallet Standard)

The agent never sees the user's private key. Every signing operation surfaces an approval resource that the host environment renders to the user.

## Core types

```ts
// Identifies a unique signing request through its lifecycle.
type SigningRequestId = string;

interface SigningRequest {
  id: SigningRequestId;
  kind: 'sign_message' | 'sign_transaction' | 'sign_and_send_transaction';
  payload: {
    // For sign_message: utf-8 string to sign
    // For sign_*_transaction: base64 wire-format transaction
    data: string;
    encoding: 'utf8' | 'base64';
  };
  // Optional metadata the host can show the user before approval.
  display?: {
    summary?: string;        // "Swap 0.1 SOL for USDC"
    riskLevel?: 'low' | 'medium' | 'high';
    simulation?: SimulationResult;
  };
  // Cluster the agent expects to broadcast on (mainnet-beta, devnet, etc.).
  cluster: 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';
  expiresAt?: number;        // Unix ms; backend may reject after this.
}

interface SimulationResult {
  err: unknown | null;
  logs: string[];
  unitsConsumed?: number;
  // Pre/post token balance deltas, etc. Same shape as web3.js simulation.
  preBalances?: ReadonlyArray<bigint>;
  postBalances?: ReadonlyArray<bigint>;
}

// Returned to the agent immediately when a sign tool is called.
// The agent (or its host) polls or subscribes for resolution.
interface ApprovalResource {
  requestId: SigningRequestId;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'failed';
  // Populated once approved.
  result?: SigningResult;
  // Populated on rejection or failure.
  error?: ProtocolError;
  // Where the host can render UI to ask the user. Format depends on transport.
  approvalUri?: string;
}

interface SigningResult {
  // base64 signed transaction (for sign_*_transaction)
  // or base64 signature only (for sign_message and sign_and_send_transaction)
  signature: string;
  // For sign_and_send: tx hash on the cluster.
  txid?: string;
}

interface ProtocolError {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
}

type ErrorCode =
  | 'user_rejected'
  | 'user_no_response'
  | 'wallet_unreachable'
  | 'invalid_request'
  | 'simulation_failed'
  | 'cluster_mismatch'
  | 'expired'
  | 'unauthorized';

// What a backend (MWA / iOS deeplink / Wallet Standard) tells callers it supports.
interface AdapterCapabilities {
  backend: string;           // 'mwa-android' | 'ios-deeplink' | 'wallet-standard-web' | ...
  cluster: ReadonlyArray<SigningRequest['cluster']>;
  supports: {
    signMessage: boolean;
    signTransaction: boolean;
    signAndSendTransaction: boolean;
    multiSign: boolean;      // multiple txs in one approval
    simulationPreview: boolean;
  };
  // Public address we can sign with. May be empty until the user authorizes.
  address?: string;
}
```

## WalletBackend interface

Every transport plugs into the same backend interface:

```ts
interface WalletBackend {
  capabilities(): Promise<AdapterCapabilities>;
  getAddress(): Promise<string>;
  submit(request: SigningRequest): Promise<ApprovalResource>;
  poll(requestId: SigningRequestId): Promise<ApprovalResource>;
  // Optional cancel; not all backends support it.
  cancel?(requestId: SigningRequestId): Promise<void>;
}
```

The MCP server, the framework integrations, and the mobile bridge all consume this interface and remain agnostic to the wallet underneath.

## MCP tool surface

The MCP server exposes these tools (parameter shapes will be JSON-schema-validated):

- `solana_get_address` — returns the connected wallet address (no approval needed if already authorized).
- `solana_sign_message` — request a message signature. Returns an `ApprovalResource`.
- `solana_sign_transaction` — request a tx signature without broadcasting.
- `solana_sign_and_send_transaction` — sign and broadcast in one approval.
- `solana_simulate_transaction` — pre-flight simulation; no signature, no approval.
- `solana_check_approval` — poll the status of a pending approval.

Approval flow on Claude Desktop: when a sign tool is called, the MCP server returns the `ApprovalResource` with `status: 'pending'` and an `approvalUri` (an MCP resource URI). Claude Desktop renders the resource. The user clicks approve in the UI. The MCP server polls the underlying wallet, then returns the signed result on the next tool call (`solana_check_approval`) or pushes a notification if the transport supports it.

## Cluster safety

Every `SigningRequest` MUST declare its target cluster. Backends MUST reject mismatches. A backend connected to mainnet must not sign a request marked devnet, and vice versa.

## Open questions

- MCP resource shape for the approval UI — does Claude Desktop render JSON, markdown, or HTML resources best? Spike Phase 1 to settle.
- iOS deeplink fragmentation — Phantom, Solflare, Backpack each have a slightly different AES-GCM session pattern. Wrap behind one shape but keep wallet-id in `AdapterCapabilities`.
- Multi-tx signing — agents that batch (e.g. swap + LP add) want one approval for many txs. `supports.multiSign` flags it; payload shape TBD.
- Push vs poll — MCP today is request/response, no server push. Polling works but is chatty. Watch MCP spec for streaming resources.

See `~/.claude/plans/so-we-were-able-tidy-newell.md` for the broader plan.
