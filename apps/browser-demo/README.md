# Browser Demo

Polished Wallet Standard demo for the Solana Agent Wallet Adapter.

```sh
pnpm demo:browser
```

Open `http://127.0.0.1:5174`, discover installed Solana wallets, connect one account, and sign the demo message on devnet. The demo uses the same `WalletStandardWebBackend` and `SolanaSigningClient` that framework adapters use, so it is the quickest public proof that the agent request routes through the user's installed wallet.

## What it proves

- Wallet Standard discovery across Phantom, Solflare, Backpack, and compatible providers.
- Explicit wallet connection before signing.
- Message signing with no private key in app or agent state.
- Optional base64 transaction signing for deeper wallet tests.

