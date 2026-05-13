# Connector Playbooks

These playbooks explain what the agent may read, what it may prepare for wallet approval, and what it must refuse. Machine-readable packs live in `spec/connectors/*.connector.json`; use those packs for evals and prompt fixtures.

## Runtime Status

| Connector | Runtime status | Reads | Writes | Notes |
| --- | --- | --- | --- | --- |
| Kamino | First-class | Positions, rewards proof, reserve snapshots | Deposit, withdraw | Implemented by the MCP Kamino adapter. |
| Jupiter | First-class | Swap API v2 order preview, swap quote, Token API V2 metadata/tags/categories/recent, Price API V3 prices, token risk evidence, beta Prediction events/markets/orderbook/wallet reads (opt-in), Perps status (read-only research, account snapshots return unsupported_method) | Prepared swap, direct wallet swap | Token/Price reads are evidence only and not oracle guarantees. Prediction is beta, read-only, and disabled by default until `connectors.jupiter.prediction.enabled=true`. Perps is read-only research; the official API is work in progress, so account decoding stays gated and all Perps/JLP writes are denied. Trigger and Recurring remain roadmap surfaces. |
| Orca | First-class | Whirlpool snapshots, positions, fees, rewards | Increase liquidity, decrease liquidity, collect fees, collect rewards | Implemented by the MCP Orca adapter; Whirlpools only. |
| Meteora | First-class | DLMM pool snapshots, wallet positions, position detail, fees, rewards | Add liquidity, remove liquidity, claim fees, claim rewards, close empty position | Implemented by the MCP Meteora adapter via optional `@meteora-ag/dlmm`; existing positions only. Claim/remove flows may require sequential wallet signatures. |
| Raydium | First-class | CPMM, CLMM, and AMM v4 pool snapshots; wallet CLMM positions; CPMM LP balances by pool; farm LP deposits by farm | Add liquidity, remove liquidity, collect CLMM fees, farm stake, farm unstake, harvest | Implemented by the MCP Raydium adapter via the optional Raydium SDK. Swaps, pool administration, and Stake RAY governance positions are not exposed. |
| MarginFi | Blink-backed planned | Positions and markets planned | Deposit, withdraw, borrow, repay via Blink planned | Borrow/withdraw must include account-health facts. |
| Drift | Blink-backed planned | Strategy vault markets planned | Vault deposit/withdraw via Blink planned | Does not cover perp order placement. |
| Lulo | Blink-backed planned | Positions, rewards, markets planned | Deposit, withdraw, rewards via Blink planned | Requires exact asset and action URL. |
| Save | First-class | Reserve snapshots, market snapshots, wallet obligation, health preview | Deposit, withdraw, borrow, repay | Implemented by the MCP Save (Solend) adapter; borrow/withdraw gated by projected health factor. |
| Jito | First-class | Stake pool snapshot, wallet JitoSOL position, stake accounts, quotes, deposit receipts | Stake SOL, deposit existing stake account, claim deposit receipt, unstake JitoSOL, withdraw SOL from inactive stake account | Implemented by the MCP Jito adapter. Existing stake-account deposits require the Jito stake-deposit interceptor SDK and create a claimable receipt. Receipt claims validate owner/cooldown and require explicit early-claim opt-in during cooldown. Restaking, MEV/searcher/bundle, validator management, governance, and JTO flows are not exposed. |
| Marinade | First-class | State snapshot, wallet mSOL position, native stake accounts, unstake tickets, quotes | Liquid stake SOL to mSOL, instant unstake mSOL to SOL through Jupiter, delayed unstake, claim delayed unstake | Implemented by the MCP Marinade adapter. Instant unstake refreshes a Jupiter route before wallet approval and enforces minimum SOL output. Native stake accounts are read-only; validator delegation editing and native stake-account liquidation are not exposed. |
| Sanctum | First-class | LST catalog, LST snapshot, Infinity pool snapshot, wallet LST/INF positions, quotes | Swap LST, add Infinity liquidity, remove Infinity liquidity, stake SOL to LST, unstake LST to SOL | Implemented by the MCP Sanctum adapter. Requires `SANCTUM_API_KEY`; `SANCTUM_API_BASE_URL` defaults to `https://sanctum-api.ironforge.network`. Execution refreshes Sanctum Token Swap orders before wallet approval. |
| Magic Eden | First-class (feature-flagged) | API health, collection snapshot, listings, bids, recent activity, wallet NFTs, NFT detail | Buy, list, cancel listing, bid, cancel bid | Implemented by the MCP Magic Eden adapter. Requires `MAGICEDEN_API_KEY` and `MAGICEDEN_CONNECTOR_ENABLED=true`. Solana NFTs only; gated by API health and the 2026-02-27 API transition notice. |
| Tensor | First-class | Collection snapshot, listings, bids, recent sales, wallet NFTs, NFT detail, wallet marketplace exposure | Buy, list, cancel listing, bid, cancel bid, capped sweep | Implemented by the MCP Tensor adapter. Requires `TENSOR_API_KEY` and a host-wired Tensor client (legacy `@tensor-oss/tensorswap-sdk`, compressed `@tensor-oss/tcomp-sdk`). Sweep is capped to 10 itemized listings and refuses mixed legacy/compressed batches. |
| Realms | First-class | Wallet governance, realm snapshot, governance snapshot, proposal list, proposal snapshot, vote record | Cast vote, relinquish vote, deposit governance tokens, withdraw governance tokens | Implemented by the MCP Realms (SPL Governance) adapter. Requires `@solana/spl-governance` wired via `setRealmsClientFactory()`. Cast vote is refused when the realm uses a voting power plugin (e.g., VSR). Voting is not execution. No treasury/upgrade/config proposals in v1. |
| Pyth | First-class oracle | Price feed, batch prices, feed search, on-chain price account, oracle evidence | Post price update | Implemented by the MCP Pyth adapter via the public Hermes API. Posting price updates requires the optional `@pythnetwork/pyth-solana-receiver` dependency and is capped to two feeds per transaction in v1. |
| Squads | First-class multisig | Wallet authority, multisig snapshot, vault snapshot, proposal snapshot, proposal list (with decoded instruction preview) | Create transfer proposal (SOL/SPL), approve, reject, cancel, execute | Implemented by the MCP Squads adapter. Requires `@sqds/multisig` wired via `setSquadsMultisigClientFactory()`. V1 prepare paths cover transfer-only proposal creation and vote/execute on existing proposals; member/threshold admin changes are not exposed. Execute is permission- and time-lock-gated; the adapter never auto-executes after approval. |
| Wormhole | First-class bridge | Supported routes, token snapshot, quote, transfer status, wallet bridge exposure | Solana-source bridge transfer, redeem on Solana, recover/resume Solana-compatible transfer | Implemented by the MCP Wormhole adapter through an injected Wormhole SDK client. Route reads degrade to conservative static facts with `prepareSupported=false` when the client is not wired; quote/status/prepare paths require `setWormholeClientFactory()`. Destination-chain signing outside Solana, NFT bridge, governance VAA, and bridge admin operations are not exposed. |

## Shared Rules

- Read facts may inform an answer or review, but they do not grant permission to move funds.
- Write actions prepare wallet-approval work only. The wallet still signs and broadcasts.
- If a user omits required fields, ask at most three short questions.
- If a connector or capability is unavailable, say what is missing instead of pretending it works.
- Never say "I signed", "I approved", "guaranteed safe", or "auto-pay without wallet approval".

## Files

- `kamino.md` - first-class lending connector.
- `jupiter.md` - first-class Jupiter Swap, Token/Price evidence, Lend, and beta read-only Prediction notes.
- `orca.md` - first-class Whirlpool connector.
- `meteora.md` - first-class DLMM connector.
- `jito.connector.json` - machine-readable first-class JitoSOL liquid staking connector pack.
- `marinade.connector.json` - machine-readable first-class Marinade mSOL liquid staking connector pack.
- `sanctum.md` - first-class Sanctum LST, Router, and Infinity connector.
- `magiceden.md` - first-class NFT marketplace connector (feature-flagged).
- `tensor.md` - first-class Tensor NFT marketplace connector with capped sweep.
- `squads.md` - first-class multisig + treasury connector.
- `realms.md` - first-class SPL Governance connector (cast vote, relinquish, deposit/withdraw governance tokens).
- `wormhole.md` - first-class Wormhole bridge connector.
- `planned-connectors.md` - Future Blink-backed connector notes.
- `safety-language.md` - canonical required and forbidden phrasing.

## How Agents Should Use This

1. Match the user request to a connector by id, name, or alias.
2. Check the connector pack's `readCapabilities` and `writeCapabilities`.
3. Gather required user inputs and connector facts.
4. Classify the result as read-only answer, proof-only review, prepared approval action, needs input, or unsupported.
5. Return flexible findings that match the request. Do not force swap rows onto non-swap requests.
