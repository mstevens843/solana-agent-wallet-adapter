// Connector Action Atoms registry + lookups + compact-string builders. The single
// source both AI agents and both tool executors import. See ./types.ts for the why.

import type { ConnectorActionAtom } from './types.js';
import { JUPITER_ATOMS, clampConnectorFacts } from './jupiter.js';

export type { ConnectorActionAtom, ConnectorActionKnowledge, ConnectorFactSpec, ConnectorFactArgs, ConnectorFactCapability } from './types.js';
export { DEFAULT_CONNECTOR_FACT_MAX_CHARS } from './types.js';
export { clampConnectorFacts };

// v1 = Jupiter only. The other 19 connectors slot in by pushing atoms of the same shape.
export const CONNECTOR_ATOMS: ConnectorActionAtom[] = [...JUPITER_ATOMS];

// Connector-name tokens that gate single-shot intent detection (so a bare "lend
// position" question can't hijack a generic chat). Extend as connectors are added.
const CONNECTOR_INTENT_TOKENS: Record<string, string[]> = {
  jupiter: ['jupiter', 'jup'],
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

// Resolve an atom by connectorId (default 'jupiter') + an action key OR any of its aliases.
export function getConnectorAtom(connectorId: string | undefined, action: string | undefined): ConnectorActionAtom | undefined {
  const id = normalize(connectorId || 'jupiter');
  const want = normalize(action || '');
  if (!want) return undefined;
  return CONNECTOR_ATOMS.find((atom) =>
    atom.connectorId === id && (atom.action === want || atom.aliases.some((alias) => normalize(alias) === want)),
  );
}

export function connectorAtomsFor(connectorId: string | undefined): ConnectorActionAtom[] {
  const id = normalize(connectorId || 'jupiter');
  return CONNECTOR_ATOMS.filter((atom) => atom.connectorId === id);
}

// Single-shot intent detection: requires BOTH a connector token (e.g. "jupiter"/"jup")
// AND an action alias in the text. Returns the matching fact-bearing atom, longest
// alias first so "stop loss" beats "sl". Knowledge-only atoms are skipped (no facts to
// pre-resolve). Conservative by design — the streaming tool path lets the model pick.
export function findConnectorAtomByIntent(text: string): ConnectorActionAtom | undefined {
  const haystack = normalize(text);
  if (!haystack) return undefined;
  for (const [connectorId, tokens] of Object.entries(CONNECTOR_INTENT_TOKENS)) {
    const hasConnector = tokens.some((token) => new RegExp(`\\b${token}\\b`, 'i').test(haystack));
    if (!hasConnector) continue;
    const candidates = connectorAtomsFor(connectorId).filter((atom) => atom.factSpec);
    const ranked = candidates
      .flatMap((atom) => atom.aliases.map((alias) => ({ atom, alias: normalize(alias) })))
      .sort((a, b) => b.alias.length - a.alias.length);
    for (const { atom, alias } of ranked) {
      if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack)) return atom;
    }
  }
  return undefined;
}

// Compact global index: one short line per fact-bearing action so the model knows
// what exists and which tool to call WITHOUT a discovery round-trip. Tiny on purpose.
export function connectorCapabilityIndex(): string {
  const lines = CONNECTOR_ATOMS.map((atom) => {
    const route = atom.factSpec
      ? `get_connector_facts action=${atom.action}`
      : atom.action === 'swap'
        ? 'use get_token_price / search_tokens then propose_wallet_action'
        : 'combine action=lend + action=borrow';
    const gated = atom.knowledge.enabledByDefault ? '' : ' [enable flag]';
    return `${atom.connectorId}/${atom.action}: ${atom.knowledge.summary} (${route})${gated}`;
  });
  return lines.join('\n');
}

// Full knowledge card for one selected action (~300-500 chars).
export function connectorActionCard(atom: ConnectorActionAtom | undefined): string {
  if (!atom) return '';
  const k = atom.knowledge;
  const gated = k.enabledByDefault ? '' : ' — disabled until its flag is enabled';
  return [
    `${k.title} (${atom.connectorId}/${atom.action})${gated}`,
    k.summary,
    `Can: ${k.capabilities.join('; ')}`,
    `Needs: ${k.requiredParams.join('; ')}`,
    ...(k.constraints.length ? [`Notes: ${k.constraints.join('; ')}`] : []),
  ].join('\n');
}

// Shape carried in request.context.connectorContext (index always; card on selection).
export interface ConnectorContextBlock {
  index?: string;
  card?: string;
}

// Build the connectorContext block. selected = the connector+action from the dropdown,
// when present. Index is always included so the model knows the surface even with no
// selection.
export function buildConnectorContext(selected?: { connectorId?: string; action?: string }): ConnectorContextBlock {
  const card = selected ? connectorActionCard(getConnectorAtom(selected.connectorId, selected.action)) : '';
  return compactBlock({ index: connectorCapabilityIndex(), ...(card ? { card } : {}) });
}

function compactBlock(block: ConnectorContextBlock): ConnectorContextBlock {
  const out: ConnectorContextBlock = {};
  if (block.index) out.index = block.index;
  if (block.card) out.card = block.card;
  return out;
}
