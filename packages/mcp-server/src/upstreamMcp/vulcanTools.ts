import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodTypeAny } from 'zod';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import type { AgentWalletConfig } from '../config.js';
import type { AddPreparedActionInput, PreparedActionStore } from '../preparedActions.js';
import {
  VulcanPolicyError,
  assertVulcanDangerousCallAllowed,
  describeVulcanTool,
  isDangerousTool,
  sanitizeVulcanToolName,
} from './vulcanPolicy.js';
import type { VulcanToolDescriptor, VulcanUpstreamClient } from './vulcanClient.js';
import { recordVulcanCall, type VulcanMetricsRegistry } from './vulcanMetrics.js';

/**
 * Trace event taxonomy for Vulcan upstream activity. Use `VULCAN_TRACE.upstream.*` for bridge/client-lifecycle
 * events (start, connect, register, crash) and `VULCAN_TRACE.tool.*` for per-call events (invoke, error). Keeping
 * the prefixes disjoint makes filtering in the trace stream straightforward.
 */
export const VULCAN_TRACE = {
  upstream: {
    connected: 'vulcan.upstream.connected',
    toolsReady: 'vulcan.upstream.tools_ready',
    startFailed: 'vulcan.upstream.start_failed',
    configSkipped: 'vulcan.upstream.config_skipped',
    registerFailed: 'vulcan.upstream.register_failed',
    crashed: 'vulcan.upstream.crashed',
  },
  tool: {
    queued: 'vulcan.tool.queued',
    invoked: 'vulcan.tool.invoked',
    rejected: 'vulcan.tool.rejected',
    skipped: 'vulcan.tool.skipped',
  },
} as const;

export interface RegisterVulcanToolsOptions {
  server: McpServer;
  client: VulcanUpstreamClient;
  config: AgentWalletConfig;
  /** Returns the wallet address for the active session (used as preparedAction.walletAddress). */
  getWalletAddress: () => Promise<string>;
  /** Returns the prepared-action store; null/undefined if the bridge runs without an inbox (no dangerous tools registered then). */
  getStore: () => PreparedActionStore | undefined;
  /** Optional trace hook for parity with Agentic's `traceTool`. Defaults to a no-op. */
  trace?: (event: string, payload: Record<string, unknown>) => void;
  /** Optional metrics registry — when supplied, per-call latency/error counters land here for the status surface. */
  metrics?: VulcanMetricsRegistry;
}

export interface VulcanRegistrationSummary {
  /** Sanitized names of read-only tools that successfully registered (e.g., `solana_vulcan_market_snapshot`). */
  readonly: string[];
  /** Sanitized names of dangerous tools that registered into the prepared-action inbox path. */
  dangerous: string[];
  /** Tools that were skipped, with a reason (collision, missing store, malformed schema, etc.). */
  skipped: { name: string; reason: string }[];
}

/**
 * Enumerate upstream Vulcan tools and re-export them on the Agentic MCP server as `solana_vulcan_*`.
 *
 * Read tools forward directly. Dangerous tools are intercepted: rather than calling the upstream, the proxy
 * builds an AddPreparedActionInput with `kind: 'phoenix_vulcan_call'` and queues it via `store.addAction(...)`.
 * The user then approves in Agentic's Spend tab → `solana_execute_prepared_action` runs the
 * `executePreparedVulcanCall` path which forwards to Vulcan with `acknowledged: true`.
 *
 * Collision protection: two upstream tools that sanitize to the same `solana_vulcan_*` name are caught here;
 * the second is skipped with a recorded reason so the operator can rename one upstream.
 */
export async function registerVulcanTools(opts: RegisterVulcanToolsOptions): Promise<VulcanRegistrationSummary> {
  const tools = await opts.client.listTools();
  const summary: VulcanRegistrationSummary = { readonly: [], dangerous: [], skipped: [] };
  const seen = new Map<string, string>(); // sanitized → original

  for (const tool of tools) {
    if (!tool.name.trim()) {
      summary.skipped.push({ name: '', reason: 'empty tool name' });
      continue;
    }
    const registeredName = sanitizeVulcanToolName(tool.name);
    const previous = seen.get(registeredName);
    if (previous) {
      const reason = `duplicate sanitized name "${registeredName}"; original tool "${previous}" already registered`;
      summary.skipped.push({ name: tool.name, reason });
      opts.trace?.(VULCAN_TRACE.tool.skipped, { tool: tool.name, reason });
      continue;
    }
    const dangerous = isDangerousTool(tool);
    if (dangerous && !opts.getStore()) {
      const reason = 'dangerous tool but prepared-action store is unavailable';
      summary.skipped.push({ name: tool.name, reason });
      opts.trace?.(VULCAN_TRACE.tool.skipped, { tool: tool.name, reason });
      continue;
    }
    registerOne(opts, tool, dangerous);
    seen.set(registeredName, tool.name);
    if (dangerous) summary.dangerous.push(registeredName);
    else summary.readonly.push(registeredName);
  }

  opts.trace?.(VULCAN_TRACE.upstream.toolsReady, {
    readonly: summary.readonly.length,
    dangerous: summary.dangerous.length,
    skipped: summary.skipped.length,
  });
  return summary;
}

function registerOne(
  opts: RegisterVulcanToolsOptions,
  tool: VulcanToolDescriptor,
  dangerous: boolean,
): void {
  const registeredName = sanitizeVulcanToolName(tool.name);
  const description = describeVulcanTool(tool, dangerous);
  const inputSchema = deriveInputSchema(tool);
  opts.server.registerTool(
    registeredName,
    { description, inputSchema },
    async (rawArgs) => handleCall(opts, tool, dangerous, rawArgs as Record<string, unknown>),
  );
}

async function handleCall(
  opts: RegisterVulcanToolsOptions,
  tool: VulcanToolDescriptor,
  dangerous: boolean,
  rawArgs: Record<string, unknown>,
) {
  const args = normalizeArgs(rawArgs, tool);
  try {
    if (dangerous) {
      assertVulcanDangerousCallAllowed(opts.config, args);
      const store = opts.getStore();
      if (!store) {
        throw new ProtocolError(
          'unsupported_method',
          `Vulcan dangerous tool ${tool.name} cannot be queued: prepared-action store is unavailable.`,
        );
      }
      const walletAddress = await opts.getWalletAddress();
      const summary = describeQueuedCall(tool, args);
      // D4: extract optional vulcanWalletName so the multi-wallet registry can route at execute time. We pull it
      // OUT of vulcanArgs so it doesn't get forwarded back to Vulcan (which treats wallet selection via env var,
      // not per-call args).
      const { vulcanWalletName, ...vulcanArgs } = extractWalletName(args);
      const params: Record<string, unknown> = { vulcanToolName: tool.name, vulcanArgs };
      if (vulcanWalletName !== undefined) params.vulcanWalletName = vulcanWalletName;
      const addInput: AddPreparedActionInput = {
        kind: 'phoenix_vulcan_call',
        walletAddress,
        cluster: opts.config.cluster,
        summary,
        params,
      };
      const stored = await store.addAction(addInput);
      opts.trace?.(VULCAN_TRACE.tool.queued, { tool: tool.name, actionId: stored.id });
      return jsonReply({ preparedAction: stored, upstreamTool: tool.name });
    }
    opts.trace?.(VULCAN_TRACE.tool.invoked, { tool: tool.name });
    const result = opts.metrics
      ? await recordVulcanCall(opts.metrics, tool.name, () => opts.client.callTool(tool.name, args))
      : await opts.client.callTool(tool.name, args);
    return jsonReply({ upstreamTool: tool.name, result });
  } catch (err) {
    opts.trace?.(VULCAN_TRACE.tool.rejected, {
      tool: tool.name,
      message: err instanceof Error ? err.message : String(err),
    });
    return errorReply(err, tool.name);
  }
}

/**
 * Best-effort translation of the upstream JSON-schema `properties` into a flat record of permissive Zod fields.
 *
 * We don't try to mirror types — every field becomes `z.unknown().optional()`. The actual validation runs on
 * Vulcan's side; this just gives the Agentic-side AI a list of known argument names per tool.
 *
 * When the upstream schema is missing or unparseable, we fall back to a single `args` record so the user can pass
 * arbitrary arguments through.
 */
function deriveInputSchema(tool: VulcanToolDescriptor): Record<string, ZodTypeAny> {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') return { args: argsRecordSchema() };
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== 'object') return { args: argsRecordSchema() };
  const fields: Record<string, ZodTypeAny> = {};
  for (const key of Object.keys(properties as Record<string, unknown>)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    fields[key] = z.unknown().optional();
  }
  if (Object.keys(fields).length === 0) return { args: argsRecordSchema() };
  return fields;
}

function argsRecordSchema(): ZodTypeAny {
  return z.record(z.unknown()).optional().describe('Arguments forwarded to the upstream Vulcan tool.');
}

/**
 * Accept either flat fields (e.g. `{ symbol: "SOL-PERP" }`) or a wrapper (`{ args: { symbol: "SOL-PERP" } }`).
 * Returns the flat object that gets forwarded to Vulcan.
 *
 * Safety gate: if the upstream tool's own schema declares an `args` property, we DON'T unwrap — the user really
 * meant to pass it as a real argument. This protects against the (rare but real) case where Vulcan ships a tool
 * that takes a literal `args` field.
 */
function normalizeArgs(rawArgs: Record<string, unknown>, tool: VulcanToolDescriptor): Record<string, unknown> {
  const upstreamHasArgsField = upstreamSchemaDefinesArgs(tool);
  if (upstreamHasArgsField) return rawArgs;
  const keys = Object.keys(rawArgs);
  if (
    keys.length === 1 &&
    keys[0] === 'args' &&
    rawArgs.args &&
    typeof rawArgs.args === 'object' &&
    !Array.isArray(rawArgs.args)
  ) {
    return rawArgs.args as Record<string, unknown>;
  }
  return rawArgs;
}

function upstreamSchemaDefinesArgs(tool: VulcanToolDescriptor): boolean {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') return false;
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(properties, 'args');
}

/**
 * Pull `vulcanWalletName` out of the args record (if present) so it doesn't leak into the upstream call. Returns
 * the remainder + the extracted wallet name. The wallet name lives at the prepare-action layer (D4 routing key);
 * Vulcan itself selects wallets via the `VULCAN_WALLET_NAME` env var at subprocess spawn time, not per-call.
 */
function extractWalletName(
  args: Record<string, unknown>,
): { vulcanWalletName?: string } & Record<string, unknown> {
  const raw = args.vulcanWalletName;
  const walletName = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  const { vulcanWalletName: _drop, ...rest } = args;
  void _drop;
  return walletName !== undefined ? { vulcanWalletName: walletName, ...rest } : rest;
}

function describeQueuedCall(tool: VulcanToolDescriptor, args: Record<string, unknown>): string {
  const symbol = typeof args.symbol === 'string' ? args.symbol : undefined;
  const side = typeof args.side === 'string' ? args.side : undefined;
  const baseSize = args.baseSize ?? args.amount;
  const leverage = typeof args.leverage === 'number' ? `${args.leverage}x` : undefined;
  const parts = [`Phoenix via Vulcan: ${tool.name}`];
  if (symbol) parts.push(symbol);
  if (side) parts.push(side.toUpperCase());
  if (baseSize !== undefined) parts.push(String(baseSize));
  if (leverage) parts.push(leverage);
  return parts.join(' · ');
}

function jsonReply(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorReply(err: unknown, toolName: string) {
  const protocolErr = toProtocolError(err, toolName);
  const payload = protocolErr.toPayload();
  return {
    content: [
      {
        type: 'text' as const,
        text: `Vulcan upstream tool error (${toolName}).\n\nCode: ${payload.code}\nMessage: ${payload.message}`,
      },
    ],
    isError: true,
  };
}

function toProtocolError(err: unknown, toolName: string): ProtocolError {
  if (err instanceof ProtocolError) return err;
  if (err instanceof VulcanPolicyError) {
    return new ProtocolError('invalid_request', `${toolName}: ${err.message}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ProtocolError('unsupported_method', `Vulcan tool ${toolName} failed: ${message}`);
}
