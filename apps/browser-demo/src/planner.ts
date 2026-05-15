import {
  appendReviewFinding,
  assertPlanGuardrails,
  formatDollar,
  reconcileThresholdReviewDecision,
} from '@solana-agent-wallet-adapter/workflow';
import type {
  AgentPlan,
  AgentPlanAskRequest,
  AgentPlanAskResult,
  AgentPlanField,
  AgentPlanReviewDecision,
  AgentPlanReviewMode,
  AgentPlanReviewRequest,
  AgentPlanReviewResult,
  AgentPlanSource,
  AgentPlanTemplate,
  AgentPlanTemplateField,
  AgentReviewQuestion,
  AgentReviewerEntry,
  AiPlanRequest,
  TemplateRisk,
} from '@solana-agent-wallet-adapter/workflow';
import { PROTOCOL_CONNECTORS } from './connectedDapps.js';
import {
  connectorActionFormTemplateActionType,
  connectorActionFormsForConnector,
  formTemplateFields,
} from './connectorDrafting.js';

export type {
  AgentPlan,
  AgentPlanAskRequest,
  AgentPlanAskResult,
  AgentPlanField,
  AgentPlanReviewDecision,
  AgentPlanReviewMode,
  AgentPlanReviewRequest,
  AgentPlanReviewResult,
  AgentPlanSource,
  AgentPlanTemplate,
  AgentPlanTemplateField,
  AgentReviewQuestion,
  AgentReviewerEntry,
  AiPlanRequest,
  TemplateRisk,
} from '@solana-agent-wallet-adapter/workflow';

export type AiApiFormat = 'openai-compatible' | 'anthropic';
export type AiProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'custom-openai-compatible';

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

export interface AiRequestOptions {
  signal?: AbortSignal;
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

const RESEARCH_MAX_USES = 3;
const RESEARCH_SOURCE_POLICY = [
  'Prefer official vendor, product, support, pricing, documentation, regulator, or primary-source pages over blogs and aggregators.',
  'When the request mentions Helium Mobile, official Helium domains include hellohelium.com, support.hellohelium.com, and heliummobile.com.',
  'Third-party sources may support context but should not override an official current pricing or policy source.',
].join(' ');
const AI_KEY_COPY_PASTE_ARTIFACTS = /[\s\u200B-\u200D\u2060\uFEFF]+/gu;

interface AgentReviewResearchEvidence {
  status: 'checked';
  required: true;
  provider: string;
  checkedAt: string;
  summary: string;
  sources: Array<{ title?: string; url: string }>;
  sourcePolicy: string;
}

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
  tokenRateLabel?: string;
  tokensPerMinute?: number;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    detail: 'GPT models through Agentic hosted or local bridge calls.',
    apiFormat: 'openai-compatible',
    baseUrl: DEFAULT_AI_BASE_URL,
    model: 'gpt-5.5',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5.4', label: 'GPT-5.4', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: DEFAULT_AI_MODEL, label: 'GPT-5', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5.2', label: 'GPT-5.2', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5.1', label: 'GPT-5.1', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5-mini', label: 'GPT-5 mini', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', tokenRateLabel: '200K', tokensPerMinute: 200_000 },
      { id: 'gpt-5-nano', label: 'GPT-5 nano', tokenRateLabel: '200K', tokensPerMinute: 200_000 },
      { id: 'gpt-4.1', label: 'GPT-4.1', tokenRateLabel: '30K', tokensPerMinute: 30_000 },
    ],
  },
  {
    id: 'anthropic',
    label: 'Claude / Anthropic',
    detail: 'Claude models through the Anthropic Messages API.',
    apiFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-opus-4-1-20250805',
    models: [
      { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1', tokenRateLabel: '500K', tokensPerMinute: 500_000 },
      { id: 'claude-3-5-haiku-20241022', label: 'Claude Haiku 3.5', tokenRateLabel: '50K', tokensPerMinute: 50_000 },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tokenRateLabel: '30K', tokensPerMinute: 30_000 },
      { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 snapshot', tokenRateLabel: '30K', tokensPerMinute: 30_000 },
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', tokenRateLabel: '30K', tokensPerMinute: 30_000 },
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    detail: 'Google Gemini through its OpenAI-compatible endpoint.',
    apiFormat: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash-lite',
    models: [
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', tokenRateLabel: '4M', tokensPerMinute: 4_000_000 },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', tokenRateLabel: '4M', tokensPerMinute: 4_000_000 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tokenRateLabel: '2M', tokensPerMinute: 2_000_000 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tokenRateLabel: '1M', tokensPerMinute: 1_000_000 },
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

const BASE_AGENT_PLAN_TEMPLATES: AgentPlanTemplate[] = [
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
  ], { connectorCapability: 'first_class_adapter', connectorActionSource: 'first-class-adapter' }),
  template('defi', 'kamino-withdraw', 'Kamino withdraw', 'Redeem some or all of a Kamino Lend supply position. Requires Kamino enabled in Protocol Connectors.', 'kamino_withdraw', 'medium', [
    selectField('token', 'Token', ['SOL', 'USDC', 'JitoSOL', 'mSOL', 'bSOL'], 'SOL'),
    field('amount', 'Amount (or "all")', '0.05', '0.05'),
    field('memo', 'Reason', 'Need liquidity for payments', 'Kamino withdraw review'),
  ], { connectorCapability: 'first_class_adapter', connectorActionSource: 'first-class-adapter' }),
  template('defi', 'kamino-earnings-proof', 'Kamino earnings proof', "Build a signable receipt that proves how much you've earned by supplying to Kamino. Read-only; signing creates a shareable verification.", 'read_only', 'low', [
    selectField('token', 'Reserve', ['All reserves', 'SOL', 'USDC', 'JitoSOL', 'mSOL', 'bSOL'], 'All reserves'),
    field('memo', 'Reason', 'Tax / accounting record', 'Kamino earnings receipt'),
  ], { connectorCapability: 'first_class_adapter', connectorActionSource: 'first-class-adapter' }),
  template('defi', 'drift-vault-deposit', 'Drift vault deposit', "Deposit a token into a Drift strategy vault. Prepares wallet approval work only and does not sign. Requires Drift Vaults enabled in Protocol Connectors. V1 covers vault deposit/withdraw lifecycle only; no perp or spot order placement.", 'drift_vault_deposit', 'medium', [
    field('vaultAddress', 'Vault address', 'Drift vault account address', '', true),
    field('amount', 'Amount', '25', '25', true),
    field('mint', 'Deposit mint (optional)', 'Vault deposit mint address', ''),
    selectField('initializeDepositorIfMissing', 'Create depositor if missing', ['yes', 'no'], 'yes'),
    field('memo', 'Reason', 'Earn yield in a Drift strategy vault', 'Drift vault deposit review'),
  ], { connectorCapability: 'first_class_adapter', connectorActionSource: 'first-class-adapter' }),
  template('defi', 'drift-vault-request-withdraw', 'Drift vault request withdraw', 'Request a Drift strategy vault withdraw. Rejected if a pending request already exists. Prepares wallet approval work only; the redeem period must elapse before completing.', 'drift_vault_request_withdraw', 'medium', [
    field('vaultAddress', 'Vault address', 'Drift vault account address', '', true),
    selectField('withdrawUnit', 'Withdraw unit', ['token', 'shares'], 'token'),
    field('amount', 'Token amount', '10', ''),
    field('shares', 'Share amount', '5', ''),
    field('memo', 'Reason', 'Need liquidity, exit strategy', 'Drift vault withdraw request review'),
  ], { connectorCapability: 'first_class_adapter', connectorActionSource: 'first-class-adapter' }),
  template('defi', 'drift-vault-cancel-withdraw', 'Drift vault cancel withdraw', 'Cancel a pending Drift vault withdraw request. Rejected if no pending request exists.', 'drift_vault_cancel_withdraw', 'medium', [
    field('vaultAddress', 'Vault address', 'Drift vault account address', '', true),
    field('memo', 'Reason', 'Changed my mind, stay deposited', 'Drift vault cancel withdraw review'),
  ], { connectorCapability: 'first_class_adapter', connectorActionSource: 'first-class-adapter' }),
  template('defi', 'drift-vault-complete-withdraw', 'Drift vault complete withdraw', 'Complete a Drift vault withdraw after the redeem period has elapsed. Rejected if not yet ready.', 'drift_vault_complete_withdraw', 'medium', [
    field('vaultAddress', 'Vault address', 'Drift vault account address', '', true),
    field('memo', 'Reason', 'Redeem period elapsed, finalize exit', 'Drift vault complete withdraw review'),
  ], { connectorCapability: 'first_class_adapter', connectorActionSource: 'first-class-adapter' }),
  template('defi', 'liquidity', 'Liquidity position review', 'Review LP deposits, withdrawals, fees, and impermanent loss before wallet approval.', 'manual_review', 'high', [
    field('pool', 'Pool / protocol', 'Orca, Raydium, Meteora, custom', ''),
    field('amounts', 'Amounts', '0.1 SOL + 20 USDC', ''),
    field('range', 'Price range / condition', 'Optional range', ''),
  ]),
  template('defi', 'protocol-position-check', 'Protocol position check', 'Read a connected protocol position or market before proposing any action. The agent must report missing connector facts honestly.', 'read_only', 'low', [
    selectField('protocol', 'Protocol', ['Pyth', 'Kamino', 'Jupiter', 'Raydium', 'Orca', 'Meteora', 'MarginFi', 'Drift', 'Lulo', 'Save'], 'Meteora'),
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
  ], { connectorCapability: 'blink_actions', connectorActionSource: 'blink' }),
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

export const AGENT_PLAN_TEMPLATES: AgentPlanTemplate[] = (() => {
  const generated = connectorActionPlanTemplates();
  const generatedById = new Map(generated.map((entry) => [entry.id, entry]));
  const baseIds = new Set(BASE_AGENT_PLAN_TEMPLATES.map((entry) => entry.id));
  return [
    ...BASE_AGENT_PLAN_TEMPLATES.map((base) => {
      const fromForm = generatedById.get(base.id);
      if (!fromForm) return base;
      return { ...base, fields: mergeBaseAndGeneratedFields(base.fields, fromForm.fields) };
    }),
    ...generated.filter((entry) => !baseIds.has(entry.id)),
  ];
})();

function mergeBaseAndGeneratedFields(
  baseFields: AgentPlanTemplateField[],
  generatedFields: AgentPlanTemplateField[],
): AgentPlanTemplateField[] {
  const generatedById = new Map(generatedFields.map((field) => [field.id, field]));
  const baseIds = new Set(baseFields.map((field) => field.id));
  const merged: AgentPlanTemplateField[] = baseFields.map((baseField) => {
    const generatedField = generatedById.get(baseField.id);
    if (generatedField?.type === 'cascading-select') {
      return generatedField;
    }
    return baseField;
  });
  for (const generatedField of generatedFields) {
    if (baseIds.has(generatedField.id)) continue;
    if (generatedField.type === 'cascading-select' || generatedField.showWhen) {
      merged.push(generatedField);
    }
  }
  return merged;
}

export function templateById(id: string): AgentPlanTemplate {
  return AGENT_PLAN_TEMPLATES.find((template) => template.id === id) ?? AGENT_PLAN_TEMPLATES[0]!;
}

export function defaultTemplateFieldValues(template: AgentPlanTemplate): Record<string, string> {
  return Object.fromEntries(template.fields.map((fieldDef) => [fieldDef.id, fieldDef.defaultValue ?? '']));
}

export function inferTemplateIdForPrompt(prompt: string, fallbackTemplateId = 'custom-request'): string {
  const text = normalizePromptText(prompt);
  if (!text) return fallbackTemplateId;
  if (/\b(?:why\s+did\s+the\s+agent\s+deny|what\s+(?:facts|info|information)\s+(?:are\s+)?missing|what\s+is\s+missing)\b/.test(text)) {
    return fallbackTemplateId;
  }
  if (/\bkamino\b/.test(text)) {
    if (/\b(?:withdraw|redeem|remove|take\s+out)\b/.test(text)) return 'kamino-withdraw';
    if (/\b(?:stake|supply|deposit|lend|earn)\b/.test(text)) return 'kamino-deposit';
    if (/\b(?:earning|earnings|reward|rewards|yield|interest|show|check|proof)\b/.test(text)) return 'kamino-earnings-proof';
  }
  if (/\bdrift\b/.test(text)) {
    if (/\bcancel\b/.test(text)) return 'drift-vault-cancel-withdraw';
    if (/\b(?:complete|finish|finalize|claim)\b/.test(text)) return 'drift-vault-complete-withdraw';
    if (/\b(?:request|withdraw|redeem|exit)\b/.test(text)) return 'drift-vault-request-withdraw';
    if (/\b(?:deposit|supply|stake|earn|invest)\b/.test(text)) return 'drift-vault-deposit';
  }
  if (/\b(?:meteora|dlmm)\b/.test(text) && /\b(?:position|positions|fee|fees|reward|rewards|check|show|status)\b/.test(text)) {
    return 'protocol-position-check';
  }
  if (/\b(?:blink|solana-action|action\s+url)\b/.test(text)) return 'protocol-blink-action';
  if (/\b(?:can|does|which)\b.*\b(?:connector|protocol)\b.*\b(?:do|support|capable|capability|action|read|write)\b/.test(text)) {
    return 'protocol-position-check';
  }
  if (/\b(?:dca|dollar\s+cost|weekly\s+(?:buy|swap)|monthly\s+(?:buy|swap))\b/.test(text)) return 'dca';
  if (/\b(?:repeat|recurring|subscription|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|weekly\s+pay|monthly\s+pay)\b/.test(text)) {
    return 'subscription';
  }
  if (/\b(?:swap|trade|exchange|convert)\b/.test(text)) return 'swap';
  if (/\b(?:send|pay|transfer)\b/.test(text)) {
    const amountToken = amountTokenFromPrompt(prompt);
    if (amountToken?.token.toUpperCase() === 'SOL') return 'transfer-sol';
    return amountToken ? 'transfer-token' : fallbackTemplateId;
  }
  return fallbackTemplateId;
}

export function inferredTemplateParameters(
  template: AgentPlanTemplate,
  prompt: string,
  baseParameters: Record<string, string> = {},
): Record<string, string> {
  const next = { ...defaultTemplateFieldValues(template), ...baseParameters };
  const promptText = prompt.trim();
  const amountToken = amountTokenFromPrompt(prompt);
  const swap = swapTokensFromPrompt(prompt);
  const protocol = protocolFromPrompt(prompt);
  const position = solanaAddressFromPrompt(prompt);
  const cadence = cadenceFromPrompt(prompt);
  const recipient = recipientFromPrompt(prompt);

  switch (template.id) {
    case 'swap':
      if (swap.inputToken) next.inputToken = swap.inputToken;
      if (swap.outputToken) next.outputToken = swap.outputToken;
      if (swap.amount) next.amount = swap.amount;
      break;
    case 'transfer-sol':
      if (recipient) next.recipient = recipient;
      if (amountToken?.amount) next.amount = amountToken.amount;
      break;
    case 'transfer-token':
      if (recipient) next.recipient = recipient;
      if (amountToken?.amount) next.amount = amountToken.amount;
      if (amountToken?.token) next.token = amountToken.token;
      break;
    case 'subscription':
      if (recipient) next.recipient = recipient;
      if (amountToken?.amount) next.amount = amountToken.amount;
      if (amountToken?.token) next.token = amountToken.token;
      if (cadence) next.cadence = cadence;
      next.memo = promptText || next.memo || '';
      break;
    case 'dca':
      if (amountToken?.amount) next.amount = amountToken.amount;
      if (amountToken?.token) next.token = amountToken.token;
      if (recipient) next.recipient = recipient;
      if (cadence) next.cadence = cadence;
      next.memo = promptText || next.memo || '';
      break;
    case 'kamino-deposit':
    case 'kamino-withdraw':
      if (amountToken?.amount) next.amount = amountToken.amount;
      if (amountToken?.token) next.token = amountToken.token;
      next.memo = promptText || next.memo || '';
      break;
    case 'kamino-earnings-proof':
      if (amountToken?.token) next.token = amountToken.token;
      next.memo = promptText || next.memo || '';
      break;
    case 'drift-vault-deposit':
      if (position) next.vaultAddress = position;
      if (amountToken?.amount) next.amount = amountToken.amount;
      next.memo = promptText || next.memo || '';
      break;
    case 'drift-vault-request-withdraw':
      if (position) next.vaultAddress = position;
      if (/\bshares?\b/.test(prompt) && amountToken?.amount) {
        next.shares = amountToken.amount;
        next.withdrawUnit = 'shares';
      } else if (amountToken?.amount) {
        next.amount = amountToken.amount;
        next.withdrawUnit = 'token';
      }
      next.memo = promptText || next.memo || '';
      break;
    case 'drift-vault-cancel-withdraw':
    case 'drift-vault-complete-withdraw':
      if (position) next.vaultAddress = position;
      next.memo = promptText || next.memo || '';
      break;
    case 'protocol-position-check':
      if (protocol) next.protocol = protocol;
      if (position) next.position = position;
      next.question = protocolQuestionFromPrompt(prompt) || next.question || '';
      next.memo = promptText || next.memo || '';
      break;
    case 'protocol-blink-action':
      if (protocol) next.protocol = protocol;
      if (position) next.position = position;
      if (amountToken) next.amount = `${amountToken.amount} ${amountToken.token}`;
      next.operation = protocolOperationFromPrompt(prompt) || next.operation || '';
      next.blinkUrl = blinkUrlFromPrompt(prompt) || next.blinkUrl || '';
      next.memo = promptText || next.memo || '';
      break;
  }
  return next;
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
  return withGuardrailReport(planWithStructuredSwapText(plan), { templateId: template.id, prompt: notes || template.description });
}

export function planWithStructuredSwapText(plan: AgentPlan): AgentPlan {
  if (plan.actionType !== 'swap') return plan;
  const inputToken = plan.parameters.inputToken?.trim();
  const outputToken = plan.parameters.outputToken?.trim();
  if (!inputToken || !outputToken) return plan;
  const inputLabel = plan.parameters.inputTokenLabel?.trim() || inputToken;
  const outputLabel = plan.parameters.outputTokenLabel?.trim() || outputToken;
  const route = plan.route.trim() && textMentionsTokenValue(plan.route, outputLabel)
    ? plan.route
    : `${inputLabel} -> ${outputLabel}`;
  const staleAliases = [outputToken];
  const preservedTokens = [inputToken, inputLabel];
  return {
    ...plan,
    intent: rewriteSwapOutputTokenText(plan.intent, outputLabel, staleAliases, preservedTokens),
    route,
    risk: rewriteSwapOutputTokenText(plan.risk, outputLabel, staleAliases, preservedTokens),
    approval: rewriteSwapOutputTokenText(plan.approval, outputLabel, staleAliases, preservedTokens),
    safeguards: plan.safeguards.map((entry) => rewriteSwapOutputTokenText(entry, outputLabel, staleAliases, preservedTokens)),
  };
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
  options: AiRequestOptions = {},
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
    return generateAnthropicPlan(normalizedSettings, request, options);
  }
  return generateOpenAiCompatiblePlan(normalizedSettings, request, options);
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
  if (reviewNeedsWebResearch(request)) {
    return unsupportedBrowserResearchReview(request, settings.provider);
  }
  return generateOpenAiCompatibleReview(normalizedSettings, request);
}

export async function generateHostedAiPlan(
  settings: AiSettings,
  request: AiPlanRequest,
  options: AiRequestOptions = {},
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
  await assertHostedAiAvailable(diagnostics, options);
  const response = await fetch('/api/ai/generate-plan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    ...(options.signal ? { signal: options.signal } : {}),
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
    if (isAbortError(err)) throw err;
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
    const message = hostedProviderFailureMessage(payload, response.status, settings.apiKey);
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
    const message = hostedProviderFailureMessage(payload, response.status, settings.apiKey);
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
  if (settings.apiFormat !== 'anthropic' && askNeedsWebResearch(request)) {
    return unsupportedBrowserResearchAsk(settings.provider);
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
    const message = hostedProviderFailureMessage(payload, response.status, settings.apiKey);
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

async function assertHostedAiAvailable(diagnostics: AiDiagnosticEntry[], options: AiRequestOptions = {}): Promise<void> {
  const response = await fetch('/api/ai/status', {
    headers: {
      accept: 'application/json',
    },
    ...(options.signal ? { signal: options.signal } : {}),
  }).catch((err) => {
    if (isAbortError(err)) throw err;
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
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

function askNeedsWebResearch(request: AgentPlanAskRequest): boolean {
  return textNeedsWebResearch([
    request.question,
    request.plan.intent,
    request.plan.route,
    request.plan.approval,
    request.plan.userNotes ?? '',
  ].join('\n'));
}

function reviewNeedsWebResearch(request: AgentPlanReviewRequest): boolean {
  return textNeedsWebResearch([
    request.instruction ?? '',
    request.plan.intent,
    request.plan.route,
    request.plan.approval,
    request.plan.userNotes ?? '',
  ].join('\n'));
}

function textNeedsWebResearch(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return false;
  return (
    /\b(current|currently|latest|today|tonight|tomorrow|yesterday|now|real[-\s]?time|up[-\s]?to[-\s]?date|as of)\b/.test(normalized) ||
    /\b(price|cost|fee|rate|plan|subscription|monthly|per\s+month|market\s+cap|liquidity|apr|apy|weather|news|status|available|availability)\b/.test(normalized) && /\b(check|find|look\s+up|search|verify|how\s+much|whether|if|less\s+than|more\s+than|under|over|approve|deny)\b/.test(normalized) ||
    /\$\s*\d+/.test(normalized) && /\b(less\s+than|more\s+than|under|over|approve|deny|per\s+month|monthly)\b/.test(normalized)
  );
}

function anthropicWebSearchTool(): Record<string, unknown> {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: RESEARCH_MAX_USES,
    user_location: {
      type: 'approximate',
      country: 'US',
      timezone: 'America/Los_Angeles',
    },
  };
}

function unsupportedBrowserResearchReview(
  request: AgentPlanReviewRequest,
  provider: string,
): AgentPlanReviewResult {
  const reason = `This review needs current outside facts, but ${provider} browser-session mode does not provide a native web-search tool.`;
  return {
    decision: 'needs_input',
    reason,
    summary: 'Current outside facts are required before the agent can decide.',
    evidence: {
      research: { status: 'unavailable', provider, required: true },
      findings: [{
        label: 'Research needed',
        value: 'Use Hosted BYOK or Local bridge with OpenAI/Anthropic web search, or provide the current source fact in the draft.',
        tone: 'warn',
      }],
      facts: {
        research: {
          state: 'missing',
          message: reason,
        },
      },
    },
    checkedAt: new Date().toISOString(),
    source: 'ai',
    questions: [{
      id: 'current_fact',
      prompt: 'What current source fact should the agent use for this decision?',
      inputKind: 'text',
      required: true,
      ...(request.instruction ? { hint: request.instruction } : {}),
    }],
  };
}

function unsupportedBrowserResearchAsk(provider: string): AgentPlanAskResult {
  return {
    answer: `This question needs current outside facts, but ${provider} browser-session mode does not provide a native web-search tool. Use Hosted BYOK or Local bridge with OpenAI/Anthropic web search, or provide the source fact in the draft.`,
    checkedAt: new Date().toISOString(),
    source: 'ai',
  };
}

async function generateOpenAiCompatiblePlan(settings: AiSettings, request: AiPlanRequest, options: AiRequestOptions = {}): Promise<AgentPlan> {
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
    ...(options.signal ? { signal: options.signal } : {}),
    body: JSON.stringify(body),
  }).catch((err) => {
    if (isAbortError(err)) throw err;
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
  const research = askNeedsWebResearch(request);
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
      ...(research ? { tools: [anthropicWebSearchTool()] } : {}),
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
  const needsResearch = askNeedsWebResearch(request);
  return [
    {
      role: 'system',
      content:
        'You answer the user\'s question about a Solana wallet action plan. Be concise: 1 to 4 sentences, plain English. Support questions about what happens on approval, what is missing, why an agent denied, which connector is used, whether a connector can sign, whether a repeat auto-pays, what facts were read, whether a route is fixed or selected later, what changed, risks, and current outside facts when web search is available. Use plan fields, context.facts, executionPath, protocolConnectors, and connector read/write capability notes when present. If the question asks for current or outside facts and web search is available, search reliable sources and cite the source URL in the answer. Cite plan fields you reference by name (e.g., recipient, amount, slippageBps) or connector facts by label. Never claim anything is signed, submitted, guaranteed safe, or already approved. Never say a connector can sign for the user; connectors can only read facts or prepare wallet-gated work. If the question cannot be answered from the plan, facts, or available research tools, say so plainly and state what fact is missing.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: request.question,
        plan: request.plan,
        walletAddress: request.walletAddress || 'not_connected',
        cluster: request.cluster || 'unknown',
        context: request.context ?? {},
        research: {
          needed: needsResearch,
          mode: needsResearch ? 'auto_current_facts' : 'not_required',
          currentDate: new Date().toISOString(),
          maxSearches: RESEARCH_MAX_USES,
        },
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
  const citations = sortResearchCitations(extractResearchCitations(payload));
  return {
    answer: compactReviewText(text, 800),
    ...(citations.length ? { citations } : {}),
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
    ...(Array.isArray(record.citations) ? {
      citations: record.citations.filter((entry): entry is { kind: string; ref: string; title?: string } => (
        Boolean(entry) &&
        typeof entry === 'object' &&
        typeof entry.kind === 'string' &&
        typeof entry.ref === 'string'
      )).slice(0, 8),
    } : {}),
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

async function generateAnthropicPlan(settings: AiSettings, request: AiPlanRequest, options: AiRequestOptions = {}): Promise<AgentPlan> {
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
    ...(options.signal ? { signal: options.signal } : {}),
  }).catch((err) => {
    if (isAbortError(err)) throw err;
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
  const research = reviewNeedsWebResearch(request);
  const researchResult = research
    ? await generateAnthropicResearchEvidence(settings, request)
    : undefined;
  const messages = aiReviewMessages(request, researchResult?.evidence);
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
  return normalizeAiReview(payload, request, {
    citations: researchResult?.citations,
    researchEvidence: researchResult?.evidence,
    providerLabel: 'Anthropic',
  });
}

async function generateAnthropicResearchEvidence(
  settings: AiSettings,
  request: AgentPlanReviewRequest,
): Promise<{ evidence: AgentReviewResearchEvidence; citations: Array<{ kind: string; ref: string; title?: string }> }> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl, 'anthropic');
  const messages = aiResearchMessages(request);
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
      max_tokens: 1800,
      system: systemMessage,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.2,
      tools: [anthropicWebSearchTool()],
    }),
  }).catch((err) => {
    throw new Error(
      `AI provider research failed. Use the local bridge or a browser-compatible gateway. ${redactSecrets(err instanceof Error ? err.message : String(err), settings.apiKey)}`,
    );
  });
  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(providerFailureMessage(payload, response.status, settings.apiKey));
  }
  return normalizeResearchEvidence(payload, 'Anthropic');
}

export function aiMessages(request: AiPlanRequest): Array<{ role: 'system' | 'user'; content: string }> {
  const selectedConnector = selectedConnectorContext(request.connectorContext);
  const connectorRule = selectedConnector
    ? [
      `Use the selected protocol connector only: ${selectedConnector.name || selectedConnector.id || 'selected connector'}.`,
      'Do not switch protocols.',
      'If required connector facts are missing, ask for missing facts instead of inventing execution.',
      'Do not claim the action is signed, submitted, approved, or safe.',
      'The wallet owner must approve separately.',
    ].join(' ')
    : 'Only propose first-class or Blink executable actions for enabled connectors with matching capabilities. If a requested protocol/action is disabled, unsupported, or missing an action URL/client key, make the plan proof/read-only and state which connector fact, key, or action URL is missing.';
  return [
    {
      role: 'system',
      content:
        'You convert Solana wallet user requests into structured approval plans. Return only JSON with string fields intent, route, risk, approval, and safeguards as an array of short strings. Support swaps, DCA/repeat instructions, scheduled payments, Kamino supply/withdraw/earnings, Meteora position checks, Blink actions, connector capability questions, denial reasons, and missing-fact questions. Use protocol connector context to explain which enabled reads can inform the plan and which enabled write actions can only prepare wallet approval work. If protocolConnectors includes selected=true or selectedOnly=true, use that selected connector only and do not switch protocols. If a requested connector is disabled or missing, state the connector name and make the plan read-only/proof-only instead of inventing execution. When parameters include `inputTokenLabel`, `outputTokenLabel`, or `tokenLabel`, ALWAYS use those resolved symbols (for example "POPCAT") in the prose fields (intent, route, risk, approval, safeguards). Never substitute a different ticker for one provided in the parameter labels, and never invent a symbol when only a mint address is present. If a label is missing, refer to the token by its short mint form (first 4 + last 4 characters). Never claim a transaction is signed, submitted, approved, or safe. Never request private keys. The wallet user must approve separately.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        userPrompt: request.prompt,
        userNotes: request.userNotes,
        template: request.template,
        parameters: request.parameters,
        protocolConnectors: request.connectorContext ?? [],
        connectorRule,
        requiredBoundary: 'AI prepares a plan only. Wallet approval and signing happen later in the user wallet.',
      }),
    },
  ];
}

function selectedConnectorContext(
  context: Array<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  return context?.find((entry) => entry.selected === true || entry.selectedOnly === true);
}

function aiResearchMessages(request: AgentPlanReviewRequest): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You research current outside facts for a Solana wallet approval review. Do not approve, deny, or ask the wallet to sign. Search reliable current sources, prefer official sources, and return concise source-backed facts in plain English. Include current prices, thresholds, dates, plan names, ambiguity, and URLs when they are relevant. If multiple current options could change the approval outcome, list each option clearly. ' + RESEARCH_SOURCE_POLICY,
    },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: request.instruction?.trim() || 'Review this draft before it is sent for wallet approval. Decide approve, deny, or needs_input.',
        walletAddress: request.walletAddress || 'not_connected',
        cluster: request.cluster || 'unknown',
        plan: request.plan,
        context: request.context ?? {},
        research: {
          needed: true,
          mode: 'collect_current_facts_only',
          currentDate: new Date().toISOString(),
          maxSearches: RESEARCH_MAX_USES,
          sourcePolicy: RESEARCH_SOURCE_POLICY,
        },
        requiredBoundary: 'This research pass cannot approve, deny, sign, or submit. It only gathers facts for a later structured review.',
      }),
    },
  ];
}

export function aiReviewMessages(
  request: AgentPlanReviewRequest,
  researchEvidence?: AgentReviewResearchEvidence,
): Array<{ role: 'system' | 'user'; content: string }> {
  const needsResearch = reviewNeedsWebResearch(request);
  const context = researchEvidence
    ? { ...(request.context ?? {}), researchEvidence }
    : request.context ?? {};
  return [
    {
      role: 'system',
      content:
        'You review a Solana wallet action draft before it is sent for wallet approval. Return only JSON with: decision ("approve", "deny", or "needs_input"); reason as one or two concise sentences; summary as one short sentence; evidence as an object. Put flexible user-facing findings in evidence.findings as an array of {label,value,tone}, where tone is good, warn, neutral, or fail. Findings must match the user request and connector facts; do not force route/quote/slippage rows when they do not apply. If the instruction asks for current or outside facts and web search is available, search reliable sources before deciding. If context.researchEvidence is present, current outside-fact research has already been supplied; do not request another search and do not omit the researched fact. Put source-backed findings in evidence.findings, put source links in evidence.sources as an array of {title,url}, and include evidence.research = {status:"checked"} when research was used. Apply user threshold rules exactly, for example "approve if under $20, deny if over $20". When the instruction asks a threshold or conditional question (e.g., "approve if under $X", "deny if over $Y"), you MUST include the asked-about value as a finding in evidence.findings with label matching the asked fact (e.g., "Plan rate", "Subscription price", "Monthly rate", "Current price"), value formatted with the currency unit (e.g., "$16.79" or "$16.79/month"), and tone set to "good" when the user\'s approve-when condition holds and "fail" otherwise. Also include a separate "Threshold check" finding stating the comparison in plain language. Always emit these findings even when you cannot decide; never omit the asked fact. Numeric values like "$16.79" must always be the precise figure you found, never rounded up or down to favor a decision. If multiple researched facts lead to different outcomes and the draft does not identify which one applies, return "needs_input" and list the found options. When you cannot decide because user intent is genuinely ambiguous, return decision "needs_input" plus a "questions" array with 1-3 short, specific questions answerable in under 20 words. Each question object must include id, prompt, inputKind ("text" | "select" | "number"), and required. Use "needs_input" only when the missing information is something the user must supply, such as a missing amount, missing token, missing recipient, or which researched option applies. Do not use "needs_input" for facts that are present in the plan, context.facts, context.executionPath, research results, or facts you can infer. For browser swap or recurring-swap drafts, Jupiter is the execution aggregator unless context says otherwise; do not ask the user which DEX/protocol will execute it. If a token mint address is present, review that mint address; do not ask the user what token it is or whether they verified it. If token metadata is missing, return approve or deny with a warning, not needs_input. If context includes protocolConnectors or connector facts, use reads as evidence and treat writes as prepare-only wallet-approval actions. If the context includes "userPolicies", treat each as a soft rule the user wants you to honor: factor them into your decision and cite the relevant policy id in evidence.policiesApplied when one influences the outcome. Be flexible: use the user instruction and available facts, not a fixed checklist. Never claim anything is signed, submitted, guaranteed safe, or already approved. Never request private keys. The wallet user must still approve separately. STRUCTURED DECISION CONTRACT: Always also return top-level "evidenceFactIds" as an array of strings citing real `id` values from context.evidenceFacts. When you deny, list the ids that caused the deny in "blockingFactIds". When you return needs_input, list the missing required ids in "missingFactIds". Optionally include "confidence" as "high", "medium", or "low". You may only return decision "approve" when context.evidenceGate.decision === "pass". If context.evidenceGate.decision === "block", you must return "deny". If context.evidenceGate.decision === "needs_input", you must return "needs_input". Citing an id that is not present in context.evidenceFacts is a contract violation.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: request.instruction?.trim() || 'Review this draft before it is sent for wallet approval. Decide approve, deny, or needs_input.',
        walletAddress: request.walletAddress || 'not_connected',
        cluster: request.cluster || 'unknown',
        plan: request.plan,
        context,
        research: {
          needed: researchEvidence ? false : needsResearch,
          mode: researchEvidence ? 'provided_current_facts' : needsResearch ? 'auto_current_facts' : 'not_required',
          currentDate: new Date().toISOString(),
          maxSearches: RESEARCH_MAX_USES,
          ...(researchEvidence ? { providedEvidence: true, sourcePolicy: researchEvidence.sourcePolicy } : {}),
        },
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
  return withGuardrailReport(planWithStructuredSwapText(plan), {
    templateId: template.id,
    prompt: request.prompt,
  });
}

export function normalizeAiReview(
  payload: unknown,
  request: AgentPlanReviewRequest,
  options: {
    citations?: Array<{ kind: string; ref: string; title?: string }>;
    researchEvidence?: AgentReviewResearchEvidence;
    providerLabel?: string;
  } = {},
): AgentPlanReviewResult {
  const content = extractModelText(payload);
  const parsed = parsePlanJson(content);
  const decision = reviewDecisionOrUndefined(parsed.decision);
  if (!decision) {
    return malformedAiReviewResult(request, {
      citations: options.citations ?? extractResearchCitations(payload),
      researchEvidence: options.researchEvidence,
      providerLabel: options.providerLabel ?? 'AI provider',
    });
  }
  const questions = normalizeReviewQuestions(parsed.questions);
  const citations = options.citations ?? extractResearchCitations(payload);
  const reason = stringOr(
    parsed.reason,
    decision === 'approve'
      ? 'Approved by the configured agent review. Wallet approval is still required before anything signs.'
      : decision === 'needs_input'
        ? 'Agent needs clarifying answers before deciding. Answer the questions or send anyway.'
        : 'Denied by the configured agent review. Review the draft or ask the agent again.',
  );
  const evidence = jsonObjectOr(parsed.evidence, {
    actionType: request.plan.actionType,
    templateTitle: request.plan.templateTitle,
  });
  if (options.researchEvidence) {
    if (!evidence.research) evidence.research = options.researchEvidence;
    if (!Array.isArray(evidence.sources) || evidence.sources.length === 0) {
      evidence.sources = options.researchEvidence.sources;
    }
  }
  const decisionContract = decisionContractFromParsed(parsed, decision, reason, parsed.summary);
  if (decisionContract) {
    evidence.decisionContract = decisionContract;
  }
  const result: AgentPlanReviewResult = {
    decision,
    reason: compactReviewText(reason, 280),
    summary: compactReviewText(stringOr(parsed.summary, reason), 160),
    evidence: withResearchCitations(evidence, citations),
    checkedAt: new Date().toISOString(),
    source: 'ai',
    ...(questions ? { questions } : {}),
  };
  return reconcileThresholdReviewDecision(result, request);
}

function decisionContractFromParsed(
  parsed: Record<string, unknown>,
  decision: 'approve' | 'deny' | 'needs_input',
  fallbackReason: string,
  fallbackSummary: unknown,
): Record<string, unknown> | undefined {
  const evidenceFactIds = parsed.evidenceFactIds ?? (parsed as Record<string, unknown>)['evidenceFactIds'];
  const blockingFactIds = parsed.blockingFactIds;
  const missingFactIds = parsed.missingFactIds;
  const confidence = parsed.confidence;
  const anySignal = Array.isArray(evidenceFactIds) || Array.isArray(blockingFactIds) || Array.isArray(missingFactIds) || typeof confidence === 'string';
  if (!anySignal) return undefined;
  const factIds = Array.isArray(evidenceFactIds)
    ? evidenceFactIds.filter((id): id is string => typeof id === 'string')
    : [];
  const blocking = Array.isArray(blockingFactIds)
    ? blockingFactIds.filter((id): id is string => typeof id === 'string')
    : [];
  const missing = Array.isArray(missingFactIds)
    ? missingFactIds.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    decision,
    reason: fallbackReason,
    summary: typeof fallbackSummary === 'string' ? fallbackSummary : fallbackReason,
    evidenceFactIds: factIds,
    blockingFactIds: blocking,
    missingFactIds: missing,
    ...(typeof confidence === 'string' ? { confidence } : {}),
  };
}

function normalizeResearchEvidence(
  payload: unknown,
  providerLabel: string,
): { evidence: AgentReviewResearchEvidence; citations: Array<{ kind: string; ref: string; title?: string }> } {
  const citations = extractResearchCitations(payload);
  const text = extractModelText(payload).trim();
  const sources = citations.map((citation) => ({
    ...(citation.title ? { title: citation.title } : {}),
    url: citation.ref,
  }));
  return {
    citations,
    evidence: {
      status: 'checked',
      required: true,
      provider: providerLabel,
      checkedAt: new Date().toISOString(),
      summary: text
        ? compactReviewText(text, 1600)
        : 'Research ran, but the provider did not return readable source-backed findings.',
      sources,
      sourcePolicy: RESEARCH_SOURCE_POLICY,
    },
  };
}

function malformedAiReviewResult(
  request: AgentPlanReviewRequest,
  options: {
    citations?: Array<{ kind: string; ref: string; title?: string }>;
    researchEvidence?: AgentReviewResearchEvidence;
    providerLabel?: string;
  } = {},
): AgentPlanReviewResult {
  const hasResearch = Boolean(options.researchEvidence) || Boolean(options.citations?.length);
  const reason = hasResearch
    ? `${options.providerLabel ?? 'AI provider'} completed research but did not return a structured approval decision. Ask the agent again or narrow the request.`
    : `${options.providerLabel ?? 'AI provider'} did not return a structured approval decision. Ask the agent again or narrow the request.`;
  return {
    decision: 'needs_input',
    reason: compactReviewText(reason, 280),
    summary: hasResearch
      ? 'Research completed but the structured review failed.'
      : 'The agent review response was not structured.',
    evidence: withResearchCitations({
      ...(options.researchEvidence ? { research: options.researchEvidence } : hasResearch ? { research: { status: 'checked', required: true } } : {}),
      findings: [{
        label: hasResearch ? 'Structured review' : 'Agent review',
        value: hasResearch
          ? 'Research sources were found, but the agent did not return a usable approval, denial, or price finding.'
          : 'The agent response was missing a usable approval, denial, or needs-input decision.',
        tone: 'warn',
      }],
      parseError: 'missing_or_invalid_review_json',
    }, options.citations ?? []),
    checkedAt: new Date().toISOString(),
    source: 'ai',
    questions: [{
      id: 'agent_review_retry',
      prompt: 'Ask the agent again or provide the missing current fact in the draft.',
      inputKind: 'text',
      required: false,
      hint: request.instruction,
    }],
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
  options: Pick<AgentPlanTemplate, 'connectorCapability' | 'connectorActionSource'> = {},
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
    ...options,
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

function connectorActionPlanTemplates(): AgentPlanTemplate[] {
  const generated: AgentPlanTemplate[] = [];
  for (const connector of PROTOCOL_CONNECTORS) {
    for (const form of connectorActionFormsForConnector(connector)) {
      if (generated.some((entry) => entry.id === form.templateId)) continue;
      if (form.executionMode === 'blink') continue;
      if (form.executionMode === 'read-only' && form.operationId === 'position-check') continue;
      generated.push(template(
        connectorTemplateCategory(connector.id),
        form.templateId,
        `${connector.name} ${form.operationLabel}`.replace(/\s+/g, ' ').trim(),
        form.description,
        connectorActionFormTemplateActionType(form),
        connectorActionTemplateRisk(connector.id, form.operationId),
        formTemplateFields(form),
        { connectorCapability: 'first_class_adapter', connectorActionSource: 'first-class-adapter' },
      ));
    }
  }
  return generated;
}

function connectorTemplateCategory(connectorId: string): string {
  if (connectorId === 'magiceden' || connectorId === 'tensor') return 'nft';
  if (connectorId === 'realms' || connectorId === 'squads') return 'governance';
  if (connectorId === 'pyth') return 'oracle';
  if (connectorId === 'wormhole') return 'bridge';
  return 'defi';
}

function connectorActionTemplateRisk(connectorId: string, operationId: string): TemplateRisk {
  if (connectorId === 'pyth' && operationId.includes('post')) return 'medium';
  if (operationId.includes('cancel') || operationId.includes('claim') || operationId.includes('collect')) return 'medium';
  if (operationId.includes('position-check')) return 'low';
  return 'high';
}

function normalizePromptText(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, ' ');
}

function amountTokenFromPrompt(prompt: string): { amount: string; token: string } | undefined {
  const token = '(SOL|USDC|JUP|BONK|WIF|PYUSD|JitoSOL|mSOL|bSOL)';
  const amount = '(\\d+(?:\\.\\d+)?)';
  const amountThenToken = new RegExp(`\\b${amount}\\s*${token}\\b`, 'i').exec(prompt);
  if (amountThenToken?.[1] && amountThenToken[2]) {
    return { amount: amountThenToken[1], token: normalizeTokenCase(amountThenToken[2]) };
  }
  const tokenThenAmount = new RegExp(`\\b${token}\\s*${amount}\\b`, 'i').exec(prompt);
  if (tokenThenAmount?.[1] && tokenThenAmount[2]) {
    return { amount: tokenThenAmount[2], token: normalizeTokenCase(tokenThenAmount[1]) };
  }
  return undefined;
}

function swapTokensFromPrompt(prompt: string): { amount?: string; inputToken?: string; outputToken?: string } {
  const token = '([A-Za-z][A-Za-z0-9]{1,11})';
  const amount = '(\\d+(?:\\.\\d+)?)';
  const withAmount = new RegExp(`\\b(?:swap|trade|exchange|convert)\\s+${amount}\\s+${token}\\s+(?:to|for|into)\\s+${token}\\b`, 'i').exec(prompt);
  if (withAmount?.[1] && withAmount[2] && withAmount[3]) {
    return {
      amount: withAmount[1],
      inputToken: normalizeTokenCase(withAmount[2]),
      outputToken: normalizeTokenCase(withAmount[3]),
    };
  }
  const noAmount = new RegExp(`\\b(?:swap|trade|exchange|convert)\\s+${token}\\s+(?:to|for|into)\\s+${token}\\b`, 'i').exec(prompt);
  if (noAmount?.[1] && noAmount[2]) {
    return {
      inputToken: normalizeTokenCase(noAmount[1]),
      outputToken: normalizeTokenCase(noAmount[2]),
    };
  }
  const arrow = new RegExp(`\\b${amount}\\s+${token}\\s*(?:->|→|to|into)\\s*${token}\\b`, 'i').exec(prompt);
  if (arrow?.[1] && arrow[2] && arrow[3]) {
    return {
      amount: arrow[1],
      inputToken: normalizeTokenCase(arrow[2]),
      outputToken: normalizeTokenCase(arrow[3]),
    };
  }
  return {};
}

function normalizeTokenCase(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'jitosol') return 'JitoSOL';
  if (lower === 'msol') return 'mSOL';
  if (lower === 'bsol') return 'bSOL';
  return trimmed.toUpperCase();
}

function protocolFromPrompt(prompt: string): string | undefined {
  const text = normalizePromptText(prompt);
  const protocols = ['Kamino', 'Jupiter', 'Raydium', 'Orca', 'Meteora', 'MarginFi', 'Drift', 'Lulo', 'Save'];
  return protocols.find((protocol) => text.includes(protocol.toLowerCase()));
}

function solanaAddressFromPrompt(prompt: string): string | undefined {
  return /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.exec(prompt)?.[0];
}

function recipientFromPrompt(prompt: string): string | undefined {
  const address = solanaAddressFromPrompt(prompt);
  if (address) return address;
  return undefined;
}

function cadenceFromPrompt(prompt: string): string | undefined {
  const text = normalizePromptText(prompt);
  if (/\bmonthly|every\s+month\b/.test(text)) return 'monthly';
  if (/\bdaily|every\s+day\b/.test(text)) return 'interval_days';
  if (/\bweekly|every\s+week|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(text)) return 'weekly';
  return undefined;
}

function protocolQuestionFromPrompt(prompt: string): string | undefined {
  const text = normalizePromptText(prompt);
  if (/\b(?:reward|rewards)\b/.test(text)) return 'Rewards';
  if (/\b(?:fee|fees)\b/.test(text)) return 'Fees';
  if (/\bunlock|cooldown|delay\b/.test(text)) return 'Unlock timing';
  if (/\baction|actions|can\b/.test(text)) return 'Available actions';
  if (/\bstatus|position|check|show\b/.test(text)) return 'Status';
  return undefined;
}

function protocolOperationFromPrompt(prompt: string): string | undefined {
  const text = normalizePromptText(prompt);
  if (/\bclaim\b.*\b(?:fee|fees)\b/.test(text)) return 'Claim fees';
  if (/\bclaim\b.*\b(?:reward|rewards)\b/.test(text)) return 'Claim rewards';
  if (/\bwithdraw\b.*\bliquidity\b/.test(text)) return 'Withdraw liquidity';
  if (/\bclose\b/.test(text)) return 'Close position';
  if (/\bdeposit|supply\b/.test(text)) return 'Deposit';
  if (/\bborrow\b/.test(text)) return 'Borrow';
  if (/\brepay\b/.test(text)) return 'Repay';
  if (/\bswap\b/.test(text)) return 'Swap';
  return undefined;
}

function blinkUrlFromPrompt(prompt: string): string | undefined {
  return /\b(?:blink:[^\s]+|solana-action:[^\s]+|https:\/\/[^\s]+)\b/i.exec(prompt)?.[0];
}

const SWAP_TEXT_TOKENS = ['USDC', 'SOL', 'JUP', 'BONK', 'WIF', 'PYUSD'];

function rewriteSwapOutputTokenText(
  text: string,
  outputToken: string,
  staleAliases: string[] = [],
  preservedTokens: string[] = [],
): string {
  if (!text.trim() || textMentionsTokenValue(text, outputToken)) return text;
  const preserved = new Set(
    preservedTokens
      .map((entry) => entry.trim().toUpperCase())
      .filter(Boolean),
  );
  let next = text;
  for (const token of [...SWAP_TEXT_TOKENS, ...staleAliases.filter(Boolean)]) {
    const upper = token.toUpperCase();
    if (upper === outputToken.toUpperCase()) continue;
    if (preserved.has(upper)) continue;
    const escaped = escapeRegExp(token);
    next = next
      .replace(new RegExp(`(\\b(?:to|into|for|receive|buy|get|target(?:\\s+token)?|in\\s+exchange\\s+for)\\s+)${escaped}\\b`, 'gi'), `$1${outputToken}`)
      .replace(new RegExp(`(\\boutput\\s+token\\s+)${escaped}\\b`, 'gi'), `$1${outputToken}`)
      .replace(new RegExp(`(->\\s*)${escaped}\\b`, 'gi'), `$1${outputToken}`)
      .replace(new RegExp(`(→\\s*)${escaped}\\b`, 'gi'), `$1${outputToken}`)
      .replace(new RegExp(`\\bthe\\s+${escaped}\\b`, 'gi'), `the ${outputToken}`)
      .replace(new RegExp(`\\b${escaped}\\s+(token|stablecoin|coin|amount|side|leg|swap|trade)\\b`, 'gi'), `${outputToken} $1`)
      .replace(new RegExp(`\\b${escaped}-(denominated|based)\\b`, 'gi'), `${outputToken}-$1`);
  }
  return next;
}

function textMentionsTokenValue(text: string, token: string): boolean {
  const trimmed = token.trim();
  return Boolean(trimmed) && text.toLowerCase().includes(trimmed.toLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    case 'blink_action':
      return 'Prepare a {protocol} {operation} Blink/Solana Action from {blinkUrl}. Transaction bytes are fetched only when sent for approval.';
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
    case 'blink_action':
      return 'AI or templates prepare the connector draft only. The wallet owner reviews the Blink transaction and approves the final signature separately.';
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
  if (actionType === 'blink_action') {
    safeguards.push('Confirm the connector, action URL, protocol operation, and prepared transaction bytes before signing.');
  }
  if (actionType.includes('transfer')) {
    safeguards.push('Confirm recipient address and amount character by character before signing.');
  }
  return safeguards;
}

function readableParameters(template: AgentPlanTemplate, parameters: Record<string, string>): AgentPlanField[] {
  const rows: AgentPlanField[] = [];
  const fieldIds = new Set(template.fields.map((fieldDef) => fieldDef.id));
  const protocol = parameters.protocol?.trim();
  const connectorId = parameters.connectorId?.trim();
  const operation = parameters.operation?.trim();
  const connectorValue = protocol || connectorId || '';
  if (connectorValue && !fieldIds.has('protocol')) {
    rows.push({ label: 'Connector', value: connectorValue });
  }
  if (operation && !fieldIds.has('operation')) {
    rows.push({ label: 'Operation', value: operation });
  }
  for (const fieldDef of template.fields) {
    const rawValue = (parameters[fieldDef.id] ?? '').trim();
    const value = fieldDef.id === 'slippageBps'
      ? formatSlippageBpsForDisplay(rawValue)
      : displayParameterValue(fieldDef.id, rawValue, parameters);
    if (value.length > 0) {
      rows.push({ label: fieldDef.label, value });
    }
    const mint = parameters[`${fieldDef.id}Mint`]?.trim();
    if (mint && mint !== value && mint !== rawValue) {
      rows.push({ label: `${fieldDef.label} mint`, value: mint });
    } else if (mint && value && rawValue && value !== rawValue) {
      rows.push({ label: `${fieldDef.label} mint`, value: rawValue });
    }
  }
  return rows;
}

function interpolate(template: string, parameters: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = parameters[key]?.trim();
    if (key === 'slippageBps') {
      const formatted = formatSlippageBpsForDisplay(value ?? '');
      return formatted || titleCase(key);
    }
    return displayParameterValue(key, value ?? '', parameters) || titleCase(key);
  });
}

function displayParameterValue(key: string, value: string, parameters: Record<string, string>): string {
  const label = parameters[`${key}Label`]?.trim();
  if (label) return label;
  return value;
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

function providerStatusExplanation(status: number): string {
  switch (status) {
    case 400:
      return 'That means the provider rejected the request before drafting. Check the API key, selected model, API format, base URL, and whether this key can use that model.';
    case 401:
      return 'That means the key is missing, invalid, or not being sent correctly. Re-enter the API key and make sure it belongs to this provider.';
    case 403:
      return 'That means the key reached the provider but is not allowed to use this model or project. Check permissions, billing, and provider access.';
    case 404:
      return 'That usually means the model or endpoint was not found. Check the model name, API format, and base URL.';
    case 408:
      return 'That means the provider took too long to answer. Try again, or use a smaller or faster model.';
    case 409:
      return 'That means the provider reported a temporary conflict. Retry the draft in a moment.';
    case 422:
      return 'That means the provider could not accept part of the request. Check the model, response format, and request settings.';
    case 429:
      return 'That means too many requests or quota is exhausted. Wait a minute, reduce retries, or check the provider quota and billing.';
    case 500:
      return 'That means the provider hit an internal error. Retry in a moment or switch models.';
    case 502:
      return 'That means a gateway between Agentic and the provider failed. Retry in a moment.';
    case 503:
      return 'That means the provider is temporarily unavailable or overloaded. Wait a little and retry; the API key is usually not the problem.';
    case 504:
      return 'That means the provider timed out before finishing. Retry, or choose a faster model.';
    default:
      if (status >= 400 && status < 500) {
        return 'That means the provider rejected the request. Check key permissions, model name, base URL, and provider settings.';
      }
      if (status >= 500 && status < 600) {
        return 'That means the provider had a temporary server-side problem. Retry in a moment or switch models.';
      }
      return '';
  }
}

function withProviderStatusExplanation(message: string, status: number): string {
  const explanation = providerStatusExplanation(status);
  const normalized = message.trim();
  if (!explanation) return normalized;
  if (!normalized) return explanation;
  if (normalized.toLowerCase().includes(explanation.toLowerCase())) return normalized;
  return `${normalized}${/[.!?]\s*$/.test(normalized) ? ' ' : '. '}${explanation}`;
}

function hostedProviderFailureMessage(payload: unknown, status: number, exactSecret = ''): string {
  const message = extractProviderError(payload) || `Hosted AI returned HTTP ${status}.`;
  return redactSecrets(withProviderStatusExplanation(message, status), exactSecret);
}

function providerFailureMessage(payload: unknown, status: number, exactSecret = ''): string {
  const message = extractProviderError(payload) || `AI provider returned HTTP ${status}.`;
  if (/unsupported value:\s*['"]?temperature/i.test(message) || /temperature.*only the default/i.test(message)) {
    return redactSecrets(withProviderStatusExplanation(`Model does not support one of Agentic's request parameters. ${message}`, status), exactSecret);
  }
  return redactSecrets(withProviderStatusExplanation(message, status), exactSecret);
}

function extractResearchCitations(payload: unknown): Array<{ kind: string; ref: string; title?: string }> {
  const citations: Array<{ kind: string; ref: string; title?: string }> = [];
  const seen = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 10 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    const citationType = typeof record.type === 'string' ? record.type : '';
    const hasCitationShape = citationType.includes('citation') ||
      citationType.includes('web_search') ||
      typeof record.title === 'string' ||
      typeof record.cited_text === 'string' ||
      typeof record.citedText === 'string';
    if (url && hasCitationShape && /^https?:\/\//i.test(url) && !seen.has(url)) {
      seen.add(url);
      citations.push({
        kind: 'url',
        ref: url,
        ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title.trim() } : {}),
      });
      if (citations.length >= 8) return;
    }
    for (const entry of Object.values(record)) {
      if (citations.length >= 8) return;
      visit(entry, depth + 1);
    }
  };
  visit(payload, 0);
  return citations;
}

function withResearchCitations(
  evidence: Record<string, unknown>,
  citations: Array<{ kind: string; ref: string; title?: string }>,
): Record<string, unknown> {
  if (!citations.length) return evidence;
  const existing = Array.isArray(evidence.sources)
    ? evidence.sources.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    : [];
  const seen = new Set<string>();
  const sources: Record<string, unknown>[] = [];
  for (const entry of [...existing, ...citations]) {
    const record = entry as Record<string, unknown>;
    const url = typeof record.url === 'string'
      ? record.url.trim()
      : typeof record.ref === 'string'
        ? record.ref.trim()
        : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title.trim() } : {}),
      url,
    });
    if (sources.length >= 8) break;
  }
  return {
    ...evidence,
    sources: sortResearchCitations(sources),
    research: evidence.research ?? { status: 'checked' },
  };
}

function sortResearchCitations<T extends { url?: string; ref?: string }>(citations: T[]): T[] {
  return [...citations].sort((a, b) => researchSourcePriority(a.url ?? a.ref ?? '') - researchSourcePriority(b.url ?? b.ref ?? ''));
}

function researchSourcePriority(url: string): number {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'hellohelium.com' || host.endsWith('.hellohelium.com')) return 0;
    if (host === 'heliummobile.com' || host.endsWith('.heliummobile.com')) return 0;
  } catch {
    return 10;
  }
  return 5;
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
  if (!trimmed) return {};
  const candidates = [
    trimmed,
    ...jsonCodeFenceCandidates(trimmed),
    ...balancedJsonObjectCandidates(trimmed),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return {};
}

function jsonCodeFenceCandidates(content: string): string[] {
  const candidates: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(content))) {
    const candidate = match[1]?.trim();
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function balancedJsonObjectCandidates(content: string): string[] {
  const candidates: string[] = [];
  for (let start = content.indexOf('{'); start >= 0; start = content.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < content.length; index += 1) {
      const char = content[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(content.slice(start, index + 1));
          break;
        }
      }
    }
    if (candidates.length >= 4) break;
  }
  return candidates;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeReviewDecision(value: unknown): AgentPlanReviewDecision {
  return reviewDecisionOrUndefined(value) ?? 'needs_input';
}

function reviewDecisionOrUndefined(value: unknown): AgentPlanReviewDecision | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['approve', 'approved', 'allow', 'allowed', 'pass', 'passed', 'ok'].includes(normalized)) {
    return 'approve';
  }
  if (['needs_input', 'needs-input', 'need_input', 'need-input', 'ask', 'clarify', 'needs_clarification'].includes(normalized)) {
    return 'needs_input';
  }
  if (['deny', 'denied', 'block', 'blocked', 'fail', 'failed', 'reject', 'rejected'].includes(normalized)) {
    return 'deny';
  }
  return undefined;
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
