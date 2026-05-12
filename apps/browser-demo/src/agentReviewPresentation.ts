import type { AgentPlan } from './planner.js';

export type AgentEvidenceTone = 'good' | 'warn' | 'neutral' | 'fail';

export interface AgentEvidenceDisplayRow {
  label: string;
  value: string;
  tone: AgentEvidenceTone;
}

export interface SwapTokenTextMismatchWarning {
  expectedToken: string;
  actualToken: string;
  actualValue: string;
  message: string;
}

const KNOWN_OUTPUT_TOKEN_MINTS: Record<string, string> = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
};

const KNOWN_OUTPUT_TOKENS = Object.keys(KNOWN_OUTPUT_TOKEN_MINTS);
const TOKEN_MISMATCH_KEYS = new Set([
  'tokenmismatch',
  'token_mismatch',
  'actualtoken',
  'actual_token',
  'actualmint',
  'actual_mint',
  'actualoutputtoken',
  'actual_output_token',
  'actualoutputmint',
  'actual_output_mint',
  'intendedtoken',
  'intended_token',
  'expectedtoken',
  'expected_token',
]);

export function swapTokenTextMismatchWarning(
  plan: Pick<AgentPlan, 'actionType' | 'intent' | 'route' | 'userNotes' | 'parameters'>,
  displayToken: (value: string) => string = (value) => value,
): SwapTokenTextMismatchWarning | undefined {
  if (plan.actionType !== 'swap') return undefined;
  const outputToken = plan.parameters.outputToken?.trim();
  if (!outputToken) return undefined;
  const expectedToken = expectedOutputTokenFromPlanText(plan);
  const outputLabel = plan.parameters.outputTokenLabel?.trim();
  if (!expectedToken || outputMatchesExpectedToken(outputToken, outputLabel, expectedToken)) return undefined;
  const actualToken = outputLabel || displayToken(outputToken);
  return {
    expectedToken,
    actualToken,
    actualValue: outputToken,
    message: `Draft text mentions ${expectedToken}, but the output token is ${actualToken}.`,
  };
}

export function tokenMismatchEvidenceRows(evidence: Record<string, unknown> | undefined): AgentEvidenceDisplayRow[] {
  if (!evidence) return [];
  const mismatch = evidenceValue(evidence, ['tokenMismatch', 'token_mismatch']);
  const intended = evidenceValue(evidence, ['intendedToken', 'intended_token', 'expectedToken', 'expected_token']);
  const actual = evidenceValue(evidence, ['actualToken', 'actual_token', 'actualOutputToken', 'actual_output_token']);
  const actualMint = evidenceValue(evidence, ['actualMint', 'actual_mint', 'actualOutputMint', 'actual_output_mint']);
  if (!mismatch && !intended && !actual && !actualMint) return [];
  const pieces = [
    intended ? `expected ${intended}` : '',
    actual ? `actual ${actual}` : '',
    actualMint ? `mint ${actualMint}` : '',
    typeof mismatch === 'string' && mismatch !== 'true' ? mismatch : '',
  ].filter(Boolean);
  return [{
    label: 'Token mismatch',
    value: pieces.join('; ') || 'Output token does not match the draft intent.',
    tone: 'fail',
  }];
}

export function isTokenMismatchEvidenceKey(key: string): boolean {
  return TOKEN_MISMATCH_KEYS.has(normalizeEvidenceKey(key));
}

export function evidenceEntryTone(label: string, value: string): AgentEvidenceTone {
  const text = `${label} ${value}`.toLowerCase();
  return /\b(token mismatch|wrong token|intended token|actual token|actual mint|expected token)\b/.test(text)
    ? 'fail'
    : 'neutral';
}

function expectedOutputTokenFromPlanText(
  plan: Pick<AgentPlan, 'intent' | 'route' | 'userNotes' | 'parameters'>,
): string | undefined {
  const outputTokenRaw = plan.parameters.outputToken?.trim();
  if (!outputTokenRaw) return undefined;
  if (textMentionsTokenValue(plan.route, outputTokenRaw)) return undefined;
  const outputTokenLabel = plan.parameters.outputTokenLabel?.trim();
  if (outputTokenLabel && textMentionsTokenValue(plan.route, outputTokenLabel)) return undefined;
  const text = plan.route;
  const outputToken = plan.parameters.outputToken?.trim().toUpperCase();
  for (const token of KNOWN_OUTPUT_TOKENS) {
    if (token === outputToken) continue;
    if (mentionsOutputToken(text, token)) return token;
  }
  return undefined;
}

function mentionsOutputToken(text: string, token: string): boolean {
  const escaped = escapeRegExp(token);
  return [
    new RegExp(`(?:->|→)\\s*${escaped}\\b`, 'i'),
    new RegExp(`\\bto\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:output|receive|buy|get|into)\\s+(?:token\\s+)?${escaped}\\b`, 'i'),
  ].some((pattern) => pattern.test(text));
}

function textMentionsTokenValue(text: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  return text.toLowerCase().includes(trimmed.toLowerCase());
}

function outputMatchesExpectedToken(outputToken: string, outputLabel: string | undefined, expectedToken: string): boolean {
  const normalized = outputToken.trim();
  return normalized.toUpperCase() === expectedToken ||
    outputLabel?.trim().toUpperCase() === expectedToken ||
    normalized === KNOWN_OUTPUT_TOKEN_MINTS[expectedToken];
}

function evidenceValue(evidence: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = evidence[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'true' : '';
  }
  return '';
}

function normalizeEvidenceKey(key: string): string {
  return key.trim().replace(/[\s-]+/g, '_').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
