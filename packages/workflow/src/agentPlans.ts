import type { AiGuardrailReport } from './index.js';

export type AgentPlanSource = 'template' | 'ai';
export type TemplateRisk = 'low' | 'medium' | 'high';
export type TemplateFieldType =
  | 'text'
  | 'number'
  | 'textarea'
  | 'select'
  | 'datetime-local'
  | 'cascading-select';

export interface CascadingSelectOptions {
  dependsOn: string[];
  providerId: string;
  allowManualFallback?: boolean;
  emptyHint?: string;
}

export type ProtocolConnectorCapabilityId =
  | 'first_class_adapter'
  | 'read_positions'
  | 'read_rewards'
  | 'blink_actions'
  | 'read_markets';

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
  helperText?: string;
  defaultValue?: string;
  options?: string[];
  required?: boolean;
  cascading?: CascadingSelectOptions;
  showWhen?: Record<string, string | string[]>;
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
  connectorCapability?: ProtocolConnectorCapabilityId;
  connectorActionSource?: 'blink' | 'first-class-adapter';
  fields: AgentPlanTemplateField[];
}

export interface AiPlanTemplateContext {
  id: string;
  category: string;
  title: string;
  description: string;
  actionType: string;
  risk: string;
}

export interface AiPlanRequest {
  prompt: string;
  template: AiPlanTemplateContext;
  parameters: Record<string, string>;
  userNotes?: string;
  connectorContext?: Array<Record<string, unknown>>;
}

export type AgentPlanReviewMode = 'single' | 'multi';
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

export interface AgentPlanReviewRequest {
  plan: AgentPlan;
  instruction?: string;
  walletAddress?: string;
  cluster?: string;
  context?: Record<string, unknown>;
  mode?: AgentPlanReviewMode;
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

export interface AgentPlanAskRequest {
  plan: AgentPlan;
  question: string;
  walletAddress?: string;
  cluster?: string;
  context?: Record<string, unknown>;
}

export interface AgentPlanAskResult {
  answer: string;
  citations?: Array<{ kind: string; ref: string; title?: string }>;
  checkedAt: string;
  source: 'ai';
}

export const SHARED_AGENT_PLAN_SAFEGUARDS = [
  'Wallet approval is required before any signature or transaction leaves the device.',
  'The agent never receives the wallet private key or seed phrase.',
  'Amounts, recipients, routes, and policy notes must be visible before signing.',
];

export const AGENT_PLAN_TEMPLATES: AgentPlanTemplate[] = [
  template('payments', 'send-tokens', 'Send Tokens', 'Prepare a token payment with recipient, amount, memo, and wallet approval. Sends native SOL or any SPL token.', 'transfer_spl', 'medium', [
    selectField('token', 'Token', ['SOL', 'USDC', 'USDT', 'JUP', 'BONK', 'WIF', 'PYUSD'], 'SOL'),
    field('recipient', 'Recipient address', 'Recipient public key', '', true),
    field('amount', 'Amount', '0.01', '0.01', true),
    field('memo', 'Memo / reason', 'Invoice, friend payment, reimbursement', 'User-approved payment'),
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
  template('defi', 'protocol-blink-action', 'Protocol connector action', 'Prepare an executable protocol action through an enabled connector. Requires a Blink or Solana Action URL; transaction bytes are fetched only when sent for approval.', 'blink_action', 'high', [
    selectField('protocol', 'Protocol', ['Kamino', 'Jupiter', 'Raydium', 'Orca', 'Meteora', 'MarginFi', 'Drift', 'Lulo', 'Save'], 'Meteora'),
    selectField('operation', 'Operation', ['Claim rewards', 'Claim fees', 'Withdraw liquidity', 'Close position', 'Deposit', 'Borrow', 'Repay', 'Swap'], 'Claim fees'),
    field('blinkUrl', 'Blink / Action URL', 'blink:https://... or solana-action:https://...', '', true),
    field('position', 'Position / market', 'Pool, market, vault, or position address', ''),
    field('amount', 'Amount / cap', 'all, 0.1 SOL, 100 USDC', ''),
    textareaField('memo', 'Agent instructions', 'Check connector facts first. Prepare only if amount, protocol, route, and policy match my instructions.'),
  ], { connectorCapability: 'blink_actions', connectorActionSource: 'blink' }),
  template('custom', 'custom-request', 'Custom request', 'Turn any plain-English request into a visible review plan before signing evidence.', 'manual_review', 'medium', [
    field('policy', 'Policy cap', 'What should never be allowed?', 'No private key sharing, no unlimited approvals'),
  ]),
];

const LEGACY_TEMPLATE_ID_ALIASES: Record<string, string> = {
  'transfer-sol': 'send-tokens',
  'transfer-token': 'send-tokens',
};

export function templateById(id: string): AgentPlanTemplate {
  const resolved = LEGACY_TEMPLATE_ID_ALIASES[id] ?? id;
  return AGENT_PLAN_TEMPLATES.find((templateEntry) => templateEntry.id === resolved) ?? AGENT_PLAN_TEMPLATES[0]!;
}

export function defaultTemplateFieldValues(templateEntry: AgentPlanTemplate): Record<string, string> {
  return Object.fromEntries(templateEntry.fields.map((fieldDef) => [fieldDef.id, fieldDef.defaultValue ?? '']));
}

export function inferTemplateIdForPrompt(prompt: string, fallbackTemplateId = 'custom-request'): string {
  const text = normalizePromptText(prompt);
  if (!text) return fallbackTemplateId;
  if (/\b(?:blink|solana-action|action\s+url)\b/.test(text)) return 'protocol-blink-action';
  if (/\b(?:dca|dollar\s+cost|weekly\s+(?:buy|swap)|monthly\s+(?:buy|swap))\b/.test(text)) return 'dca';
  if (/\b(?:repeat|recurring|subscription|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|weekly\s+pay|monthly\s+pay)\b/.test(text)) {
    return 'subscription';
  }
  if (/\b(?:swap|trade|exchange|convert)\b/.test(text)) return 'swap';
  if (/\b(?:send|pay|transfer)\b/.test(text)) {
    const amountToken = amountTokenFromPrompt(prompt);
    return amountToken ? 'send-tokens' : fallbackTemplateId;
  }
  return fallbackTemplateId;
}

export function inferredTemplateParameters(
  templateEntry: AgentPlanTemplate,
  prompt: string,
  baseParameters: Record<string, string> = {},
): Record<string, string> {
  const next = { ...defaultTemplateFieldValues(templateEntry), ...baseParameters };
  const promptText = prompt.trim();
  const amountToken = amountTokenFromPrompt(prompt);
  const swap = swapTokensFromPrompt(prompt);
  const protocol = protocolFromPrompt(prompt);
  const position = solanaAddressFromPrompt(prompt);
  const cadence = cadenceFromPrompt(prompt);
  const recipient = recipientFromPrompt(prompt);

  switch (templateEntry.id) {
    case 'swap':
      if (swap.inputToken) next.inputToken = swap.inputToken;
      if (swap.outputToken) next.outputToken = swap.outputToken;
      if (swap.amount) next.amount = swap.amount;
      break;
    case 'send-tokens':
      if (recipient) next.recipient = recipient;
      if (amountToken?.amount) next.amount = amountToken.amount;
      if (amountToken?.token) next.token = amountToken.token;
      break;
    case 'subscription':
    case 'dca':
      if (recipient) next.recipient = recipient;
      if (amountToken?.amount) next.amount = amountToken.amount;
      if (amountToken?.token) next.token = amountToken.token;
      if (cadence) next.cadence = cadence;
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

export function buildTemplatePlan(
  templateEntry: AgentPlanTemplate,
  parameters: Record<string, string>,
  source: AgentPlanSource = 'template',
  userNotes = '',
): AgentPlan {
  const readableParams = readableParameters(templateEntry, parameters);
  const actionSummary = readableParams.length
    ? readableParams.map((entry) => `${entry.label}: ${entry.value}`).join('; ')
    : templateEntry.prompt;
  const notes = userNotes.trim();
  return planWithStructuredSwapText({
    intent: source === 'ai'
      ? templateEntry.prompt
      : `${templateEntry.title}: ${actionSummary}`,
    route: interpolate(templateEntry.route, parameters),
    risk: interpolate(templateEntry.riskText, parameters),
    approval: interpolate(templateEntry.approval, parameters),
    source,
    category: templateEntry.category,
    actionType: templateEntry.actionType,
    templateTitle: templateEntry.title,
    ...(notes && { userNotes: notes }),
    parameters,
    fields: readableParams,
    safeguards: [...SHARED_AGENT_PLAN_SAFEGUARDS, ...templateEntry.safeguards],
  });
}

export function canQueueAgentPlan(plan: AgentPlan): boolean {
  return ['transfer_sol', 'transfer_spl', 'swap', 'recurring_payment', 'custom_transaction', 'blink_action'].includes(plan.actionType);
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
  const staleAliases = [plan.parameters.outputTokenSymbol ?? '', plan.parameters.expectedOutputToken ?? ''];
  const preservedTokens = [inputLabel, plan.parameters.inputTokenLabel ?? '', inputToken];
  return {
    ...plan,
    route,
    intent: rewriteSwapOutputTokenText(plan.intent, outputLabel, staleAliases, preservedTokens),
    risk: rewriteSwapOutputTokenText(plan.risk, outputLabel, staleAliases, preservedTokens),
    approval: rewriteSwapOutputTokenText(plan.approval, outputLabel, staleAliases, preservedTokens),
    safeguards: plan.safeguards.map((entry) => rewriteSwapOutputTokenText(entry, outputLabel, staleAliases, preservedTokens)),
  };
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
  const arrow = new RegExp(`\\b${amount}\\s+${token}\\s*(?:->|to|into)\\s*${token}\\b`, 'i').exec(prompt);
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
  return solanaAddressFromPrompt(prompt);
}

function cadenceFromPrompt(prompt: string): string | undefined {
  const text = normalizePromptText(prompt);
  if (/\bmonthly|every\s+month\b/.test(text)) return 'monthly';
  if (/\bdaily|every\s+day\b/.test(text)) return 'interval_days';
  if (/\bweekly|every\s+week|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(text)) return 'weekly';
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

function routeFor(actionType: string): string {
  switch (actionType) {
    case 'transfer_sol':
      return 'Prepare a SOL transfer to {recipient} for {amount} SOL. Queue through the active approval workflow when connected.';
    case 'transfer_spl':
      return 'Prepare a {token} transfer to {recipient} for {amount}. Queue through the active approval workflow when connected.';
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

function readableParameters(templateEntry: AgentPlanTemplate, parameters: Record<string, string>): AgentPlanField[] {
  const rows: AgentPlanField[] = [];
  for (const fieldDef of templateEntry.fields) {
    const rawValue = (parameters[fieldDef.id] ?? '').trim();
    const value = fieldDef.id === 'slippageBps'
      ? formatSlippageBpsForDisplay(rawValue)
      : displayParameterValue(fieldDef.id, rawValue, parameters);
    if (value.length > 0) {
      rows.push({ label: fieldDef.label, value });
    }
  }
  return rows;
}

function interpolate(input: string, parameters: Record<string, string>): string {
  return input.replace(/\{([^}]+)\}/g, (_, key: string) => {
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

function titleCase(value: string): string {
  return value
    .replace(/([A-Z])/g, ' $1')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}
