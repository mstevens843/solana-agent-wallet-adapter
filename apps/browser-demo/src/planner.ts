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
}

const SHARED_SAFEGUARDS = [
  'Wallet approval is required before any signature or transaction leaves the device.',
  'The agent never receives the wallet private key or seed phrase.',
  'Amounts, recipients, routes, and policy notes must be visible before signing.',
];

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
    detail: 'GPT models through the OpenAI-compatible chat API.',
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
  template('trading', 'swap', 'Swap tokens', 'Prepare a Jupiter-style swap request with explicit input, output, amount, and slippage cap.', 'swap', 'medium', [
    selectField('inputToken', 'Input token', ['SOL', 'USDC', 'JUP', 'BONK', 'WIF', 'PYUSD'], 'SOL'),
    selectField('outputToken', 'Output token', ['USDC', 'SOL', 'JUP', 'BONK', 'WIF', 'PYUSD'], 'USDC'),
    field('amount', 'Input amount', '0.01', '0.01', true),
    field('slippageBps', 'Max slippage bps', '50', '50'),
  ]),
  template('recurring', 'dca', 'DCA recurring buy', 'Create a recurring approval schedule where every occurrence still needs wallet review.', 'recurring_payment', 'medium', [
    selectField('token', 'Spend token', ['SOL', 'USDC', 'PYUSD'], 'USDC'),
    field('amount', 'Amount per occurrence', '10', '10', true),
    field('recipient', 'Recipient / settlement wallet', 'Recipient public key', '', true),
    selectField('cadence', 'Cadence', ['weekly', 'monthly', 'interval_days'], 'weekly'),
    field('memo', 'Strategy note', 'Buy SOL weekly if route stays under cap', 'Recurring DCA approval'),
  ]),
  template('recurring', 'subscription', 'Subscription / allowance', 'Prepare a recurring payment review without granting unlimited authority.', 'recurring_payment', 'medium', [
    selectField('token', 'Token', ['USDC', 'SOL', 'PYUSD'], 'USDC'),
    field('recipient', 'Recipient address', 'Recipient public key', '', true),
    field('amount', 'Max amount per payment', '5', '5', true),
    selectField('cadence', 'Cadence', ['weekly', 'monthly', 'interval_days'], 'monthly'),
    field('memo', 'Service / reason', 'Subscription memo', 'Recurring user-approved payment'),
  ]),
  template('trading', 'limit-order', 'Limit order review', 'Draft a limit-order intent that waits for explicit wallet approval at execution time.', 'manual_review', 'medium', [
    selectField('inputToken', 'Input token', ['SOL', 'USDC', 'JUP', 'BONK', 'WIF'], 'SOL'),
    selectField('outputToken', 'Output token', ['USDC', 'SOL', 'JUP', 'BONK', 'WIF'], 'USDC'),
    field('amount', 'Input amount', '0.1', '0.1'),
    field('limitPrice', 'Limit price / condition', 'Only if SOL >= $250', ''),
  ]),
  template('trading', 'rebalance', 'Portfolio rebalance', 'Plan a rebalance while preserving final wallet approval for each action.', 'manual_review', 'high', [
    textareaField('target', 'Target allocation', 'Example: 60% SOL, 30% USDC, 10% JUP'),
    field('maxTradeSize', 'Max trade size', '100 USDC', '100 USDC'),
    field('slippageBps', 'Max slippage bps', '50', '50'),
  ]),
  template('portfolio', 'balances', 'Portfolio check', 'Read and summarize wallet balances before proposing any action.', 'read_only', 'low', [
    selectField('scope', 'Scope', ['SOL + configured tokens', 'All SPL tokens', 'NFTs', 'DeFi positions'], 'SOL + configured tokens'),
    field('threshold', 'Alert threshold', 'Show assets over $10', 'Show assets over $10'),
  ]),
  template('portfolio', 'nft-review', 'NFT holdings review', 'Review NFT holdings, floor-risk notes, and suspicious collection signals.', 'read_only', 'low', [
    field('collection', 'Collection / mint', 'Optional collection name or mint', ''),
    selectField('goal', 'Goal', ['Summarize', 'Flag suspicious assets', 'Prepare sale review', 'Prepare transfer review'], 'Summarize'),
  ]),
  template('staking', 'stake-sol', 'Stake SOL', 'Draft a staking/delegation action with validator and amount visible before signing.', 'manual_review', 'medium', [
    field('validator', 'Validator vote account', 'Vote account or validator name', '', true),
    field('amount', 'Amount SOL', '1', '1'),
    field('memo', 'Reason', 'Stake with selected validator', 'Stake review'),
  ]),
  template('staking', 'unstake-sol', 'Unstake / deactivate', 'Prepare an unstake or deactivate review with cooldown expectations.', 'manual_review', 'medium', [
    field('stakeAccount', 'Stake account', 'Stake account public key', ''),
    field('amount', 'Amount SOL or all', 'all', 'all'),
    field('memo', 'Reason', 'Liquidity needed', 'Unstake review'),
  ]),
  template('governance', 'vote', 'Governance vote', 'Summarize a proposal and create a wallet approval proof for the chosen vote.', 'manual_review', 'medium', [
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
  template('security', 'rug-check', 'Token risk check', 'Draft a token risk review before buying, swapping, or accepting a token.', 'manual_review', 'high', [
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
  template('defi', 'liquidity', 'Liquidity position review', 'Review LP deposits, withdrawals, fees, and impermanent loss before wallet approval.', 'manual_review', 'high', [
    field('pool', 'Pool / protocol', 'Orca, Raydium, Meteora, custom', ''),
    field('amounts', 'Amounts', '0.1 SOL + 20 USDC', ''),
    field('range', 'Price range / condition', 'Optional range', ''),
  ]),
  template('nft', 'nft-transfer', 'NFT transfer', 'Prepare an NFT transfer with recipient, collection, and anti-phishing checks.', 'manual_review', 'medium', [
    field('mint', 'NFT mint', 'Mint address', '', true),
    field('recipient', 'Recipient address', 'Recipient public key', '', true),
    field('memo', 'Reason', 'Transfer memo', 'NFT transfer review'),
  ]),
  template('nft', 'marketplace-listing', 'Marketplace listing review', 'Draft a listing or delisting review with price, marketplace, and royalties visible.', 'manual_review', 'medium', [
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
  template('integration', 'dapp-interaction', 'dApp interaction review', 'Prepare a review for a third-party dApp request before the user signs.', 'manual_review', 'high', [
    field('dapp', 'dApp / URL', 'Jupiter, Meteora, Tensor, custom URL', ''),
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
  template('custom', 'custom-request', 'Custom request', 'Turn any plain-English request into a visible approval plan before signing.', 'manual_review', 'medium', [
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
  return {
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
}

export function aiProviderPresetById(id: string): AiProviderPreset {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? AI_PROVIDER_PRESETS[0]!;
}

export function aiFormatLabel(format: AiApiFormat): string {
  return format === 'anthropic' ? 'Anthropic Messages API' : 'OpenAI-compatible';
}

export async function generateSessionAiPlan(
  settings: AiSettings,
  request: AiPlanRequest,
): Promise<AgentPlan> {
  if (!settings.apiKey.trim()) {
    throw new Error('Session AI key is required.');
  }
  if (settings.apiFormat === 'anthropic') {
    return generateAnthropicPlan(settings, request);
  }
  return generateOpenAiCompatiblePlan(settings, request);
}

export async function generateHostedAiPlan(
  settings: AiSettings,
  request: AiPlanRequest,
): Promise<AgentPlan> {
  if (!settings.apiKey.trim()) {
    throw new Error('Hosted BYOK key is required.');
  }
  const response = await fetch('/api/ai/generate-plan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      settings: {
        apiKey: settings.apiKey,
        provider: settings.provider,
        apiFormat: settings.apiFormat,
        baseUrl: settings.baseUrl,
        model: settings.model,
      },
      request,
    }),
  }).catch((err) => {
    throw new Error(
      `Hosted AI request failed. ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(redactSecrets(extractProviderError(payload) || `Hosted AI returned HTTP ${response.status}.`));
  }
  return normalizeHostedAiPlan(payload, request);
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
      `AI provider request failed. Use the local bridge or a browser-compatible gateway. ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(providerFailureMessage(payload, response.status));
  }
  return normalizeAiPlan(payload, request);
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
  return {
    intent: stringOr(record.intent, `${request.template.title}: ${request.prompt}`),
    route: stringOr(record.route, `Draft ${request.template.actionType} request and show route details before wallet approval.`),
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
      `AI provider request failed. Use the local bridge or a browser-compatible gateway. ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(providerFailureMessage(payload, response.status));
  }
  return normalizeAiPlan(payload, request);
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
        requiredBoundary: 'AI drafts a plan only. Wallet approval and signing happen later in the user wallet.',
      }),
    },
  ];
}

export function normalizeAiPlan(payload: unknown, request: AiPlanRequest): AgentPlan {
  const content = extractModelText(payload);
  const parsed = parsePlanJson(content);
  const template = templateById(request.template.id);
  const fallback = buildTemplatePlan(template, request.parameters, 'ai');
  return {
    ...fallback,
    intent: stringOr(parsed.intent, fallback.intent),
    route: stringOr(parsed.route, fallback.route),
    risk: stringOr(parsed.risk, fallback.risk),
    approval: stringOr(parsed.approval, fallback.approval),
    source: 'ai',
    userNotes: request.userNotes?.trim() || request.prompt.trim() || undefined,
    safeguards: normalizeSafeguards(parsed.safeguards, fallback.safeguards),
  };
}

export function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/\bsk-proj-[A-Za-z0-9_-]{8,}\b/g, 'sk-proj-[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]');
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
      return 'Prepare a swap from {amount} {inputToken} to {outputToken} with max slippage {slippageBps} bps.';
    case 'recurring_payment':
      return 'Create a recurring review item for {amount} {token} on {cadence}. Every occurrence still requires wallet approval.';
    case 'read_only':
      return 'Read or review wallet context only. No transaction should be produced unless the user creates a separate approval.';
    default:
      return 'Draft the request, expose the route and policy checks, then require a separate wallet approval before signing.';
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
      return 'Wallet can sign an off-chain approval proof after the user reviews the structured plan.';
    default:
      return 'The local bridge can queue this action, but the wallet must still approve the final signature.';
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
      value: (parameters[fieldDef.id] ?? '').trim(),
    }))
    .filter((entry) => entry.value.length > 0);
}

function interpolate(template: string, parameters: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = parameters[key]?.trim();
    return value || titleCase(key);
  });
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

function providerFailureMessage(payload: unknown, status: number): string {
  const message = extractProviderError(payload) || `AI provider returned HTTP ${status}.`;
  if (/unsupported value:\s*['"]?temperature/i.test(message) || /temperature.*only the default/i.test(message)) {
    return redactSecrets(`Model does not support one of Agentic's request parameters. ${message}`);
  }
  return redactSecrets(message);
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
