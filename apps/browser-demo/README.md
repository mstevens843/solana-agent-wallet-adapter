# Browser Demo

Polished Wallet Standard demo for the Solana Agent Wallet Adapter.

```sh
pnpm demo:browser
```

Open `http://127.0.0.1:5174`, discover installed Solana wallets, connect one account, and sign the demo message on devnet. The demo uses the same `WalletStandardWebBackend` and `SolanaSigningClient` that framework adapters use, so it is the quickest public proof that the agent request routes through the user's installed wallet.

The app has two tabs:

- `Agent Plan`: simulated agent request flow. It lets a user generate a plan and sign an off-chain approval proof with a real wallet. It does not build or execute a swap yet.
- `Wallet Flow`: real Wallet Standard flow. It discovers installed wallets, connects, signs a message, creates a devnet memo transaction, signs transaction bytes, and can sign plus broadcast on devnet.

## What it proves

- Wallet Standard discovery across Phantom, Solflare, Backpack, and compatible providers.
- Explicit wallet connection before signing.
- Message signing with no private key in app or agent state.
- Base64 transaction signing without broadcast.
- Sign-and-send transaction broadcast on devnet.
- Wallet switching across providers, for example Phantom approval on the Agent Plan tab and Backpack signing on the Wallet Flow tab.

## Recording flow

The current public demo recording shows:

1. Start on `Agent Plan`.
2. Discover wallets.
3. Select Phantom.
4. Generate a simulated agent plan.
5. Sign the agent approval with Phantom.
6. Switch to `Wallet Flow`.
7. Select Backpack.
8. Sign a message.
9. Create a demo devnet transaction.
10. Sign the transaction bytes without broadcasting.
11. Create another demo transaction.
12. Sign and send it on devnet.
