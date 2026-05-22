import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest, tryBridgeRequest } from '../http/index.js';
import { confirm, badge, header, kv, divider } from '../tui/index.js';
import type { AiAdvice } from '../forms/aiEnhance.js';

const STABLES = new Set(['USDC', 'USDT', 'PYUSD', 'USDH', 'DAI']);

// Threshold above which mainnet transactions get an extra confirmation step.
// $50 covers most casual sends without nagging; chunky transactions hit the gate.
// Override per-process via AGENTIC_MAINNET_THRESHOLD_USD (positive number).
function getMainnetThreshold(): number {
  const raw = process.env.AGENTIC_MAINNET_THRESHOLD_USD;
  if (!raw) return 50;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return parsed;
}

export interface QueueEstimate {
  amount: string;
  token: string;
}

// Returns true to proceed, false to cancel. Always returns true on non-mainnet
// or when the action doesn't have a clear USD value AND no AI advice flags risk.
export async function confirmHighStakes(
  options: GlobalOptions,
  summary: string,
  estimate: QueueEstimate | null,
  advice?: AiAdvice | null,
): Promise<boolean> {
  // High-risk AI advice gates first — independent of cluster.
  if (advice?.riskLevel === 'high') {
    console.log(badge('AI flagged this plan as HIGH risk.', 'warn'));
    const proceed = await confirm({
      message: `Continue anyway? — ${summary}`,
      default: false,
    });
    if (!proceed) return false;
  }

  const cluster = await fetchCluster(options);
  if (!isMainnetCluster(cluster)) return true;
  if (!estimate) return true;

  const usd = await estimateUsdValue(options, estimate);
  if (usd === null) {
    // Couldn't price it — fail closed: show a soft gate so the user is aware
    // they're operating on mainnet with an unknown value.
    console.log();
    console.log(header('Mainnet — value unknown'));
    console.log(kv([
      ['Summary', summary],
      ['Token', estimate.token],
      ['Amount', estimate.amount],
      ['USD', badge('could not estimate', 'muted')],
    ]));
    console.log(divider());
    return confirm({ message: 'Proceed on mainnet?', default: false });
  }
  if (usd < getMainnetThreshold()) return true;

  console.log();
  console.log(header('Mainnet — value confirmation'));
  console.log(kv([
    ['Summary', summary],
    ['Amount', `${estimate.amount} ${estimate.token}`],
    ['USD value', `${badge(`~ $${usd.toFixed(2)}`, 'warn')}  (mainnet threshold $${getMainnetThreshold()})`],
  ]));
  console.log(divider());
  return confirm({
    message: 'This will move real value on mainnet. Continue?',
    default: false,
  });
}

async function fetchCluster(options: GlobalOptions): Promise<string> {
  const status = await tryBridgeRequest<{ cluster?: string }>(options, '/bridge/action/status');
  if (status.ok && status.value.cluster) return status.value.cluster;
  return 'unknown';
}

// Matches any mainnet variant: 'mainnet', 'mainnet-beta', 'mainnet-beta-dev', …
// Defensively returns false for empty or 'unknown' so the gate doesn't fire on
// network-down conditions (the connect flow already prevents that path).
export function isMainnetCluster(cluster?: string | null): boolean {
  if (!cluster) return false;
  const lower = cluster.toLowerCase();
  return lower === 'mainnet' || lower.startsWith('mainnet-') || lower.startsWith('mainnet.');
}

// Best-effort: returns USD-equivalent, or null if pricing failed.
// Stables → direct; everything else → a Jupiter quote to USDC via the bridge.
async function estimateUsdValue(options: GlobalOptions, estimate: QueueEstimate): Promise<number | null> {
  const amount = Number(estimate.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const token = estimate.token.trim().toUpperCase();
  if (STABLES.has(token)) return amount;

  try {
    const quote = await bridgeRequest<Record<string, unknown>>(options, '/bridge/action/swap-quote', {
      method: 'POST',
      body: JSON.stringify({
        amount: estimate.amount,
        inputToken: estimate.token,
        outputToken: 'USDC',
      }),
    });
    const out = quote.outAmount ?? quote.outputAmount ?? quote.expectedOutput;
    if (typeof out === 'string' || typeof out === 'number') {
      const n = Number(out);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  } catch {
    return null;
  }
}

// Tries to extract a {amount, token} pair from a draft, regardless of which
// form produced it. Returns null if there isn't a useful price target.
export function estimateFromDraft(draft: unknown): QueueEstimate | null {
  if (!draft || typeof draft !== 'object') return null;
  const d = draft as Record<string, unknown>;

  // sendSol — { amountSol, recipient, note }
  if (typeof d['amountSol'] === 'string') {
    return { amount: d['amountSol'] as string, token: 'SOL' };
  }
  // sendSpl — { token, amount, recipient }
  if (typeof d['token'] === 'string' && typeof d['amount'] === 'string') {
    return { amount: d['amount'] as string, token: d['token'] as string };
  }
  // swap — { amount, inputToken, outputToken }
  if (typeof d['inputToken'] === 'string' && typeof d['amount'] === 'string') {
    return { amount: d['amount'] as string, token: d['inputToken'] as string };
  }
  return null;
}
