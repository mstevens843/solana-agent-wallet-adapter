import { getPhoenixPerpsPolicy, type AgentWalletConfig } from '../config.js';
import type { VulcanToolDescriptor } from './vulcanClient.js';

/**
 * Classify upstream Vulcan tools as dangerous (signing / write) vs. read-only.
 *
 * Heuristic: Vulcan annotates dangerous tools by requiring an `acknowledged` boolean in their input schema and by
 * matching common write verbs in the tool name. Both signals are checked; either one is sufficient.
 */
// Segments delimited by `.`, `_`, `-`, or string boundaries. JS `\b` includes underscores in word chars, which would
// miss names like `place_market`; explicit segment boundaries handle Vulcan's conventional snake/dot notation.
const DANGEROUS_NAME_PATTERN =
  /(?:^|[._\-/])(place|cancel|close|deposit|withdraw|transfer|approve|sign|execute|open|modify)(?:[._\-/]|$)/i;
const SAFE_PREFIXES = ['market', 'paper', 'status', 'history', 'portfolio', 'position', 'ta', 'account', 'wallet'];

export function isDangerousTool(tool: VulcanToolDescriptor): boolean {
  if (toolSchemaRequiresAcknowledged(tool)) return true;
  const lower = tool.name.toLowerCase();
  if (SAFE_PREFIXES.some((p) => lower.startsWith(p))) return false;
  return DANGEROUS_NAME_PATTERN.test(tool.name);
}

function toolSchemaRequiresAcknowledged(tool: VulcanToolDescriptor): boolean {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') return false;
  const props = (schema as Record<string, unknown>).properties;
  if (!props || typeof props !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(props, 'acknowledged');
}

/**
 * Phoenix policy gate for dangerous Vulcan calls. Mirrors `assertPhoenixPolicyAllowed` from the native adapter but
 * derives the symbol + leverage + mode from upstream call arguments where possible.
 *
 * Throws `Error` (caller maps to ProtocolError); rejects when:
 *  - policy.enabled is false
 *  - policy.paperModeOnly is true and args.mode !== 'paper' (and not detectable as paper)
 *  - args.symbol present but outside policy.allowedSymbols
 *  - args.leverage present and exceeds policy.maxLeverage
 */
export function assertVulcanDangerousCallAllowed(
  config: AgentWalletConfig,
  args: Record<string, unknown>,
): void {
  const policy = getPhoenixPerpsPolicy(config);
  if (!policy.enabled) {
    throw new VulcanPolicyError(
      'connector_disabled',
      'Phoenix Perpetuals is disabled by policy. Enable config.connectors.phoenix.perps.enabled before dangerous Vulcan calls.',
    );
  }
  if (policy.readOnly) {
    throw new VulcanPolicyError(
      'read_only_policy',
      'Phoenix Perpetuals policy is read-only. Disable readOnly to forward signing tools through Vulcan.',
    );
  }
  const argMode = typeof args.mode === 'string' ? args.mode.toLowerCase() : undefined;
  if (policy.paperModeOnly && argMode !== 'paper') {
    throw new VulcanPolicyError(
      'paper_mode_required',
      'Phoenix policy is paper-mode-only. Pass mode: "paper" or flip paperModeOnly to false.',
    );
  }
  const symbol = typeof args.symbol === 'string' ? args.symbol.toUpperCase() : undefined;
  if (symbol && policy.allowedSymbols.length > 0 && !policy.allowedSymbols.includes(symbol)) {
    throw new VulcanPolicyError(
      'disallowed_symbol',
      `Symbol ${symbol} is not in the Phoenix policy allowlist (${policy.allowedSymbols.join(', ')}).`,
    );
  }
  const leverage = numberArg(args, 'leverage');
  if (leverage !== undefined && leverage > policy.maxLeverage) {
    throw new VulcanPolicyError(
      'leverage_exceeded',
      `Requested leverage ${leverage}x exceeds Phoenix policy max ${policy.maxLeverage}x.`,
    );
  }
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export class VulcanPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VulcanPolicyError';
    this.code = code;
  }
}

/**
 * Sanitize a Vulcan tool name into the `solana_vulcan_<name>` MCP-tool naming convention.
 * Replaces dots, slashes, and other separators with underscores; lowercases; collapses runs.
 *
 * The `solana_vulcan_` prefix is a namespace owned by this adapter. Upstream Vulcan SHOULD NOT ship tools whose
 * names start with `solana.vulcan.` or similar — if it does, the double-prefix is preserved (we don't strip it)
 * to keep the namespacing unambiguous, but it's a smell worth raising upstream.
 *
 * Collision behavior: two upstream tools that sanitize to the same string are NOT auto-resolved here. The caller
 * (`registerVulcanTools`) tracks a per-batch `Set` and rejects the second with a recorded skip reason.
 *
 * @example
 *   sanitizeVulcanToolName('market.snapshot') // → 'solana_vulcan_market_snapshot'
 *   sanitizeVulcanToolName('trade/place-limit') // → 'solana_vulcan_trade_place_limit'
 */
export function sanitizeVulcanToolName(name: string): string {
  return `solana_vulcan_${name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')}`;
}

/**
 * Truncate a Vulcan tool description for the Agentic registration card; appends a fixed suffix noting the upstream.
 */
export function describeVulcanTool(tool: VulcanToolDescriptor, isDangerous: boolean): string {
  const head = (tool.description ?? `Vulcan upstream tool: ${tool.name}`).trim();
  const dangerNote = isDangerous
    ? ' Dangerous: routes through the Agentic prepared-action inbox; user signs explicitly before Vulcan executes.'
    : ' Read-only proxy of the upstream Vulcan tool.';
  return `${head}${dangerNote}`;
}
