# @solana-agent-wallet-adapter/solana-agent-kit

[Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) `BaseWallet` adapter for the Solana Agent Wallet Adapter. Plugs user-approval signing into `SolanaAgentKit` alongside their built-in Privy / Turnkey / Phantom backends, with no key custody.

```ts
import { SolanaAgentKit } from 'solana-agent-kit';
import { WalletStandardWebBackend, requireWallet } from '@solana-agent-wallet-adapter/wallet-standard-web';
import { AgentWalletAdapterBackend } from '@solana-agent-wallet-adapter/solana-agent-kit';

const backend = new WalletStandardWebBackend({
  wallet: requireWallet('Phantom'),
  cluster: 'devnet',
});

const wallet = await AgentWalletAdapterBackend.create({
  backend,
  cluster: 'devnet',
});

const agent = new SolanaAgentKit(wallet, 'https://api.devnet.solana.com', {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
});

// every action that calls signTransaction / signMessage now pops the user's wallet popup
const swapResult = await agent.trade(
  /* output mint */ new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  /* amount */ 0.01,
);
```

## What it does

Implements `BaseWallet` from `solana-agent-kit` over a `WalletBackend` from `@solana-agent-wallet-adapter/core`. Every signing call submits a request to the wallet backend (browser Wallet Standard / Android MWA / iOS deeplinks / mock), polls for resolution, and returns the signed result. The agent never holds a key.

## Why a non-custodial adapter

`SolanaAgentKit` ships excellent embedded-wallet backends (Privy, Turnkey, Phantom hot-swap). They're great for one-tap onboarding and managed-key flows. They're the wrong choice when the user already owns Phantom, Solflare, or Backpack and wants their agent to use that same wallet via approval prompts.

This adapter fills that gap. Pair it with embedded options:

- `Privy` / `Turnkey` if your users want managed onboarding
- This adapter if your users want their existing wallet, no custody, manual approval per action

## Multi-instruction sign behavior

`signAllTransactions` loops `signTransaction` sequentially. Each transaction surfaces its own approval popup. If the underlying backend declares `supports.multiSign: true` in its `capabilities()` (currently none do; planned for the Android MWA backend), this adapter can be extended to batch them in one approval.

## Status

Phase 1: builds clean; smoke-tested against the type contract. End-to-end runtime smoke (browser → Phantom → SolanaAgentKit `trade()`) pending. The tool surface in `SolanaAgentKit` is large; expect to fix edge cases as you exercise more actions.
