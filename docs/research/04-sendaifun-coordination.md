# 04 — Sendaifun / Solana Agent Kit coordination

Are sendaifun about to ship features that overlap this project, and what's the right way to engage them.

## Findings

### Solana Agent Kit v2 — current wallet backends

[Source](https://github.com/sendaifun/solana-agent-kit/blob/v2/packages/core/src/types/wallet.ts). The `BaseWallet` interface:

```typescript
export interface BaseWallet {
  readonly publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
  signAndSendTransaction?: <T extends Transaction | VersionedTransaction>(
    transaction: T,
    options?: SendOptions
  ) => Promise<{ signature: TransactionSignature }>;
  sendTransaction?: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<string>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}
```

Constructor: `new SolanaAgentKit(wallet: BaseWallet | EvmWallet, rpcUrl: string, apiKeys?: Record<string, string>)`

Backends in the wild today:
- **Privy** (multiple example starters) — embedded wallets, server-side signing, optional human confirmation via Privy's UI
- **Turnkey** — fine-grained policies / rules
- **Phantom** — browser hot-swap pattern
- **OWS (Open Wallet Standard) via `owsWallet()`** — encrypted vault
- **`KeypairWallet`** — local raw keypair (still present despite v2 security narrative; used by their own MCP)

**No MWA, no Wallet Standard, no user-approval-flow backend.** The MCP they ship (`solana-mcp`) auto-signs with `KeypairWallet` and an env-var private key.

### Recent activity

- Recent commits: protocol expansions (Lavarage spot margin, others). No wallet-layer work.
- `solana-mcp` last update: "feat: god mode" May 2025. Custodial-only.
- 14 open issues on solana-agent-kit; **none mention MWA, Wallet Standard, user-approval signing, or MCP signing bridges.** Issues focus on agent identity (AgentFolio), protocol integrations (SPL Governance, Nansen MCP), reputation (Observer Protocol).
- Twitter @sendaifun: no announcements about MWA / mobile / approval flows.

### Org-wide repos

- `solana-agent-kit` (TS protocol actions)
- `solana-agent-kit-py` (Python port)
- `solana-mcp` (custodial MCP server)
- `solana-mcp-cloudflare` (Cloudflare runtime variant)
- `solana-app-kit` (app template)
- `sonic-agent-kit` (different chain)
- `x402-mcp`, `devrel-mcp` (off-topic)

**No overlapping project in flight.**

## Verdict

**Overlap risk: LOW.** Sendaifun owns the **action execution layer** (swap, mint, transfer, stake — 50+ Solana actions). This project owns the **wallet adapter + user-approval layer**. Orthogonal scopes. Their MCP is custodial; ours is non-custodial — different products.

Their plugin system + active Discussions page are explicitly open to extensions. No hostility detected.

## Coordination plan

**Open a public GitHub issue on `sendaifun/solana-agent-kit`** with title:

> RFC: alternate `BaseWallet` backend for user-approval signing flows (MWA / Wallet Standard / MCP bridge)

Body should:
1. Introduce `solana-agent-wallet-adapter` and explain the gap (MCP user-approval signing, non-custodial).
2. Show that the project ships as a separate package implementing their existing `BaseWallet` interface — no changes required on their side.
3. Ask whether they'd be open to listing it as a recommended community backend alongside Privy / Turnkey / Phantom.
4. Offer to mirror the API style of their existing backend examples for consistency.

**Don't email or DM.** Public issue surfaces both their reaction and any community interest.

**Don't ship anything that requires changes on their side.** Build adapter packages that satisfy `BaseWallet` as-is.

## Concrete adapter shape

```typescript
// packages/solana-agent-kit/src/index.ts
import type { BaseWallet } from 'solana-agent-kit';
import type { WalletBackend } from '@solana-agent-wallet-adapter/core';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

export class AgentWalletAdapterBackend implements BaseWallet {
  readonly publicKey: PublicKey;

  constructor(private readonly backend: WalletBackend, address: string) {
    this.publicKey = new PublicKey(address);
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    // 1. Submit signing request to backend
    // 2. Poll until approval or rejection (or use subscription if backend supports it)
    // 3. Decode signed tx from response, return as same shape
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    // Loop signTransaction; or if backend.capabilities().supports.multiSign, batch in one approval
  }

  async signAndSendTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
    options?: SendOptions,
  ): Promise<{ signature: string }> {
    // Use backend's sign_and_send_transaction kind
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    // Submit signMessage request, poll, return signature bytes
  }
}

// Usage:
// const backend = new WalletStandardWebBackend(/* ... */);
// const wallet = new AgentWalletAdapterBackend(backend, await backend.getAddress());
// const agent = new SolanaAgentKit(wallet, rpcUrl, { /* api keys */ });
```

Plug-in compatible with their existing kit. No friction on their side.

## References

- [solana-agent-kit GitHub](https://github.com/sendaifun/solana-agent-kit)
- [BaseWallet types source](https://github.com/sendaifun/solana-agent-kit/blob/v2/packages/core/src/types/wallet.ts)
- [solana-mcp GitHub](https://github.com/sendaifun/solana-mcp)
- [Sendai docs v2](https://docs.sendai.fun/docs/v2/introduction)
- [@sendaifun on X](https://x.com/sendaifun)
