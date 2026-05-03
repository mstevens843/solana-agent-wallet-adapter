# @solana-agent-wallet-adapter/vercel-ai

[Vercel AI SDK](https://ai-sdk.dev/) tools for the Solana Agent Wallet Adapter. Lets a Vercel AI agent sign Solana transactions through the user's actual wallet while the signing client waits for the wallet approval result.

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

The user-approval step is enforced by `SolanaSigningClient` itself - every signing tool's `execute()` only returns once the wallet's popup resolves with the user's decision. There's no agent-side flag to skip approval. AI SDK v5 removed the `needsApproval` flag from `tool()` (it's part of the `prepareStep` flow in v5); approval enforcement at the wallet boundary stays correct regardless of how the agent runtime handles its own confirmation hooks.

See `~/Desktop/projects/solana-agent-wallet-adapter/docs/research/05-framework-signer-shapes.md` for the cross-framework rationale and the planned next integrations (LangChain JS, LangChain Python, CrewAI, Pydantic AI).

## Status

Phase 1: builds clean against `ai@^5`. Browser Wallet Standard smoke passed with Backpack; a real LLM call is still a useful follow-up. Mock-backend smoke is runnable via `SolanaSigningClient` with `createMockBackend()` from the mcp-server package.
