# @solana-agent-wallet-adapter/vercel-ai

[Vercel AI SDK](https://ai-sdk.dev/) tools for the Solana Agent Wallet Adapter. Use this package when a Vercel AI agent should request Solana signatures through the user's actual wallet instead of holding a private key or embedded wallet session.

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { SolanaSigningClient } from '@solana-agent-wallet-adapter/core';
import { WalletStandardWebBackend, requireWallet } from '@solana-agent-wallet-adapter/wallet-standard-web';
import { createSolanaTools } from '@solana-agent-wallet-adapter/vercel-ai';

const backend = new WalletStandardWebBackend({
  wallet: requireWallet('Phantom'),
  cluster: 'devnet',
});

const client = new SolanaSigningClient({ backend });
const tools = createSolanaTools({ client });

const result = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'Sign the message "hello solana" on devnet using my wallet.',
});
```

## Tools shipped

- `solanaGetAddress` - returns the connected wallet's address. Synchronous, no wallet popup.
- `solanaSignMessage` - signs a UTF-8 message. Blocks until the wallet approves.
- `solanaSignTransaction` - signs a base64 transaction without broadcasting. Blocks until the wallet approves.
- `solanaSignAndSendTransaction` - signs and broadcasts. Blocks until the wallet approves.

The user-approval step is enforced by `SolanaSigningClient`. Every signing tool's `execute()` returns only after the wallet approval resolves or fails. There is no agent-side flag that can skip wallet approval.

See [`docs/research/05-framework-signer-shapes.md`](../../docs/research/05-framework-signer-shapes.md) for the cross-framework rationale and planned adapter shapes.

## Status

Builds clean against `ai@^5`. Browser Wallet Standard smoke passed with Backpack through the underlying signing client. A real model-call smoke remains a release-gate follow-up.
