# 05 - Framework signer interface shapes

> Superseded context, 2026-05-07: this note is preserved as dated research. The Vercel AI package now targets AI SDK 5 with approval enforced at the wallet boundary through `SolanaSigningClient`, not through an agent-side `needsApproval` flag.

Concrete plug-in shape for each AI agent framework we'll ship adapter packages for.

## Per-framework reference

### LangChain JS - `@langchain/core`

[Reference](https://v03.api.js.langchain.com/classes/_langchain_core.tools.StructuredTool.html). Primary type: `StructuredTool` with Zod input schema.

```typescript
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

class SolanaSignMessageTool extends StructuredTool {
  name = 'solana_sign_message';
  description = 'Sign a message with the user\'s connected Solana wallet (requires user approval).';
  schema = z.object({
    message: z.string(),
    cluster: z.enum(['mainnet-beta', 'testnet', 'devnet', 'localnet']),
  });

  protected async _call(input: z.infer<typeof this.schema>): Promise<string> {
    // submit + poll backend, return JSON string
  }
}
```

- Async via Promise return.
- Zod schema for inputs.
- Return type is string (or stringified JSON).
- Human-in-the-loop is handled at the agent-executor level (LangGraph), not in the tool itself.

### LangChain Python - `langchain-core`

[Source](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/tools/base.py). Primary type: `BaseTool` with Pydantic schema.

```python
from typing import Type
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

class SolanaSignMessageInput(BaseModel):
    message: str = Field(description="UTF-8 message to sign")
    cluster: str = Field(description="Solana cluster")

class SolanaSignMessageTool(BaseTool):
    name: str = "solana_sign_message"
    description: str = "Sign a message with the user's connected Solana wallet (requires user approval)."
    args_schema: Type[BaseModel] = SolanaSignMessageInput

    def _run(self, message: str, cluster: str) -> str:
        # sync path - block on poll
        ...

    async def _arun(self, message: str, cluster: str) -> str:
        # async path - await poll
        ...
```

- Implement `_arun` for the async-friendly polling path; `_run` falls back to thread-pool wrapper if not provided.
- Pydantic schema required.
- Return type: any JSON-serializable.

### Vercel AI SDK - `ai` package

[Reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool). Primary type: result of the `tool()` helper. **First-class `needsApproval` flag - best fit for our pattern.**

```typescript
import { tool } from 'ai';
import { z } from 'zod';

export const solanaSignMessageTool = (backend: WalletBackend) => tool({
  description: 'Sign a message with the user\'s connected Solana wallet.',
  inputSchema: z.object({
    message: z.string(),
    cluster: z.enum(['mainnet-beta', 'testnet', 'devnet', 'localnet']),
  }),
  needsApproval: true, // Vercel surfaces this to the UI before execute fires
  execute: async ({ message, cluster }) => {
    const approval = await backend.submit({ /* ... */ });
    return await pollUntilResolved(backend, approval.requestId);
  },
});
```

- `needsApproval: true | (input) => Promise<boolean>` - built-in human-in-the-loop. Should be the **first integration we ship** because it makes the demo cleaner than any other framework.
- Zod schemas.
- `execute` can be sync or async.

### Solana Agent Kit (sendaifun) - `solana-agent-kit`

Covered in note 04. Implement `BaseWallet`. Plug into `SolanaAgentKit` constructor.

```typescript
import type { BaseWallet } from 'solana-agent-kit';
import { SolanaAgentKit } from 'solana-agent-kit';

const wallet: BaseWallet = new AgentWalletAdapterBackend(backend, address);
const agent = new SolanaAgentKit(wallet, rpcUrl, { OPENAI_API_KEY: '...' });
```

- Async-only.
- No tool wrapper - we plug at the wallet layer, lower than the tool layer.

### CrewAI - `crewai-tools`

[Docs](https://docs.crewai.com/en/learn/create-custom-tools). Primary type: `BaseTool` with Pydantic schema.

```python
from typing import Type
from crewai.tools import BaseTool
from pydantic import BaseModel, Field

class SolanaSignMessageInput(BaseModel):
    message: str
    cluster: str

class SolanaSignMessageTool(BaseTool):
    name: str = "solana_sign_message"
    description: str = "Sign a message with the user's connected Solana wallet."
    args_schema: Type[BaseModel] = SolanaSignMessageInput

    def _run(self, message: str, cluster: str) -> str:
        # must return str
        ...
```

- Return type **must be `str`**. Stringify JSON before returning.
- Pydantic schema must match `_run` parameter names.
- No first-class human-in-the-loop; rely on the JSON-text + polling pattern from note 02.

### Pydantic AI - `pydantic-ai`

[Docs](https://pydantic.dev/docs/ai/tools-toolsets/tools/). Primary mechanism: `@agent.tool` / `@agent.tool_plain` decorators.

```python
from pydantic_ai import Agent, RunContext

agent = Agent('claude-sonnet-4-6', deps_type=AgentDeps)

@agent.tool
async def solana_sign_message(
    ctx: RunContext[AgentDeps],
    message: str,
    cluster: str,
) -> str:
    """Sign a message with the user's connected Solana wallet (requires user approval)."""
    return await ctx.deps.backend.submit_and_poll(/* ... */)
```

- Pydantic auto-infers the schema from the function signature + docstring (Google / NumPy / Sphinx formats).
- Sync or async functions both work.
- `RunContext` carries deps (where we'll inject the backend).

## Cross-framework summary

| Framework | Primary type | Sync/Async | Schema | Built-in approval flag? | Return type |
|---|---|---|---|---|---|
| LangChain JS | `StructuredTool` | Both | Zod | No (handle in agent executor) | string |
| LangChain Py | `BaseTool` | Both | Pydantic | No | Any JSON-serializable |
| Vercel AI SDK | `tool()` helper | Both | Zod or JSON Schema | **Yes (`needsApproval`)** | Any JSON-serializable |
| Solana Agent Kit | `BaseWallet` | Async | n/a (wallet layer) | n/a (lower than tool layer) | n/a |
| CrewAI | `BaseTool` | Both | Pydantic | No | **Must be `str`** |
| Pydantic AI | `@agent.tool` | Both | Auto from signature | No | Any JSON-serializable |

## Normalized core API every adapter wraps

Every framework adapter is a thin wrapper over a single core surface:

```typescript
// packages/core (extension to the existing API)
interface SolanaSigningClient {
  getAddress(): Promise<string>;
  signMessage(message: string, cluster: Cluster, summary?: string): Promise<{ signature: string }>;
  signTransaction(txBase64: string, cluster: Cluster, summary?: string): Promise<{ signed: string }>;
  signAndSendTransaction(txBase64: string, cluster: Cluster, summary?: string): Promise<{ signature: string; txid: string }>;
}
```

Adapters expose `SolanaSigningClient` as: a `BaseWallet` (Solana Agent Kit), a `tool({...})` (Vercel AI), a `StructuredTool` subclass (LangChain JS), a `BaseTool` subclass (LangChain Py + CrewAI), or a decorator-friendly function (Pydantic AI).

## First integration to ship - Vercel AI SDK

**Pick Vercel AI first** because it has built-in `needsApproval` support, which makes the reference-agent demo show the approval UX without any additional plumbing. Order of subsequent integrations:

1. Vercel AI SDK (cleanest demo, built-in HITL)
2. Solana Agent Kit (wallet-layer plug-in, gives access to their action library)
3. LangChain JS (largest community)
4. LangChain Python (parity with JS)
5. CrewAI (Python, parity)
6. Pydantic AI (Python, parity)

## References

- [LangChain JS StructuredTool](https://v03.api.js.langchain.com/classes/_langchain_core.tools.StructuredTool.html)
- [LangChain Python BaseTool source](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/tools/base.py)
- [Vercel AI SDK tool() reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool)
- [Solana Agent Kit BaseWallet types](https://github.com/sendaifun/solana-agent-kit/blob/v2/packages/core/src/types/wallet.ts)
- [CrewAI custom tools](https://docs.crewai.com/en/learn/create-custom-tools)
- [Pydantic AI tools](https://pydantic.dev/docs/ai/tools-toolsets/tools/)
