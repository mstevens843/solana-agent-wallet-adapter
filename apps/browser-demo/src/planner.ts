import {
  assertPlanGuardrails,
  type AiGuardrailReport,
} from '@solana-agent-wallet-adapter/workflow';

export type AgentPlanSource = 'template' | 'ai';
export type TemplateRisk = 'low' | 'medium' | 'high';
export type TemplateFieldType = 'text' | 'number' | 'textarea' | 'select' | 'datetime-local';
export type AiApiFormat = 'openai-compatible' | 'anthropic';
export type AiProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'custom-openai-compatible';

export interface AgentPlanField {
  label: string;
  value: string;
}

export interface AgentPlan {
  intent: string;
  route: string;
  risk: string;
  approval: string;
  source: AgentPlanSource;
  category: string;
  actionType: string;
  templateTitle: string;
  userNotes?: string;
  parameters: Record<string, string>;
  fields: AgentPlanField[];
  safeguards: string[];
  guardrailReport?: AiGuardrailReport;
  constraintFingerprint?: string;
  constraintHash?: string;
}

export interface AgentPlanTemplateField {
  id: string;
  label: string;
  type?: TemplateFieldType;
  placeholder?: string;
  defaultValue?: string;
  options?: string[];
  required?: boolean;
}

export interface AgentPlanTemplate {
  id: string;
  category: string;
  title: string;
  description: string;
  prompt: string;
  actionType: string;
  risk: TemplateRisk;
  route: string;
  riskText: string;
  approval: string;
  safeguards: string[];
  requiresWallet: boolean;
  requiresBridge: boolean;
  fields: AgentPlanTemplateField[];
}

export interface AiSettings {
  mode: 'hosted' | 'session' | 'bridge';
  provider: AiProviderId;
  apiFormat: AiApiFormat;
  baseUrl: string;
  model: string;
  apiKey: string;
  multiReviewer?: boolean;
  autoBackgroundWatch?: boolean;
}

export interface BridgeAiStatus {
  available: boolean;
  configured: boolean;
  source: 'env' | 'session' | 'none';
  provider?: string;
  apiFormat?: AiApiFormat;
  baseUrl?: string;
  model?: string;
}

export interface AiPlanRequest {
  prompt: string;
  template: Pick<AgentPlanTemplate, 'id' | 'category' | 'title' | 'description' | 'actionType' | 'risk'>;
  parameters: Record<string, string>;
  userNotes?: string;
  connectorContext?: Array<Record<string, unknown>>;
}

export type AgentPlanReviewMode = 'single' | 'multi';

export interface AgentPlanReviewRequest {
  plan: AgentPlan;
  instruction?: string;
  walletAddress?: string;
  cluster?: string;
  context?: Record<string, unknown>;
  mode?: AgentPlanReviewMode;
}

export interface AgentPlanAskRequest {
  plan: AgentPlan;
  question: string;
  walletAddress?: string;
  cluster?: string;
  context?: Record<string, unknown>;
}

export interface AgentPlanAskResult {
  answer: string;
  citations?: Array<{ kind: string; ref: string }>;
  checkedAt: string;
  source: 'ai';
}

export type AgentPlanReviewDecision = 'approve' | 'deny' | 'needs_input';

export interface AgentReviewQuestion {
  id: string;
  prompt: string;
  inputKind: 'text' | 'select' | 'number';
  options?: string[];
  required: boolean;
  hint?: string;
}

export interface AgentReviewerEntry {
  id: string;
  label: string;
  decision: AgentPlanReviewDecision;
  reason: string;
  summary?: string;
  errored?: { message: string };
  checkedAt: string;
}

export interface AgentPlanReviewResult {
  decision: AgentPlanReviewDecision;
  reason: string;
  summary: string;
  evidence: Record<string, unknown>;
  checkedAt: string;
  source: 'ai';
  questions?: AgentReviewQuestion[];
  reviewers?: AgentReviewerEntry[];
}

export type AiDiagnosticCode =
  | 'AI_ROUTE'
  | 'AI_HTTP'
  | 'AI_CONTENT_TYPE'
  | 'AI_ROUTE_MISMATCH'
  | 'AI_PROVIDER_ERROR'
  | 'AI_PLAN_READY';

export interface AiDiagnosticEntry {
  code: AiDiagnosticCode;
  message: string;
  detail?: string;
  method?: string;
  path?: string;
  status?: number;
  contentType?: string;
}

export class AiPlanConnectionError extends Error {
  readonly diagnostics: AiDiagnosticEntry[];

  constructor(message: string, diagnostics: AiDiagnosticEntry[]) {
    super(redactSecrets(message));
    this.name = 'AiPlanConnectionError';
    this.diagnostics = diagnostics.map(redactAiDiagnostic);
  }
}

const SHARED_SAFEGUARDS = [
  'Wallet approval is required before any signature or transaction leaves the device.',
  'The agent never receives the wallet private key or seed phrase.',
  'AI prepares the review item; the wallet owner checks amount, recipient, route, protocol, slippage, and policy before signing.',
];

const AI_KEY_COPY_PASTE_ARTIFACTS = /[\s\u200B-\u200D\u2060\uFEFF]+/gu;

export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_AI_MODEL = 'gpt-5';
export const DEFAULT_AI_PROVIDER_ID: AiProviderId = 'openai';

export interface AiProviderPreset {
  id: AiProviderId;
  label: string;
  detail: string;
  apiFormat: AiApiFormat;
  baseUrl: string;
  model: string;
  models: AiProviderModel[];
}

export interface AiProviderModel {
  id: string;
  label: string;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    detail: 'GPT models through Agentic hosted or local bridge calls.',
    apiFormat: 'openai-compatible',
    baseUrl: DEFAULT_AI_BASE_URL,
    model: DEFAULT_AI_MODEL,
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano' },
      { id: DEFAULT_AI_MODEL, label: 'GPT-5' },
      { id: 'gpt-5.2', label: 'GPT-5.2' },
      { id: 'gpt-5.1', label: 'GPT-5.1' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-5-nano', label: 'GPT-5 nano' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Claude / Anthropic',
    detail: 'Claude models through the Anthropic Messages API.',
    apiFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    models: [
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 snapshot' },
      { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1' },
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
      { id: 'claude-3-5-haiku-20241022', label: 'Claude Haiku 3.5' },
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    detail: 'Google Gemini through its OpenAI-compatible endpoint.',
    apiFormat: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    detail: 'Use OpenRouter as a gateway for many hosted models.',
    apiFormat: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    models: [
      { id: 'openrouter/auto', label: 'Auto Router' },
      { id: 'openai/gpt-5', label: 'OpenAI GPT-5' },
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
  },
  {
    id: 'custom-openai-compatible',
    label: 'Custom OpenAI-compatible',
    detail: 'Vercel AI Gateway, Cloudflare AI Gateway, or a self-hosted proxy.',
    apiFormat: 'openai-compatible',
    baseUrl: DEFAULT_AI_BASE_URL,
    model: DEFAULT_AI_MODEL,
    models: [
      { id: DEFAULT_AI_MODEL, label: 'GPT-5 compatible default' },
    ],
  },
];

export const AGENT_PLAN_TEMPLATES: AgentPlanTemplate[] = [
  template('payments', 'transfer-sol', 'Send SOL', 'Prepare a SOL payment with recipient, amount, memo, and wallet approval.', 'transfer_sol', 'medium', [
    field('recipient', 'Recipient address', 'Recipient public key', '', true),
    field('amount', 'Amount SOL', '0.01', '0.01', true),
    field('memo', 'Memo / reason', 'Invoice, friend payment, reimbursement', 'User-approved SOL payment'),
  ]),
  template('payments', 'transfer-token', 'Send SPL token', 'Prepare a token transfer for USDC, BONK, JUP, or any configured SPL token.', 'transfer_spl', 'medium', [
    selectField('token', 'Token', ['USDC', 'SOL', 'JUP', 'BONK', 'WIF', 'PYUSD'], 'USDC'),
    field('recipient', 'Recipient address', 'Recipient public key', '', true),
    field('amount', 'Token amount', '10', '10', true),
    field('memo', 'Memo / reason', 'Payment reason', 'User-approved token payment'),
  ]),
  template('trading', 'swap', 'Swap tokens', 'Prepare a DeFi swap review with explicit input, output, amount, protocol route, and slippage cap.', 'swap', 'medium', [
    selectField('inputToken', 'Input token', ['SOL', 'USDC', 'JUP', 'BONK', 'WIF', 'PYUSD'], 'SOL'),
    selectField('outputToken', 'Output token', ['USDC', 'SOL', 'JUP', 'BONK', 'WIF', 'PYUSD'], 'USDC'),
    field('amount', 'Token amount', '0.01', '0.01', true),
    field('slippageBps', 'Max slippage', '0.5%', '50'),
  ]),
  template('recurring', 'dca', 'DCA review proof', 'Sign a review proof for a recurring DCA strategy before using a swap-capable recurring engine.', 'manual_review', 'medium', [
    selectField('token', 'Spend token', ['SOL', 'USDC', 'PYUSD'], 'USDC'),
    field('amount', 'Amount per occurrence', '10', '10', true),
    field('recipient', 'Recipient / settlement wallet', 'Recipient public key', '', true),
    selectField('cadence', 'Cadence', ['weekly', 'monthly', 'interval_days'], 'weekly'),
    field('memo', 'Strategy note', 'Buy SOL weekly if route stays under cap', 'Recurring DCA approval'),
  ]),
  template('recurring', 'subscription', 'Vendor / recurring payment', 'Prepare a recurring vendor or service payment review without granting unlimited authority.', 'recurring_payment', 'medium', [
    selectField('token', 'Token', ['USDC', 'SOL', 'PYUSD'], 'USDC'),
    field('recipient', 'Recipient address', 'Recipient public key', '', true),
    field('amount', 'Max amount per payment', '5', '5', true),
    selectField('cadence', 'Cadence', ['weekly', 'monthly', 'interval_days'], 'monthly'),
    field('memo', 'Service / reason', 'Subscription memo', 'Recurring user-approved payment'),
  ]),
  template('trading', 'limit-order', 'Limit order review', 'Prepare a limit-order intent that waits for explicit wallet approval at execution time.', 'manual_review', 'medium', [
    selectField('inputToken', 'Input token', ['SOL', 'USDC', 'JUP', 'BONK', 'WIF'], 'SOL'),
    selectField('outputToken', 'Output token', ['USDC', 'SOL', 'JUP', 'BONK', 'WIF'], 'USDC'),
    field('amount', 'Token amount', '0.1', '0.1'),
    field('limitPrice', 'Limit price / condition', 'Only if SOL >= $250', ''),
  ]),
  template('trading', 'rebalance', 'Portfolio rebalance', 'Plan a rebalance while preserving final wallet approval for each action.', 'manual_review', 'high', [
    textareaField('target', 'Target allocation', 'Example: 60% SOL, 30% USDC, 10% JUP'),
    field('maxTradeSize', 'Max trade size', '100 USDC', '100 USDC'),
    field('slippageBps', 'Max slippage', '0.5%', '50'),
  ]),
  template('portfolio', 'balances', 'Portfolio check', 'Read and summarize wallet balances before proposing any action.', 'read_only', 'low', [
    selectField('scope', 'Scope', ['SOL + configured tokens', 'All SPL tokens', 'NFTs', 'DeFi positions'], 'SOL + configured tokens'),
    field('threshold', 'Alert threshold', 'Show assets over $10', 'Show assets over $10'),
  ]),
  template('portfolio', 'nft-review', 'NFT holdings review', 'Review NFT holdings, floor-risk notes, and suspicious collection signals.', 'read_only', 'low', [
    field('collection', 'Collection / mint', 'Optional collection name or mint', ''),
    selectField('goal', 'Goal', ['Summarize', 'Flag suspicious assets', 'Prepare sale review', 'Prepare transfer review'], 'Summarize'),
  ]),
  template('staking', 'stake-sol', 'Stake SOL', 'Prepare a staking/delegation action with validator and amount visible before signing.', 'manual_review', 'medium', [
    field('validator', 'Validator vote account', 'Vote account or validator name', '', true),
    field('amount', 'Amount SOL', '1', '1'),
    field('memo', 'Reason', 'Stake with selected validator', 'Stake review'),
  ]),
  template('staking', 'unstake-sol', 'Unstake / deactivate', 'Prepare an unstake or deactivate review with cooldown expectations.', 'manual_review', 'medium', [
    field('stakeAccount', 'Stake account', 'Stake account public key', ''),
    field('amount', 'Amount SOL or all', 'all', 'all'),
    field('memo', 'Reason', 'Liquidity needed', 'Unstake review'),
  ]),
  template('governance', 'vote', 'Governance vote', 'Summarize a proposal and create a wallet review proof for the chosen vote.', 'manual_review', 'medium', [
    field('proposal', 'Proposal link / id', 'Realm proposal URL or id', '', true),
    selectField('vote', 'Vote', ['Yes', 'No', 'Abstain'], 'Abstain'),
    textareaField('reason', 'Voting reason', 'Why this vote matches my policy'),
  ]),
  template('security', 'transaction-review', 'Transaction simulation review', 'Review transaction bytes, touched programs, accounts, and authority changes before signing.', 'manual_review', 'high', [
    textareaField('transaction', 'Transaction / link / base64', 'Paste transaction bytes, link, or request description'),
    field('policy', 'Policy cap', 'No new authority grants, no unlimited approvals', 'No new authority grants'),
  ]),
  template('security', 'authority-audit', 'Authority / approval audit', 'Look for delegate authority, token account permissions, and suspicious approval semantics.', 'manual_review', 'high', [
    field('programOrMint', 'Program, mint, or account', 'Address to review', ''),
    textareaField('concern', 'Concern', 'What feels risky or needs checking?'),
  ]),
  template('security', 'rug-check', 'Token risk check', 'Prepare a token risk review before buying, swapping, or accepting a token.', 'manual_review', 'high', [
    field('mint', 'Token mint', 'Mint address', ''),
    field('amount', 'Planned amount', 'Optional amount', ''),
    field('source', 'Source / link', 'DexScreener, Jupiter, X, website', ''),
  ]),
  template('defi', 'lend-borrow', 'Lending / borrow review', 'Prepare a DeFi lending, borrow, repay, or withdraw plan with collateral risk visible.', 'manual_review', 'high', [
    selectField('action', 'Action', ['Deposit', 'Withdraw', 'Borrow', 'Repay'], 'Deposit'),
    field('market', 'Protocol / market', 'Kamino, MarginFi, Solend, custom', ''),
    field('amount', 'Amount', '100 USDC', '100 USDC'),
    field('ltv', 'Max LTV / rule', 'Stay below 50% LTV', 'Stay below 50% LTV'),
  ]),
  template('defi', 'kamino-deposit', 'Kamino deposit', "Supply SOL or an SPL token to a Kamino Lend reserve. Natural prompts: 'stake on Kamino', 'supply to Kamino', 'earn yield on Kamino'. Requires Kamino enabled in Protocol Connectors.", 'kamino_deposit', 'medium', [
    selectField('token', 'Token', ['SOL', 'USDC', 'JitoSOL', 'mSOL', 'bSOL'], 'SOL'),
    field('amount', 'Amount', '0.1', '0.1', true),
    field('memo', 'Reason', 'Earn yield on idle SOL', 'Kamino deposit review'),
  ]),
  template('defi', 'kamino-withdraw', 'Kamino withdraw', 'Redeem some or all of a Kamino Lend supply position. Requires Kamino enabled in Protocol Connectors.', 'kamino_withdraw', 'medium', [
    selectField('token', 'Token', ['SOL', 'USDC', 'JitoSOL', 'mSOL', 'bSOL'], 'SOL'),
    field('amount', 'Amount (or "all")', '0.05', '0.05'),
    field('memo', 'Reason', 'Need liquidity for payments', 'Kamino withdraw review'),
  ]),
  template('defi', 'kamino-earnings-proof', 'Kamino earnings proof', "Build a signable receipt that proves how much you've earned by supplying to Kamino. Read-only; signing creates a shareable verification.", 'read_only', 'low', [
    selectField('token', 'Reserve', ['All reserves', 'SOL', 'USDC', 'JitoSOL', 'mSOL', 'bSOL'], 'All reserves'),
    field('memo', 'Reason', 'Tax / accounting record', 'Kamino earnings receipt'),
  ]),
  template('defi', 'liquidity', 'Liquidity position review', 'Review LP deposits, withdrawals, fees, and impermanent loss before wallet approval.', 'manual_review', 'high', [
    field('pool', 'Pool / protocol', 'Orca, Raydium, Meteora, custom', ''),
    field('amounts', 'Amounts', '0.1 SOL + 20 USDC', ''),
    field('range', 'Price range / condition', 'Optional range', ''),
  ]),
  template('defi', 'protocol-position-check', 'Protocol position check', 'Read a connected protocol position or market before proposing any action. The agent must report missing connector facts honestly.', 'read_only', 'low', [
    selectField('protocol', 'Protocol', ['Kamino', 'Jupiter', 'Raydium', 'Orca', 'Meteora', 'MarginFi', 'Drift', 'Lulo', 'Save'], 'Meteora'),
    field('position', 'Position / market', 'Pool, market, vault, or position address', ''),
    selectField('question', 'Question', ['Status', 'Rewards', 'Fees', 'Unlock timing', 'Available actions'], 'Status'),
    textareaField('memo', 'Instructions', 'Check my position and show evidence before proposing anything executable.'),
  ]),
  template('defi', 'protocol-blink-action', 'Protocol connector action', 'Prepare an executable protocol action through an enabled connector. Requires a Blink or Solana Action URL; transaction bytes are fetched only when sent for approval.', 'blink_action', 'high', [
    selectField('protocol', 'Protocol', ['Kamino', 'Jupiter', 'Raydium', 'Orca', 'Meteora', 'MarginFi', 'Drift', 'Lulo', 'Save'], 'Meteora'),
    selectField('operation', 'Operation', ['Claim rewards', 'Claim fees', 'Withdraw liquidity', 'Close position', 'Deposit', 'Borrow', 'Repay', 'Swap'], 'Claim fees'),
    field('blinkUrl', 'Blink / Action URL', 'blink:https://... or solana-action:https://...', '', true),
    field('position', 'Position / market', 'Pool, market, vault, or position address', ''),
    field('amount', 'Amount / cap', 'all, 0.1 SOL, 100 USDC', ''),
    textareaField('memo', 'Agent instructions', 'Check connector facts first. Prepare only if amount, protocol, route, and policy match my instructions.'),
  ]),
  template('nft', 'nft-transfer', 'NFT transfer', 'Prepare an NFT transfer with recipient, collection, and anti-phishing checks.', 'manual_review', 'medium', [
    field('mint', 'NFT mint', 'Mint address', '', true),
    field('recipient', 'Recipient address', 'Recipient public key', '', true),
    field('memo', 'Reason', 'Transfer memo', 'NFT transfer review'),
  ]),
  template('nft', 'marketplace-listing', 'Marketplace listing review', 'Prepare a listing or delisting review with price, marketplace, and royalties visible.', 'manual_review', 'medium', [
    field('mint', 'NFT mint', 'Mint address', ''),
    field('marketplace', 'Marketplace', 'Tensor, Magic Eden, custom', ''),
    field('price', 'Price', '1 SOL', ''),
  ]),
  template('developer', 'devnet-smoke', 'Devnet smoke test', 'Prepare a safe devnet signing test for local wallets, bridge, and receipt flow.', 'manual_review', 'low', [
    field('message', 'Test message', 'Approve this Agentic devnet smoke test.', 'Approve this Agentic devnet smoke test.'),
    selectField('network', 'Network', ['devnet', 'testnet', 'localnet'], 'devnet'),
  ]),
  template('developer', 'custom-tx', 'Custom transaction bytes', 'Review pasted transaction bytes and produce an approval checklist before signing.', 'manual_review', 'high', [
    textareaField('transaction', 'Transaction bytes / base64', 'Paste base64 transaction bytes'),
    field('expected', 'Expected outcome', 'What should happen if signed?', ''),
  ]),
  template('mobile', 'seed-vault', 'Seed Vault mobile approval', 'Plan an Android MWA or Seed Vault signing path without exposing wallet keys.', 'manual_review', 'medium', [
    selectField('walletPath', 'Wallet path', ['Mobile Wallet Adapter', 'Seed Vault Wallet', 'Phantom mobile', 'Solflare mobile'], 'Mobile Wallet Adapter'),
    field('action', 'Action', 'Connect wallet and approve request', 'Connect wallet and approve request'),
    field('deviceNote', 'Device note', 'Seeker / Android Chrome / TWA', 'Android Chrome / TWA'),
  ]),
  template('integration', 'dapp-interaction', 'dApp interaction review', 'Prepare a review for a third-party dApp request before the user signs. For first-class protocols (Kamino), enable the adapter in Protocol Connectors and use the dedicated template instead of this catch-all.', 'manual_review', 'high', [
    field('dapp', 'dApp / URL', 'Jupiter, Meteora, Tensor, Kamino, custom URL', ''),
    textareaField('request', 'Request details', 'What the dApp asks the wallet to sign'),
    field('policy', 'Policy cap', 'No unknown programs or authority grants', 'No unknown programs or authority grants'),
  ]),
  template('bridge', 'bridge-swap', 'Bridge / cross-chain link review', 'Review a bridge or cross-chain link while keeping signing inside the wallet flow.', 'manual_review', 'high', [
    field('sourceChain', 'Source chain', 'Solana', 'Solana'),
    field('destinationChain', 'Destination chain', 'Base, Ethereum, Arbitrum, Solana', ''),
    field('amount', 'Amount', '10 USDC', '10 USDC'),
    field('link', 'Bridge link / quote', 'Paste link or quote id', ''),
  ]),
  template('receipts', 'tax-export', 'Receipt / tax note', 'Create an audit note after approval for tax, accounting, or operations review.', 'read_only', 'low', [
    field('txid', 'Transaction id', 'Optional tx id', ''),
    field('label', 'Label', 'Treasury transfer, swap, reimbursement', 'Agentic wallet action'),
    textareaField('notes', 'Notes', 'Accounting or audit notes'),
  ]),
  template('custom', 'custom-request', 'Custom request', 'Turn any plain-English request into a visible review plan before signing evidence.', 'manual_review', 'medium', [
    field('policy', 'Policy cap', 'What should never be allowed?', 'No private key sharing, no unlimited approvals'),
  ]),
];

export function templateById(id: string): AgentPlanTemplate {
  return AGENT_PLAN_TEMPLATES.find((template) => template.id === id) ?? AGENT_PLAN_TEMPLATES[0]!;
}

export function defaultTemplateFieldValues(template: AgentPlanTemplate): Record<string, string> {
  return Object.fromEntries(template.fields.map((fieldDef) => [fieldDef.id, fieldDef.defaultValue ?? '']));
}

export function templateFieldLabel(template: AgentPlanTemplate, id: string): string {
  return template.fields.find((fieldDef) => fieldDef.id === id)?.label ?? titleCase(id);
}

export function buildTemplatePlan(
  template: AgentPlanTemplate,
  parameters: Record<string, string>,
  source: AgentPlanSource = 'template',
  userNotes = '',
): AgentPlan {
  const readableParams = readableParameters(template, parameters);
  const actionSummary = readableParams.length
    ? readableParams.map((entry) => `${entry.label}: ${entry.value}`).join('; ')
    : template.prompt;
  const notes = userNotes.trim();
  const plan: AgentPlan = {
    intent: source === 'ai'
      ? template.prompt
      : `${template.title}: ${actionSummary}`,
    route: interpolate(template.route, parameters),
    risk: interpolate(template.riskText, parameters),
    approval: interpolate(template.approval, parameters),
    source,
    category: template.category,
    actionType: template.actionType,
    templateTitle: template.title,
    ...(notes && { userNotes: notes }),
    parameters,
    fields: readableParams,
    safeguards: [...SHARED_SAFEGUARDS, ...template.safeguards],
  };
  return withGuardrailReport(plan, { templateId: template.id, prompt: notes || template.description });
}

export function aiProviderPresetById(id: string): AiProviderPreset {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? AI_PROVIDER_PRESETS[0]!;
}

export function aiFormatLabel(format: AiApiFormat): string {
  return format === 'anthropic' ? 'Anthropic Messages API' : 'OpenAI-compatible';
}

export function aiRouteDiagnosticForSettings(
  settings: Pick<AiSettings, 'mode' | 'provider' | 'model'>,
  route: { path: string; method?: string; origin?: string; bridgeBaseUrl?: string },
): AiDiagnosticEntry {
  const method = route.method ?? (settings.mode === 'session' ? undefined : 'POST');
  const model = settings.model.trim() || 'model configured';
  if (settings.mode === 'bridge') {
    return {
      code: 'AI_ROUTE',
      message: method === 'GET' ? 'Local bridge AI status route selected.' : 'Local bridge AI route selected.',
      detail: bridgeRouteDetail(route.bridgeBaseUrl, route.path),
      ...(method && { method }),
      path: route.path,
    };
  }
  if (settings.mode === 'session') {
    return {
      code: 'AI_ROUTE',
      message: 'Browser session AI route selected.',
      detail: `${settings.provider} ${model}`,
    };
  }
  return {
    code: 'AI_ROUTE',
    message: method === 'GET' ? 'Hosted BYOK status route selected.' : 'Hosted BYOK route selected.',
    detail: `${settings.provider} ${model}${route.origin ? ` on ${route.origin}` : ''}`,
    ...(method && { method }),
    path: route.path,
  };
}

export async function generateSessionAiPlan(
  settings: AiSettings,
  request: AiPlanRequest,
): Promise<AgentPlan> {
  const apiKey = normalizeAiApiKey(settings.apiKey);
  if (!apiKey) {
    throw new Error('Session AI key is required.');
  }
  assertAiApiKeyHeaderSafe(apiKey);
  assertAiDraftRequestAllowed(request);
  const normalizedSettings = { ...settings, apiKey };
  if (settings.provider === 'openai') {
    throw new Error('OpenAI keys cannot be called directly from browser session mode. Select Hosted BYOK or Local bridge.');
  }
  if (settings.apiFormat === 'anthropic') {
    return generateAnthropicPlan(normalizedSettings, request);
  }
  return generateOpenAiCompatiblePlan(normalizedSettings, request);
}

export async function generateSessionAiReview(
  settings: AiSettings,
  request: AgentPlanReviewRequest,
): Promise<AgentPlanReviewResult> {
  const apiKey = normalizeAiApiKey(settings.apiKey);
  if (!apiKey) {
    throw new Error('Session AI key is required.');
  }
  assertAiApiKeyHeaderSafe(apiKey);
  assertAiReviewRequestAllowed(request);
  const normalizedSettings = { ...settings, apiKey };
  if (settings.provider === 'openai') {
    throw new Error('OpenAI keys cannot be called directly from browser session mode. Select Hosted BYOK or Local bridge.');
  }
  if (settings.apiFormat === 'anthropic') {
    return generateAnthropicReview(normalizedSettings, request);
  }
  return generateOpenAiCompatibleReview(normalizedSettings, request);
}

export async function generateHostedAiPlan(
  settings: AiSettings,
  request: AiPlanRequest,
): Promise<AgentPlan> {
  const apiKey = normalizeAiApiKey(settings.apiKey);
  if (!apiKey) {
    throw new Error('Hosted BYOK key is required.');
  }
  assertAiApiKeyHeaderSafe(apiKey);
  assertAiDraftRequestAllowed(request);
  const diagnostics: AiDiagnosticEntry[] = [
    {
      code: 'AI_ROUTE',
      message: 'Hosted BYOK route selected.',
      detail: `provider=${settings.provider}; model=${settings.model.trim() || aiProviderPresetById(settings.provider).model}`,
      method: 'POST',
      path: '/api/ai/generate-plan',
    },
  ];
  await assertHostedAiAvailable(diagnostics);
  const response = await fetch('/api/ai/generate-plan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      settings: {
        apiKey,
        provider: settings.provider,
        apiFormat: settings.apiFormat,
        baseUrl: settings.baseUrl,
        model: settings.model,
      },
      request,
    }),
  }).catch((err) => {
    throw aiPlanConnectionError(
      `Hosted AI request failed. ${redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey)}`,
      diagnostics,
      {
        code: 'AI_PROVIDER_ERROR',
        message: 'Hosted BYOK request could not reach the same-origin API.',
        detail: redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey),
        method: 'POST',
        path: '/api/ai/generate-plan',
      },
    );
  });
  const payload = await readHostedJson(
    response,
    'Hosted BYOK API returned a non-JSON response. Serve Agentic through the Render Node service or use Local bridge.',
    diagnostics,
    { method: 'POST', path: '/api/ai/generate-plan' },
  );
  if (!response.ok) {
    const message = redactSecrets(extractProviderError(payload) || `Hosted AI returned HTTP ${response.status}.`, settings.apiKey);
    throw aiPlanConnectionError(message, diagnostics, {
      code: 'AI_PROVIDER_ERROR',
      message,
      method: 'POST',
      path: '/api/ai/generate-plan',
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
    });
  }
  diagnostics.push({
    code: 'AI_PLAN_READY',
    message: 'Hosted BYOK returned a valid AI plan.',
    method: 'POST',
    path: '/api/ai/generate-plan',
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
  });
  return normalizeHostedAiPlan(payload, request);
}

export async function generateHostedAiReview(
  settings: AiSettings,
  request: AgentPlanReviewRequest,
): Promise<AgentPlanReviewResult> {
  const apiKey = normalizeAiApiKey(settings.apiKey);
  if (!apiKey) {
    throw new Error('Hosted BYOK key is required.');
  }
  assertAiApiKeyHeaderSafe(apiKey);
  assertAiReviewRequestAllowed(request);
  const diagnostics: AiDiagnosticEntry[] = [
    {
      code: 'AI_ROUTE',
      message: 'Hosted BYOK review route selected.',
      detail: `provider=${settings.provider}; model=${settings.model.trim() || aiProviderPresetById(settings.provider).model}`,
      method: 'POST',
      path: '/api/ai/review-plan',
    },
  ];
  await assertHostedAiAvailable(diagnostics);
  const response = await fetch('/api/ai/review-plan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      settings: {
        apiKey,
        provider: settings.provider,
        apiFormat: settings.apiFormat,
        baseUrl: settings.baseUrl,
        model: settings.model,
      },
      request,
    }),
  }).catch((err) => {
    throw aiPlanConnectionError(
      `Hosted AI review request failed. ${redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey)}`,
      diagnostics,
      {
        code: 'AI_PROVIDER_ERROR',
        message: 'Hosted BYOK review request could not reach the same-origin API.',
        detail: redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey),
        method: 'POST',
        path: '/api/ai/review-plan',
      },
    );
  });
  const payload = await readHostedJson(
    response,
    'Hosted BYOK API returned a non-JSON response. Serve Agentic through the Render Node service or use Local bridge.',
    diagnostics,
    { method: 'POST', path: '/api/ai/review-plan' },
  );
  if (!response.ok) {
    const message = redactSecrets(extractProviderError(payload) || `Hosted AI returned HTTP ${response.status}.`, settings.apiKey);
    throw aiPlanConnectionError(message, diagnostics, {
      code: 'AI_PROVIDER_ERROR',
      message,
      method: 'POST',
      path: '/api/ai/review-plan',
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
    });
  }
  diagnostics.push({
    code: 'AI_PLAN_READY',
    message: 'Hosted BYOK returned a valid agent review.',
    method: 'POST',
    path: '/api/ai/review-plan',
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
  });
  return normalizeHostedAiReview(payload);
}

export async function generateSessionAiAsk(
  settings: AiSettings,
  request: AgentPlanAskRequest,
): Promise<AgentPlanAskResult> {
  const apiKey = normalizeAiApiKey(settings.apiKey);
  if (!apiKey) {
    throw new Error('Session AI key is required.');
  }
  assertAiApiKeyHeaderSafe(apiKey);
  if (!request.question?.trim()) {
    throw new Error('Ask agent: a question is required.');
  }
  const normalizedSettings = { ...settings, apiKey };
  if (settings.provider === 'openai') {
    throw new Error('OpenAI keys cannot be called directly from browser session mode. Select Hosted BYOK or Local bridge.');
  }
  if (settings.apiFormat === 'anthropic') {
    return generateAnthropicAsk(normalizedSettings, request);
  }
  return generateOpenAiCompatibleAsk(normalizedSettings, request);
}

export async function generateHostedAiAsk(
  settings: AiSettings,
  request: AgentPlanAskRequest,
): Promise<AgentPlanAskResult> {
  const apiKey = normalizeAiApiKey(settings.apiKey);
  if (!apiKey) {
    throw new Error('Hosted BYOK key is required.');
  }
  assertAiApiKeyHeaderSafe(apiKey);
  if (!request.question?.trim()) {
    throw new Error('Ask agent: a question is required.');
  }
  const diagnostics: AiDiagnosticEntry[] = [
    {
      code: 'AI_ROUTE',
      message: 'Hosted BYOK ask route selected.',
      detail: `provider=${settings.provider}; model=${settings.model.trim() || aiProviderPresetById(settings.provider).model}`,
      method: 'POST',
      path: '/api/ai/ask-about-plan',
    },
  ];
  await assertHostedAiAvailable(diagnostics);
  const response = await fetch('/api/ai/ask-about-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      settings: {
        apiKey,
        provider: settings.provider,
        apiFormat: settings.apiFormat,
        baseUrl: settings.baseUrl,
        model: settings.model,
      },
      request,
    }),
  }).catch((err) => {
    throw aiPlanConnectionError(
      `Hosted AI ask request failed. ${redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey)}`,
      diagnostics,
      {
        code: 'AI_PROVIDER_ERROR',
        message: 'Hosted BYOK ask request could not reach the same-origin API.',
        detail: redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey),
        method: 'POST',
        path: '/api/ai/ask-about-plan',
      },
    );
  });
  const payload = await readHostedJson(
    response,
    'Hosted BYOK API returned a non-JSON response.',
    diagnostics,
    { method: 'POST', path: '/api/ai/ask-about-plan' },
  );
  if (!response.ok) {
    const message = redactSecrets(extractProviderError(payload) || `Hosted AI returned HTTP ${response.status}.`, settings.apiKey);
    throw aiPlanConnectionError(message, diagnostics, {
      code: 'AI_PROVIDER_ERROR',
      message,
      method: 'POST',
      path: '/api/ai/ask-about-plan',
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
    });
  }
  return normalizeHostedAiAsk(payload);
}

export async function confirmHostedAiPlanner(settings: AiSettings): Promise<AiDiagnosticEntry[]> {
  const apiKey = normalizeAiApiKey(settings.apiKey);
  if (!apiKey) {
    throw new Error('Hosted BYOK key is required before confirming planner setup.');
  }
  assertAiApiKeyHeaderSafe(apiKey);
  if (settings.provider === 'custom-openai-compatible') {
    throw new Error('Hosted BYOK supports preset providers only. Use Local bridge or Browser Session for custom gateways.');
  }
  if (!settings.model.trim()) {
    throw new Error('Choose or enter an AI model before confirming planner setup.');
  }

  const diagnostics: AiDiagnosticEntry[] = [
    {
      code: 'AI_ROUTE',
      message: 'Hosted BYOK planner confirmation selected.',
      detail: `provider=${settings.provider}; model=${settings.model.trim() || aiProviderPresetById(settings.provider).model}`,
      method: 'GET',
      path: '/api/ai/status',
    },
  ];
  await assertHostedAiAvailable(diagnostics);
  diagnostics.push({
    code: 'AI_PLAN_READY',
    message: 'Hosted BYOK planner route confirmed. No plan was generated.',
    detail: 'Provider key is used only when creating an AI draft; workflow approvals remain separate.',
    method: 'GET',
    path: '/api/ai/status',
  });
  return diagnostics.map(redactAiDiagnostic);
}

async function assertHostedAiAvailable(diagnostics: AiDiagnosticEntry[]): Promise<void> {
  const response = await fetch('/api/ai/status', {
    headers: {
      accept: 'application/json',
    },
  }).catch((err) => {
    throw aiPlanConnectionError(
      `Hosted BYOK API is not reachable on this origin. Serve Agentic through the Render Node service or use Local bridge. ${err instanceof Error ? err.message : String(err)}`,
      diagnostics,
      {
        code: 'AI_PROVIDER_ERROR',
        message: 'Hosted BYOK status request failed before a response was returned.',
        detail: err instanceof Error ? err.message : String(err),
        method: 'GET',
        path: '/api/ai/status',
      },
    );
  });
  const payload = await readHostedJson(
    response,
    'Hosted BYOK API is not available on this origin. Serve Agentic through the Render Node service or use Local bridge.',
    diagnostics,
    { method: 'GET', path: '/api/ai/status' },
  );
  if (!response.ok || !isHostedAiStatusPayload(payload)) {
    throw aiPlanConnectionError(
      'Hosted BYOK API is not available on this origin. Serve Agentic through the Render Node service or use Local bridge.',
      diagnostics,
      {
        code: 'AI_PROVIDER_ERROR',
        message: 'Hosted BYOK status response was not the expected hosted-byok JSON.',
        method: 'GET',
        path: '/api/ai/status',
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
      },
    );
  }
}

function isHostedAiStatusPayload(payload: unknown): payload is { available: boolean; mode: string } {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  return record.available === true && record.mode === 'hosted-byok';
}

async function readHostedJson(
  response: Response,
  fallbackMessage: string,
  diagnostics: AiDiagnosticEntry[],
  request: { method: string; path: string },
): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  diagnostics.push({
    code: 'AI_HTTP',
    message: `${request.method} ${request.path} returned HTTP ${response.status}.`,
    method: request.method,
    path: request.path,
    status: response.status,
    contentType,
  });
  const raw = await response.text().catch(() => '');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (looksLikeHtmlResponse(raw, contentType)) {
      throw aiPlanConnectionError(hostedApiRoutedToFrontendMessage(request.path, response.status, contentType), diagnostics, {
        code: 'AI_ROUTE_MISMATCH',
        message: 'Hosted AI API routed to frontend shell.',
        detail: `${request.path} returned HTML instead of hosted BYOK JSON.`,
        method: request.method,
        path: request.path,
        status: response.status,
        contentType,
      });
    }
    throw aiPlanConnectionError(fallbackMessage, diagnostics, {
      code: 'AI_CONTENT_TYPE',
      message: 'Hosted BYOK API returned a non-JSON response.',
      method: request.method,
      path: request.path,
      status: response.status,
      contentType,
    });
  }
}

function looksLikeHtmlResponse(raw: string, contentType: string): boolean {
  return /text\/html/i.test(contentType) || /^\s*<!doctype\s+html/i.test(raw) || /^\s*<html[\s>]/i.test(raw);
}

function hostedApiRoutedToFrontendMessage(path: string, status: number, contentType: string): string {
  const type = contentType || 'unknown content-type';
  return `Hosted AI API routed to frontend shell. ${path} returned HTTP ${status} ${type} instead of JSON. Redeploy Render as the Node web service.`;
}

function aiPlanConnectionError(
  message: string,
  diagnostics: AiDiagnosticEntry[],
  entry: AiDiagnosticEntry,
): AiPlanConnectionError {
  return new AiPlanConnectionError(message, [...diagnostics, entry]);
}

function redactAiDiagnostic(entry: AiDiagnosticEntry): AiDiagnosticEntry {
  return {
    ...entry,
    message: redactSecrets(entry.message),
    ...(entry.detail !== undefined && { detail: redactSecrets(entry.detail) }),
    ...(entry.contentType !== undefined && { contentType: redactSecrets(entry.contentType) }),
  };
}

export function aiDiagnosticsFromError(err: unknown): AiDiagnosticEntry[] {
  if (err instanceof AiPlanConnectionError) {
    return err.diagnostics;
  }
  if (err && typeof err === 'object' && 'diagnostics' in err) {
    const diagnostics = (err as { diagnostics?: unknown }).diagnostics;
    if (Array.isArray(diagnostics)) {
      return diagnostics.filter(isAiDiagnosticEntry).map(redactAiDiagnostic);
    }
  }
  return [];
}

function isAiDiagnosticEntry(value: unknown): value is AiDiagnosticEntry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AiDiagnosticEntry>;
  return typeof record.code === 'string' && typeof record.message === 'string';
}

async function generateOpenAiCompatiblePlan(settings: AiSettings, request: AiPlanRequest): Promise<AgentPlan> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl, 'openai-compatible');
  const body = {
    model: settings.model.trim() || DEFAULT_AI_MODEL,
    response_format: { type: 'json_object' },
    messages: aiMessages(request),
    ...(!isDefaultTemperatureOnlyModel(settings.model.trim() || DEFAULT_AI_MODEL) && { temperature: 0.2 }),
  };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.apiKey.trim()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch((err) => {
    throw new Error(
      `AI provider request failed. Use the local bridge or a browser-compatible gateway. ${redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey)}`,
    );
  });

  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(providerFailureMessage(payload, response.status, settings.apiKey));
  }
  return normalizeAiPlan(payload, request);
}

async function generateOpenAiCompatibleReview(settings: AiSettings, request: AgentPlanReviewRequest): Promise<AgentPlanReviewResult> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl, 'openai-compatible');
  const body = {
    model: settings.model.trim() || DEFAULT_AI_MODEL,
    response_format: { type: 'json_object' },
    messages: aiReviewMessages(request),
    ...(!isDefaultTemperatureOnlyModel(settings.model.trim() || DEFAULT_AI_MODEL) && { temperature: 0.2 }),
  };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.apiKey.trim()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch((err) => {
    throw new Error(
      `AI provider review failed. Use the local bridge or a browser-compatible gateway. ${redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey)}`,
    );
  });

  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(providerFailureMessage(payload, response.status, settings.apiKey));
  }
  return normalizeAiReview(payload, request);
}

async function generateOpenAiCompatibleAsk(settings: AiSettings, request: AgentPlanAskRequest): Promise<AgentPlanAskResult> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl, 'openai-compatible');
  const body = {
    model: settings.model.trim() || DEFAULT_AI_MODEL,
    messages: aiAskMessages(request),
    ...(!isDefaultTemperatureOnlyModel(settings.model.trim() || DEFAULT_AI_MODEL) && { temperature: 0.3 }),
  };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.apiKey.trim()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch((err) => {
    throw new Error(
      `AI provider ask failed. ${redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey)}`,
    );
  });
  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(providerFailureMessage(payload, response.status, settings.apiKey));
  }
  return normalizeAiAsk(payload);
}

async function generateAnthropicAsk(settings: AiSettings, request: AgentPlanAskRequest): Promise<AgentPlanAskResult> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl, 'anthropic');
  const messages = aiAskMessages(request);
  const systemMessage = messages[0]?.content ?? '';
  const userMessage = messages[1]?.content ?? JSON.stringify(request);
  const response = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': settings.apiKey.trim(),
    },
    body: JSON.stringify({
      model: settings.model.trim() || aiProviderPresetById('anthropic').model,
      max_tokens: 800,
      system: systemMessage,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.3,
    }),
  }).catch((err) => {
    throw new Error(
      `AI provider ask failed. ${redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey)}`,
    );
  });
  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(providerFailureMessage(payload, response.status, settings.apiKey));
  }
  return normalizeAiAsk(payload);
}

export function aiAskMessages(request: AgentPlanAskRequest): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You answer the user\'s question about a Solana wallet action plan. Be concise: 1 to 3 sentences, plain English. Cite plan fields you reference by name (e.g., recipient, amount, slippageBps). Never claim anything is signed, submitted, guaranteed safe, or already approved. Never request private keys. If the question cannot be answered from the plan, say so plainly.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: request.question,
        plan: request.plan,
        walletAddress: request.walletAddress || 'not_connected',
        cluster: request.cluster || 'unknown',
        context: request.context ?? {},
        requiredBoundary: 'This is conversational Q&A about a draft. It cannot sign or submit a transaction.',
      }),
    },
  ];
}

export function normalizeAiAsk(payload: unknown): AgentPlanAskResult {
  const text = extractModelText(payload).trim();
  if (!text) {
    throw new Error('Agent did not return an answer.');
  }
  return {
    answer: compactReviewText(text, 800),
    checkedAt: new Date().toISOString(),
    source: 'ai',
  };
}

function normalizeHostedAiAsk(payload: unknown): AgentPlanAskResult {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Hosted AI returned an invalid ask response.');
  }
  const record = payload as Partial<AgentPlanAskResult>;
  const answer = typeof record.answer === 'string' ? record.answer.trim() : '';
  if (!answer) {
    throw new Error('Hosted AI returned an empty answer.');
  }
  return {
    answer: compactReviewText(answer, 800),
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : new Date().toISOString(),
    source: 'ai',
  };
}

function normalizeHostedAiPlan(payload: unknown, request: AiPlanRequest): AgentPlan {
  if (!isHostedPlanPayload(payload)) {
    throw new Error('Hosted AI returned an invalid plan.');
  }
  const record = payload as Partial<AgentPlan>;
  const fields = Array.isArray(record.fields)
    ? record.fields.filter((field): field is AgentPlanField => (
        Boolean(field) &&
        typeof field === 'object' &&
        typeof field.label === 'string' &&
        typeof field.value === 'string'
      ))
    : Object.entries(request.parameters)
        .filter(([, value]) => value.trim().length > 0)
        .map(([key, value]) => ({ label: titleCase(key), value }));
  const safeguards = Array.isArray(record.safeguards)
    ? record.safeguards.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : SHARED_SAFEGUARDS;
  const plan: AgentPlan = {
    intent: stringOr(record.intent, `${request.template.title}: ${request.prompt}`),
    route: stringOr(record.route, `Prepare ${request.template.actionType} request and show route details before wallet approval.`),
    risk: stringOr(record.risk, `Risk level ${request.template.risk}. Verify all visible fields before signing.`),
    approval: stringOr(record.approval, 'Wallet approval remains a separate explicit user action.'),
    source: 'ai',
    category: stringOr(record.category, request.template.category),
    actionType: stringOr(record.actionType, request.template.actionType),
    templateTitle: stringOr(record.templateTitle, request.template.title),
    userNotes: typeof record.userNotes === 'string' ? record.userNotes : request.userNotes,
    parameters: record.parameters && typeof record.parameters === 'object' ? record.parameters : request.parameters,
    fields,
    safeguards,
  };
  return withGuardrailReport(plan, {
    templateId: request.template.id,
    prompt: request.prompt,
  });
}

function isHostedPlanPayload(payload: unknown): payload is Partial<AgentPlan> {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Partial<AgentPlan>;
  return (
    record.source === 'ai' &&
    typeof record.intent === 'string' &&
    typeof record.route === 'string' &&
    typeof record.risk === 'string' &&
    typeof record.approval === 'string'
  );
}

function normalizeHostedAiReview(payload: unknown): AgentPlanReviewResult {
  if (!isHostedReviewPayload(payload)) {
    throw new Error('Hosted AI returned an invalid agent review.');
  }
  const record = payload as Partial<AgentPlanReviewResult>;
  const decision = normalizeReviewDecision(record.decision);
  const questions = normalizeReviewQuestions((record as Record<string, unknown>).questions);
  return {
    decision,
    reason: compactReviewText(stringOr(record.reason, 'Agent review did not return a reason.'), 280),
    summary: compactReviewText(stringOr(record.summary, record.reason ?? 'Agent review completed.'), 160),
    evidence: jsonObjectOr(record.evidence, {}),
    checkedAt: stringOr(record.checkedAt, new Date().toISOString()),
    source: 'ai',
    ...(questions ? { questions } : {}),
  };
}

function isHostedReviewPayload(payload: unknown): payload is Partial<AgentPlanReviewResult> {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Partial<AgentPlanReviewResult>;
  return (
    (record.decision === 'approve' || record.decision === 'deny' || record.decision === 'needs_input') &&
    typeof record.reason === 'string'
  );
}

async function generateAnthropicPlan(settings: AiSettings, request: AiPlanRequest): Promise<AgentPlan> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl, 'anthropic');
  const messages = aiMessages(request);
  const systemMessage = messages[0]?.content ?? '';
  const userMessage = messages[1]?.content ?? JSON.stringify(request);
  const response = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': settings.apiKey.trim(),
    },
    body: JSON.stringify({
      model: settings.model.trim() || aiProviderPresetById('anthropic').model,
      max_tokens: 1024,
      system: systemMessage,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.2,
    }),
  }).catch((err) => {
    throw new Error(
      `AI provider request failed. Use the local bridge or a browser-compatible gateway. ${redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey)}`,
    );
  });

  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(providerFailureMessage(payload, response.status, settings.apiKey));
  }
  return normalizeAiPlan(payload, request);
}

async function generateAnthropicReview(settings: AiSettings, request: AgentPlanReviewRequest): Promise<AgentPlanReviewResult> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl, 'anthropic');
  const messages = aiReviewMessages(request);
  const systemMessage = messages[0]?.content ?? '';
  const userMessage = messages[1]?.content ?? JSON.stringify(request);
  const response = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': settings.apiKey.trim(),
    },
    body: JSON.stringify({
      model: settings.model.trim() || aiProviderPresetById('anthropic').model,
      max_tokens: 1024,
      system: systemMessage,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.2,
    }),
  }).catch((err) => {
    throw new Error(
      `AI provider review failed. Use the local bridge or a browser-compatible gateway. ${redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey)}`,
    );
  });

  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(providerFailureMessage(payload, response.status, settings.apiKey));
  }
  return normalizeAiReview(payload, request);
}

export function aiMessages(request: AiPlanRequest): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You convert Solana wallet user requests into structured approval plans. Return only JSON with string fields intent, route, risk, approval, and safeguards as an array of short strings. Never claim a transaction is signed, submitted, approved, or safe. Never request private keys. The wallet user must approve separately.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        userPrompt: request.prompt,
        userNotes: request.userNotes,
        template: request.template,
        parameters: request.parameters,
        protocolConnectors: request.connectorContext ?? [],
        connectorRule: 'Only propose first-class or Blink executable actions for enabled connectors with matching capabilities. If a requested protocol/action is not present, make the plan proof/read-only and state what connector fact or action URL is missing.',
        requiredBoundary: 'AI prepares a plan only. Wallet approval and signing happen later in the user wallet.',
      }),
    },
  ];
}

export function aiReviewMessages(request: AgentPlanReviewRequest): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You review a Solana wallet action draft before it is sent for wallet approval. Return only JSON with: decision ("approve", "deny", or "needs_input"); reason as one or two concise sentences; summary as one short sentence; evidence as an object. When you cannot decide because user intent is genuinely ambiguous, return decision "needs_input" plus a "questions" array with 1-3 short, specific questions answerable in under 20 words. Each question is an object with id (short slug), prompt (the question text), inputKind ("text" | "select" | "number"), and required (true/false). Use "needs_input" only when the missing information is something the user must supply, such as a missing amount, missing token, or missing recipient. Do not use "needs_input" for facts that are present in the plan, context.facts, context.executionPath, or facts you can infer. For browser swap drafts, Jupiter is the execution aggregator unless context says otherwise; do not ask the user which DEX/protocol will execute it. If a token mint address is present, review that mint address; do not ask the user what token it is or whether they verified it. If token metadata is missing, return approve or deny with a warning, not needs_input. If the context includes "userPolicies", treat each as a soft rule the user wants you to honor: factor them into your decision and cite the relevant policy id in evidence.policiesApplied when one influences the outcome. Be flexible: use the user instruction and available facts, not a fixed checklist. Never claim anything is signed, submitted, guaranteed safe, or already approved. Never request private keys. The wallet user must still approve separately.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: request.instruction?.trim() || 'Review this draft before it is sent for wallet approval. Decide approve, deny, or needs_input.',
        walletAddress: request.walletAddress || 'not_connected',
        cluster: request.cluster || 'unknown',
        plan: request.plan,
        context: request.context ?? {},
        requiredBoundary: 'This AI review can approve, deny, or request more input. It cannot sign or submit a transaction.',
      }),
    },
  ];
}

export function normalizeAiPlan(payload: unknown, request: AiPlanRequest): AgentPlan {
  const content = extractModelText(payload);
  const parsed = parsePlanJson(content);
  const template = templateById(request.template.id);
  const fallback = buildTemplatePlan(template, request.parameters, 'ai');
  const plan: AgentPlan = {
    ...fallback,
    intent: stringOr(parsed.intent, fallback.intent),
    route: stringOr(parsed.route, fallback.route),
    risk: stringOr(parsed.risk, fallback.risk),
    approval: stringOr(parsed.approval, fallback.approval),
    source: 'ai',
    userNotes: request.userNotes?.trim() || request.prompt.trim() || undefined,
    safeguards: normalizeSafeguards(parsed.safeguards, fallback.safeguards),
  };
  return withGuardrailReport(plan, {
    templateId: template.id,
    prompt: request.prompt,
  });
}

export function normalizeAiReview(payload: unknown, request: AgentPlanReviewRequest): AgentPlanReviewResult {
  const content = extractModelText(payload);
  const parsed = parsePlanJson(content);
  const decision = normalizeReviewDecision(parsed.decision);
  const questions = normalizeReviewQuestions(parsed.questions);
  const reason = stringOr(
    parsed.reason,
    decision === 'approve'
      ? 'Approved by the configured agent review. Wallet approval is still required before anything signs.'
      : decision === 'needs_input'
        ? 'Agent needs clarifying answers before deciding. Answer the questions or send anyway.'
        : 'Denied by the configured agent review. Review the draft or ask the agent again.',
  );
  return {
    decision,
    reason: compactReviewText(reason, 280),
    summary: compactReviewText(stringOr(parsed.summary, reason), 160),
    evidence: jsonObjectOr(parsed.evidence, {
      actionType: request.plan.actionType,
      templateTitle: request.plan.templateTitle,
    }),
    checkedAt: new Date().toISOString(),
    source: 'ai',
    ...(questions ? { questions } : {}),
  };
}

function assertAiDraftRequestAllowed(request: AiPlanRequest): void {
  assertPlanGuardrails({
    source: 'ai',
    category: request.template.category,
    actionType: request.template.actionType,
    templateId: request.template.id,
    templateTitle: request.template.title,
    parameters: request.parameters,
    userNotes: request.userNotes,
    prompt: request.prompt,
    plan: {
      source: 'ai',
      category: request.template.category,
      actionType: request.template.actionType,
      templateId: request.template.id,
      templateTitle: request.template.title,
      parameters: request.parameters,
      prompt: request.prompt,
      userNotes: request.userNotes,
      intent: request.prompt,
      route: 'AI draft only. Wallet approval is required later.',
      risk: `Requested risk level ${request.template.risk}.`,
      approval: 'Wallet approval is required before signing or submitting.',
    },
  });
}

function assertAiReviewRequestAllowed(request: AgentPlanReviewRequest): void {
  assertPlanGuardrails({
    plan: {
      ...request.plan,
      reviewInstruction: request.instruction,
      reviewContext: request.context,
    },
    source: request.plan.source,
    category: request.plan.category,
    actionType: request.plan.actionType,
    templateTitle: request.plan.templateTitle,
    parameters: request.plan.parameters,
    fields: request.plan.fields,
    userNotes: request.plan.userNotes,
    prompt: request.instruction,
  });
}

function withGuardrailReport(
  plan: AgentPlan,
  context: { templateId?: string; prompt?: string } = {},
): AgentPlan {
  const report = assertPlanGuardrails({
    plan: { ...plan },
    source: plan.source,
    category: plan.category,
    actionType: plan.actionType,
    templateId: context.templateId,
    templateTitle: plan.templateTitle,
    parameters: plan.parameters,
    fields: plan.fields,
    userNotes: plan.userNotes,
    prompt: context.prompt,
  });
  return {
    ...plan,
    guardrailReport: report,
    constraintFingerprint: report.constraintFingerprint,
    ...(report.constraintHash ? { constraintHash: report.constraintHash } : {}),
  };
}

export function redactSecrets(value: string, exactSecret = ''): string {
  const secret = exactSecret.trim();
  const normalizedSecret = secret ? normalizeAiApiKey(secret) : '';
  const exactRedacted = [secret, normalizedSecret]
    .filter((entry, index, entries) => entry && entries.indexOf(entry) === index)
    .reduce((current, entry) => current.split(entry).join('[redacted]'), value);
  return exactRedacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-proj-[A-Za-z0-9_-]{8,}\b/g, 'sk-proj-[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/(api[-_ ]?key|token|secret)(["':=\s]+)([^"',\s]{8,})/gi, '$1$2[redacted]');
}

export function normalizeAiApiKey(value: string): string {
  return value.replace(AI_KEY_COPY_PASTE_ARTIFACTS, '');
}

function assertAiApiKeyHeaderSafe(value: string): void {
  const invalid = firstInvalidAiApiKeyCharacter(value);
  if (!invalid) return;
  throw new Error(
    `AI API key contains unsupported characters at index ${invalid.index}. Paste the key again as plain text and remove hidden separators or non-ASCII characters.`,
  );
}

function firstInvalidAiApiKeyCharacter(value: string): { index: number; codePoint: number } | null {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) continue;
    if (codePoint < 0x21 || codePoint > 0x7e) {
      return { index, codePoint };
    }
    if (codePoint > 0xffff) {
      index += 1;
    }
  }
  return null;
}

function template(
  category: string,
  id: string,
  title: string,
  description: string,
  actionType: string,
  risk: TemplateRisk,
  fields: AgentPlanTemplateField[],
): AgentPlanTemplate {
  return {
    id,
    category,
    title,
    description,
    actionType,
    risk,
    route: routeFor(actionType),
    riskText: riskTextFor(risk),
    approval: approvalFor(actionType),
    safeguards: safeguardsFor(actionType, risk),
    requiresWallet: actionType !== 'read_only',
    requiresBridge: ['transfer_sol', 'transfer_spl', 'swap', 'recurring_payment'].includes(actionType),
    fields,
    prompt: description,
  };
}

function field(
  id: string,
  label: string,
  placeholder = '',
  defaultValue = '',
  required = false,
): AgentPlanTemplateField {
  return { id, label, placeholder, defaultValue, required, type: 'text' };
}

function textareaField(id: string, label: string, placeholder = '', defaultValue = ''): AgentPlanTemplateField {
  return { id, label, placeholder, defaultValue, type: 'textarea' };
}

function selectField(id: string, label: string, options: string[], defaultValue: string): AgentPlanTemplateField {
  return { id, label, options, defaultValue, type: 'select' };
}

function routeFor(actionType: string): string {
  switch (actionType) {
    case 'transfer_sol':
      return 'Prepare a SOL transfer to {recipient} for {amount} SOL. Queue through the local bridge when connected.';
    case 'transfer_spl':
      return 'Prepare a {token} transfer to {recipient} for {amount}. Queue through the local bridge when connected.';
    case 'swap':
      return 'Prepare a {inputToken} to {outputToken} swap review before signing. Amount: {amount}. Max slippage bps: {slippageBps}. Do not submit anything until the wallet owner approves.';
    case 'recurring_payment':
      return 'Create a recurring review item for {amount} {token} on {cadence}. Every occurrence still requires wallet approval.';
    case 'read_only':
      return 'Read or review wallet context only. No transaction should be produced unless the user creates a separate approval.';
    default:
      return 'Prepare the request, expose the route and policy checks, then require a separate wallet approval before signing.';
  }
}

function riskTextFor(risk: TemplateRisk): string {
  switch (risk) {
    case 'low':
      return 'Low signing risk. This is read-only or proof-oriented unless the user later creates a wallet action.';
    case 'medium':
      return 'Medium signing risk. Verify recipient, amount, network, fees, route, and memo before approving.';
    case 'high':
      return 'High signing risk. Require simulation, touched-program review, authority-delta review, and explicit user confirmation.';
  }
}

function approvalFor(actionType: string): string {
  switch (actionType) {
    case 'read_only':
      return 'No wallet signature is required unless the user chooses to sign an audit proof.';
    case 'manual_review':
      return 'Wallet can sign an off-chain review proof after the user reviews the structured draft.';
    default:
      return 'AI prepares the review item only. The wallet owner reviews the visible action and approves the final signature.';
  }
}

function safeguardsFor(actionType: string, risk: TemplateRisk): string[] {
  const safeguards = [
    'Reject any request that asks for a private key, seed phrase, unlimited approval, or hidden delegation.',
  ];
  if (risk === 'high') {
    safeguards.push('Treat unknown programs, authority changes, and mismatched transaction semantics as blockers.');
  }
  if (actionType === 'swap') {
    safeguards.push('Confirm quote, output token, route, and slippage cap before signing.');
  }
  if (actionType.includes('transfer')) {
    safeguards.push('Confirm recipient address and amount character by character before signing.');
  }
  return safeguards;
}

function readableParameters(template: AgentPlanTemplate, parameters: Record<string, string>): AgentPlanField[] {
  return template.fields
    .map((fieldDef) => ({
      label: fieldDef.label,
      value: fieldDef.id === 'slippageBps'
        ? formatSlippageBpsForDisplay(parameters[fieldDef.id] ?? '')
        : (parameters[fieldDef.id] ?? '').trim(),
    }))
    .filter((entry) => entry.value.length > 0);
}

function interpolate(template: string, parameters: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = parameters[key]?.trim();
    if (key === 'slippageBps') {
      const formatted = formatSlippageBpsForDisplay(value ?? '');
      return formatted || titleCase(key);
    }
    return value || titleCase(key);
  });
}

function formatSlippageBpsForDisplay(value: string): string {
  const bps = Number(value);
  if (!Number.isFinite(bps) || bps <= 0) return value.trim();
  const percent = bps / 100;
  const formatted = Number.isInteger(percent)
    ? String(percent)
    : percent.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `${formatted}%`;
}

function normalizeBaseUrl(baseUrl: string, format: AiApiFormat): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return aiProviderPresetById(format === 'anthropic' ? 'anthropic' : DEFAULT_AI_PROVIDER_ID).baseUrl;
  if (format === 'anthropic') {
    return /\/v\d+(\/|$)/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }
  if (/\/v\d+(beta)?(\/|$)/i.test(trimmed) || /\/openai$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

function bridgeRouteDetail(bridgeBaseUrl: string | undefined, path: string): string {
  const base = bridgeBaseUrl?.trim().replace(/\/+$/, '');
  return base ? `${base}${path.startsWith('/') ? path : `/${path}`}` : path;
}

function extractProviderError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    return typeof message === 'string' ? message : '';
  }
  return '';
}

function providerFailureMessage(payload: unknown, status: number, exactSecret = ''): string {
  const message = extractProviderError(payload) || `AI provider returned HTTP ${status}.`;
  if (/unsupported value:\s*['"]?temperature/i.test(message) || /temperature.*only the default/i.test(message)) {
    return redactSecrets(`Model does not support one of Agentic's request parameters. ${message}`, exactSecret);
  }
  return redactSecrets(message, exactSecret);
}

function isDefaultTemperatureOnlyModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.startsWith('gpt-5') ||
    normalized.includes('/gpt-5') ||
    /^o\d/.test(normalized) ||
    normalized.startsWith('o-') ||
    normalized.includes('/o1') ||
    normalized.includes('/o3') ||
    normalized.includes('/o4')
  );
}

function extractModelText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const outputText = record.output_text;
  if (typeof outputText === 'string') return outputText;
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        const value = (entry as Record<string, unknown>).text;
        return typeof value === 'string' ? value : '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  const choices = record.choices;
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (first && typeof first === 'object') {
      const message = (first as Record<string, unknown>).message;
      if (message && typeof message === 'object') {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === 'string') return content;
      }
      const text = (first as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
    }
  }
  return JSON.stringify(payload);
}

function parsePlanJson(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const json = trimmed.startsWith('{')
    ? trimmed
    : trimmed.slice(Math.max(0, trimmed.indexOf('{')), trimmed.lastIndexOf('}') + 1);
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeReviewDecision(value: unknown): AgentPlanReviewDecision {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['approve', 'approved', 'allow', 'allowed', 'pass', 'passed', 'ok'].includes(normalized)) {
    return 'approve';
  }
  if (['needs_input', 'needs-input', 'need_input', 'need-input', 'ask', 'clarify', 'needs_clarification'].includes(normalized)) {
    return 'needs_input';
  }
  return 'deny';
}

function normalizeReviewQuestions(value: unknown): AgentReviewQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions: AgentReviewQuestion[] = [];
  for (let index = 0; index < value.length && questions.length < 3; index += 1) {
    const entry = value[index];
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const prompt = typeof record.prompt === 'string'
      ? record.prompt
      : typeof record.question === 'string'
        ? record.question
        : '';
    if (!prompt.trim()) continue;
    const inputKind = record.inputKind === 'select' || record.inputKind === 'number'
      ? record.inputKind
      : 'text';
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim()
      : `q${questions.length + 1}`;
    const options = Array.isArray(record.options)
      ? record.options.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 8)
      : undefined;
    const hint = typeof record.hint === 'string' && record.hint.trim() ? record.hint.trim() : undefined;
    questions.push({
      id,
      prompt: compactReviewText(prompt, 200),
      inputKind: inputKind as AgentReviewQuestion['inputKind'],
      required: record.required !== false,
      ...(options?.length ? { options } : {}),
      ...(hint ? { hint } : {}),
    });
  }
  return questions.length ? questions : undefined;
}

function jsonObjectOr(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return fallback;
}

function compactReviewText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function normalizeSafeguards(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return entries.length ? [...SHARED_SAFEGUARDS, ...entries.slice(0, 8)] : fallback;
}

function titleCase(value: string): string {
  return value
    .replace(/([A-Z])/g, ' $1')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
