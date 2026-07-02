# Agentic App Feature Analysis

Private draft. Do not publish without redaction.

## Product Position

Agentic is a Solana wallet approval workspace for AI agents. It combines:

- wallet signing boundary
- chat assistant
- deterministic decision system
- app workflow layer
- finance connector controls
- evidence receipts
- hosted cloud sync
- local bridge runtime
- mobile shells
- MCP and SDK integrations

The core promise remains:

> The agent prepares. The user reviews. The wallet signs.

## Current `/app` Workflows

The visible navigation changes by platform, but these are the main workflows.

### Home

Home shows:

- connected wallet state
- active storage mode
- cloud sign-in state
- AI setup state
- connector state
- guardrail and preference entrypoints
- next recommended action

### Chat

Chat is the main power surface.

Capabilities:

- general assistant answers
- wallet balance and portfolio answers from live context
- token price and market facts
- token safety and age
- wallet history
- NFT and asset metadata
- wallet portfolio, PnL, origin, and net-worth history
- priority fee and transaction explanation
- connector facts
- current research where supported
- action preparation for send, swap, sign proof
- recurring/DCA setup
- connector action setup
- Decision Planner
- research cards
- pending approval resurfacing
- inline receipts and tx links
- cloud chat sync for signed-in wallets

Chat can prepare cards. It cannot sign, approve, or broadcast.

### New Request

New Request handles structured workflow creation:

- keyless templates
- BYOK AI plan generation
- one-time wallet actions
- connector forms
- proof-oriented reviews
- audit/evidence records
- token search and custom token handling
- agent review before queueing

The Chat connector action surface reuses New Request state and forms, which means connector coverage is not duplicated.

### Sign Approval

Sign Approval is the active approval inbox.

It includes:

- one-time prepared actions
- chat-originated prepared actions
- recurring due occurrences
- connector actions
- proof messages
- finalization flows
- approve, deny, cancel, archive, execute, or retry paths

Wallet signing happens here or from an inline chat card that references the same prepared action.

### Done

Done shows:

- completed approvals
- denials
- receipts
- finalization records
- transaction links
- signed evidence
- historical terminal state

### More

The More menu includes:

- Positions
- Address Book
- Repeat Payments
- Save Proof
- Agent Payments
- Skills
- Spending Sessions
- optional registered dev tabs

On mobile, Preferences and Done also move into the dock/menu layout.

## Repeat Payments

Repeat Payments supports manual-approval recurring flows:

- recurring SOL/SPL transfer schedules
- recurring swap/DCA preferences
- active schedules
- occurrence history
- pause/resume/delete
- spend estimates
- notifications/webhooks where supported
- due occurrence materialization into Sign Approval

Important distinction: Agentic recurring schedules do not silently auto-sign. Jupiter native recurring automation is a separate connector/product mode and must be described separately.

## Save Proof

Proofs create wallet-signed evidence records:

- intent proof
- policy proof
- review proof
- rejection proof
- tool trace proof
- MPP-related evidence
- streaming session grant and settlement evidence

Proofs are message signatures, not transactions.

## Agent Payments

Agent Payments surfaces include:

- A2A/agent profile routes
- AP2 inbound request handling
- ACP adapter paths
- MPP HTTP-402 challenge handling
- pay-out and external agent request flows
- evidence and receipt links

These protocols route payment decisions back through the same approval boundary.

## Spending Sessions

Spending sessions support capped, revocable streaming-payment flows:

- user-approved cap
- session state
- voucher issuance
- settlement records
- revoke/finalize paths
- receipts and evidence

This is the deliberate server-signing exception: the server or Android native signer can sign bounded session vouchers/delegate settlement artifacts, not the user's main wallet key.

## Skills

Skills add an app-level execution surface:

- skill install/lifecycle
- skill execution
- approval lookup
- receipt/audit integration

Skill execution must stay tied to approval and evidence flows.

## Positions

Positions tracks active position/order records seeded from wallet actions and connector flows. It remains separate from generic history because positions can be managed or closed before moving to Done.

## Preferences

Preferences groups:

- workspace storage
- AI setup
- protocol connectors
- connector keys
- recipient/address rules
- token labels
- retry/failure policies
- agent policies
- custom tokens
- connected agents
- native runtime diagnostics

## Storage Modes

### Agentic Cloud

Signed-in mode. Stores unsigned plans, approvals, recurring schedules, completed records, evidence receipts, chat sessions, preferences, audit events, and related workflow state.

### Browser Workflow

Signed-out fallback. Stores drafts, approvals, recurring fallback data, receipts, preferences, and chat locally.

### Private Local Mode

Bridge/CLI/desktop path. Keeps approvals and workflow state local to the user's machine.

## Runtime Surfaces

- hosted web app
- local browser app
- Render Node service
- MCP stdio
- MCP HTTP
- CLI
- Tauri desktop shell
- Android native app/TWA
- iOS Capacitor/native paths
- browser Wallet Standard
- Android MWA
- iOS wallet links
- WalletConnect/Reown
- Ledger

## Safety Model

The system separates:

- AI recommendation
- deterministic evidence checks
- prepared action
- human approval
- wallet signature
- receipt

This separation is the product moat.

