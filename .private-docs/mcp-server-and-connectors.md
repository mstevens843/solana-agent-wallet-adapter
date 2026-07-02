# MCP Server And Connectors

`packages/mcp-server` is the local and server-side action engine.

## Role

It provides:

- MCP stdio server
- MCP Streamable HTTP server
- mock backend
- local bridge backend
- remote bridge backend
- action service
- prepared action store
- connector registry
- connector fact reads
- connector transaction preparation
- AI planner support
- policy resolver support
- market and wallet data helpers

## Base Signing Tools

Base wallet tools:

- `solana_get_address`
- `solana_connect_wallet`
- `solana_sign_message`
- `solana_sign_transaction`
- `solana_sign_and_send_transaction`
- `solana_simulate_transaction`
- `solana_check_approval`

These route through a `WalletBackend`. The agent does not receive the private key.

## Product Tool Groups

Instead of documenting every tool in the README, public docs should group tools by behavior:

- wallet status and health
- balances and portfolio
- transfers
- swaps and quote previews
- prepared action lifecycle
- recurring schedules
- receipts
- connector capabilities
- connector fact reads
- connector prepares
- AP2/ACP/MPP helpers
- streaming session helpers
- Phoenix/Vulcan upstream status/tools when enabled

## Prepared Actions

Prepared actions are stored requests waiting for explicit user review.

Lifecycle examples:

- prepared
- pending
- approved
- rejected
- blocked
- scheduled
- archived
- completed
- failed

Execution requires wallet approval unless the action is a read/proof-only path.

## Connector Registry

Primary connector ids:

- Kamino
- Jupiter
- Meteora
- Raydium
- Orca
- MarginFi
- Project 0
- Drift
- Lulo
- Save
- Jito
- Marinade
- Tensor
- Magic Eden
- Sanctum
- Pyth
- Realms
- Squads
- Wormhole
- Phoenix

Connector entries define:

- aliases
- supported clusters
- read capabilities
- write capabilities
- read tools
- action tools
- required config
- execution mode
- approval boundary
- limitations
- examples

## Connector Rule

Reads inform the agent. Writes prepare wallet-approval work. The wallet still signs.

No connector should imply:

- delegated unlimited authority
- automatic execution
- hidden signing
- guaranteed safety
- broad actions outside the documented capability

## First-Class Connector Areas

Solana finance areas covered or partially covered:

- swaps
- token/price evidence
- lending
- borrow
- earn
- staking and LSTs
- liquidity pools
- CLMM/DLMM/Whirlpool/CPMM
- trigger/limit orders
- native recurring/DCA products
- bridge transfers
- NFT marketplace buys/listings/bids
- governance voting
- multisig proposals
- oracle updates
- perps research

## Connector Facts

Connector facts normalize protocol-specific reads into rows that review and chat can use. They should be compact, redacted, and action-scoped.

Fact tone:

- good
- warn
- neutral
- fail

## Policy Resolver

The MCP server supplies the capability resolver used by `runPolicyPipeline()`. This is how policy atoms resolve to live Solana, market, wallet, and connector facts.

## Public Documentation Strategy

Do not put a giant exhaustive tool list in public README. It becomes stale and teaches cloners the full surface in one place.

Use:

- exact base signing tools
- grouped product tool categories
- connector docs link
- safety boundary language
- examples that show the model but do not reveal every implementation detail

