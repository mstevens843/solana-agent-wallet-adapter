import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';
import { badge } from '../tui/index.js';

// Best-effort token safety chip rendered after the user picks a token.
// Failures are silent — the form proceeds without the chip. Common tokens
// (USDC, SOL, etc.) skip the lookup since they're already in the curated list.
const SKIP_SYMBOLS = new Set(['SOL', 'USDC', 'USDT', 'JUP', 'BONK', 'WIF', 'PYUSD', 'POPCAT']);
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function maybePrintSafetyChip(options: GlobalOptions, tokenOrMint: string): Promise<void> {
  const trimmed = tokenOrMint.trim();
  if (!trimmed) return;
  if (SKIP_SYMBOLS.has(trimmed.toUpperCase())) return;
  // Only call for what looks like a mint address; symbols would need a separate
  // resolution step and aren't worth the extra round-trip for now.
  if (!MINT_RE.test(trimmed)) return;

  try {
    const raw = await bridgeRequest<Record<string, unknown>>(options, '/bridge/action/token-safety-evidence', {
      method: 'POST',
      body: JSON.stringify({ mint: trimmed }),
    });
    const chip = summarizeSafety(raw);
    if (chip) console.log(chip);
  } catch {
    // Token safety is advisory — never block the flow.
  }
}

function summarizeSafety(raw: Record<string, unknown>): string | null {
  const verified = pickBool(raw, ['verified', 'jupiterVerified', 'isVerified']);
  const risk = pickField(raw, ['riskLevel', 'risk', 'riskRating']);
  const score = pickField(raw, ['safetyScore', 'score']);
  const flags: string[] = [];
  if (verified === true) flags.push(badge('verified', 'ok'));
  else if (verified === false) flags.push(badge('unverified', 'warn'));
  if (typeof risk === 'string' && risk) {
    const tone = risk.toLowerCase() === 'high' ? 'err' : risk.toLowerCase() === 'medium' ? 'warn' : 'muted';
    flags.push(badge(`risk: ${risk}`, tone));
  }
  if (score !== undefined) flags.push(badge(`score ${score}`, 'muted'));
  if (flags.length === 0) return null;
  return `  ${flags.join('  ·  ')}`;
}

function pickField(obj: Record<string, unknown>, keys: string[]): string | number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number') return v;
  }
  return undefined;
}

function pickBool(obj: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}
