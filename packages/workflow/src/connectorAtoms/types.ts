// Connector Action Atoms — a GROUNDING layer (capability knowledge + pre-formatted
// live facts) keyed by (connectorId, action). This is deliberately DISTINCT from the
// policy-gate atoms in agentAtoms.ts: those decide approve/deny (pass/fail); these
// make the chat + plan agents answer connector questions cheaply and plan accurately.
//
// Lives in `workflow` because it's the only package BOTH agents and both tool
// executors (server runChatReadTool + browser clientTools) import. It must NOT import
// mcp-server's connectorRegistry.ts — that would invert the dependency graph. The
// capability knowledge is therefore authored as compact static data here and guarded
// against registry drift by a test in mcp-server.

// The capability enum understood by actionService.connectorReadFacts (its `capability`
// field). Each atom maps its action onto exactly one of these.
export type ConnectorFactCapability =
  | 'earn'
  | 'borrow'
  | 'positions'
  | 'markets'
  | 'price'
  | 'tokens'
  | 'prediction'
  | 'perps'
  | 'trigger'
  | 'recurring'
  | 'swap'
  | 'oracle';

// Static capability card: what an action does + how to use it. Short and
// capability-level (stable), never parameter-level (volatile), to minimize drift.
export interface ConnectorActionKnowledge {
  title: string; // "Jupiter Lend (Earn)"
  summary: string; // one sentence
  capabilities: string[]; // ["supply to earn vaults", "read positions + APY"]
  requiredParams: string[]; // ["walletAddress for positions; assetMint for a token"]
  constraints: string[]; // distilled from registry limitations (action-relevant only)
  enabledByDefault: boolean; // false for trigger/recurring/perps/prediction (gated)
}

// The small, typed arg bag the chat tool / intent detector can fill.
export interface ConnectorFactArgs {
  walletAddress?: string;
  mint?: string;
  query?: string;
  limit?: number;
  // Swap-quote args (Jupiter swap action). Optional; only the swap factSpec reads them.
  amount?: string;
  inputToken?: string;
  outputToken?: string;
}

export interface ConnectorFactSpec {
  // The MCP read tool this maps to — documentation + single-shot intent hinting only.
  readTool: string;
  // What connectorReadFacts expects.
  capability: ConnectorFactCapability;
  // Build the connectorReadFacts input from the arg bag. May include its own
  // `capability` to override the default above. PURE.
  buildInput: (args: ConnectorFactArgs) => Record<string, unknown>;
  // PURE projection: the raw connectorReadFacts envelope -> a compact, token-efficient
  // block. Runs identically on server (after connectorReadFacts) and client (after the
  // /bridge/action/connector-read-facts call returns the same envelope).
  format: (raw: Record<string, unknown>) => Record<string, unknown>;
  // Char budget for the formatted block (final safety clamp). Default ~900.
  maxChars?: number;
}

export interface ConnectorActionAtom {
  connectorId: string; // 'jupiter' (extensible to the other 19)
  action: string; // 'lend' | 'borrow' | 'limit' | 'dca' | 'perps' | 'prediction' | 'swap' | 'portfolio'
  aliases: string[]; // action-intent matching, e.g. ['lend','earn','supply','yield']
  knowledge: ConnectorActionKnowledge;
  factSpec?: ConnectorFactSpec; // omitted for knowledge-only actions
}

export const DEFAULT_CONNECTOR_FACT_MAX_CHARS = 900;
