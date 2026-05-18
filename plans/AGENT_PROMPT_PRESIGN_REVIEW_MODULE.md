# Agent Prompt: Pre-Sign Review Model Module

Read `TX_SAFETY_SHARED_SPEC.md` first.

This prompt is parallel-safe. It owns only the pre-sign review module and its tests. Do not edit any file outside the write scope.

## Mission

Create a pure pre-sign review module that turns transaction facts into compact UI-ready review models before the wallet opens. It must support sends, swaps, and custom transactions without rendering empty `n/a` fields.

This prompt does not integrate the review into the UI. The browser integration agent will do that separately.

## Write Scope

You may edit only:

- `apps/browser-demo/src/preSignReview.ts`
- `apps/browser-demo/src/__tests__/preSignReview.test.ts`

Do not edit:

- `apps/browser-demo/src/main.ts`
- `apps/browser-demo/src/styles.css`
- `apps/browser-demo/src/transactionLedger.ts`
- `apps/browser-demo/src/transactionFailure.ts`
- Render server code
- MCP server code
- CLI/desktop code
- package manifests unless a test runner proves a missing dependency

Prefer no new dependencies.

## Required API

Export these names:

```ts
export type ReviewTone = 'neutral' | 'good' | 'warn' | 'danger';

export interface PreSignReviewRow {
  label: string;
  value: string;
  title?: string;
  copyValue?: string;
  tone?: ReviewTone;
}

export interface PreSignReviewSection {
  title: string;
  rows: PreSignReviewRow[];
  note?: string;
}

export interface PreSignReviewModel {
  title: string;
  subtitle: string;
  riskTone: ReviewTone;
  primaryAction: string;
  sections: PreSignReviewSection[];
  warnings: string[];
}

export interface TouchedProgramInput {
  programId: string;
  label?: string;
  source?: 'parsed' | 'known' | 'unknown';
  writable?: boolean;
}

export function buildSendPreSignReview(input: SendPreSignReviewInput): PreSignReviewModel;
export function buildSwapPreSignReview(input: SwapPreSignReviewInput): PreSignReviewModel;
export function buildCustomTransactionPreSignReview(input: CustomTransactionPreSignReviewInput): PreSignReviewModel;
export function formatTouchedPrograms(programs?: TouchedProgramInput[]): PreSignReviewRow[];
export function shortAddress(value: string, head?: number, tail?: number): string;
```

Define and export input interfaces for send/swap/custom review models. Keep them plain data shapes with optional fields.

## Shared Formatting Rules

- Title for all models: `Review before wallet opens`
- Do not claim a transaction is safe.
- Do not include empty, undefined, null, or `n/a` rows.
- Use compact labels:
  - `Wallet`
  - `Recipient`
  - `Amount`
  - `Token`
  - `Fee`
  - `Balance`
  - `Post-send`
  - `Route`
  - `Expected out`
  - `Min received`
  - `Slippage`
  - `Price impact`
  - `Jupiter id`
  - `Fee payer`
  - `Program`
  - `Instructions`
  - `Cluster`
- Long addresses should show a short value, with full address in `title` and `copyValue`.
- Output rows should be stable and predictable for tests.
- Warnings should be short. They should explain what is missing or risky, not tell the user what to do.

## Send Review Input

Support at least these fields:

```ts
export interface SendPreSignReviewInput {
  cluster: string;
  sender?: string;
  recipient?: string;
  amount?: string;
  token?: string;
  memo?: string;
  estimatedFee?: string;
  currentBalance?: string;
  postSendBalance?: string;
  balanceIsInsufficient?: boolean;
  mainnetWarning?: boolean;
  touchedPrograms?: TouchedProgramInput[];
}
```

## Send Review Output

Sections should include:

- `Transfer`
- `Wallet`
- `Network`
- `Programs` only when touched programs exist

Rows should include when available:

- sender wallet
- recipient
- amount and token
- estimated fee
- current balance
- post-send balance
- memo
- cluster

Warnings:

- Missing recipient.
- Amount exceeds balance.
- Fee estimate missing.
- Mainnet warning only when caller sets `mainnetWarning`.

Primary action: `Open wallet to send`

## Swap Review Input

Support at least these fields:

```ts
export interface SwapPreSignReviewInput {
  cluster: string;
  taker?: string;
  inputToken?: string;
  inputAmount?: string;
  outputToken?: string;
  expectedOutput?: string;
  minimumReceived?: string;
  slippageBps?: number;
  routeLabel?: string;
  jupiterRequestId?: string;
  priceImpactPct?: number;
  priceImpactWarnPct?: number;
  platformFee?: string;
  touchedPrograms?: TouchedProgramInput[];
}
```

## Swap Review Output

Sections should include:

- `Swap`
- `Route`
- `Wallet`
- `Network`
- `Programs` only when touched programs exist

Rows should include when available:

- input token and amount
- output token
- expected output
- minimum received
- slippage as both bps and percent
- route label
- Jupiter request id
- price impact
- platform fee
- taker wallet
- cluster

Warnings:

- Missing expected output.
- Missing route label.
- High slippage when `slippageBps > 100`.
- Price impact above `priceImpactWarnPct` when both values are provided.

Primary action: `Open wallet to swap`

## Custom Transaction Input

Support at least these fields:

```ts
export interface CustomTransactionPreSignReviewInput {
  cluster: string;
  transactionHash?: string;
  transactionByteLength?: number;
  feePayer?: string;
  instructionCount?: number;
  writableAccountCount?: number;
  signerCount?: number;
  touchedPrograms?: TouchedProgramInput[];
  warnings?: string[];
}
```

## Custom Transaction Output

Sections should include:

- `Transaction`
- `Wallet`
- `Network`
- `Programs` only when touched programs exist

Rows should include when available:

- transaction fingerprint/hash
- transaction byte length
- fee payer
- instruction count
- writable account count
- signer count
- cluster
- touched programs

Warnings:

- Unknown touched programs.
- Multiple signers.
- Caller-provided warnings.
- Writable program/authority/sysvar accounts when caller marks a program row writable and unknown.

Primary action: `Open wallet to sign transaction`

## Program Formatting

`formatTouchedPrograms` should:

- Return an empty array for missing/empty program input.
- Prefer `label` in row value when present.
- Put program id in `title` and `copyValue`.
- Mark unknown programs with `tone: 'warn'`.
- Mark writable unknown programs with `tone: 'danger'`.

## Tests

Use Vitest. Cover:

- SOL send with recipient, amount, fee, balance, and post-send balance.
- SPL send with unknown/missing recipient warning.
- Send with insufficient balance warning.
- Swap with expected output, min received, slippage, route, Jupiter request id.
- Swap with high slippage warning.
- Swap with price impact warning.
- Custom transaction with transaction hash, fee payer, instruction count, and touched programs.
- Custom transaction with multiple signers warning.
- Empty optional fields do not render `n/a` rows.
- Program formatting for known, unknown, and writable unknown programs.
- Address shortening keeps full address in `title`/`copyValue`.

## Acceptance

Run the browser-demo tests if practical from your environment:

```bash
pnpm -F @solana-agent-wallet-adapter/browser-demo test
```

If this prompt runs in parallel before the other prompts, full project typecheck may fail until all parallel patches are merged. Do not edit outside your write scope to fix cross-prompt imports.

Final response: list only the files changed and the exported API.
