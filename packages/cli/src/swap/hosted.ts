import type { GlobalOptions } from '../shared/types.js';
import { renderWebRequest, tryBridgeRequest } from '../http/index.js';

interface WalletStatus {
  connected?: boolean;
  address?: string | null;
}

export interface HostedSwapInput {
  amount: string;
  inputToken?: string;
  outputToken?: string;
  slippageBps?: number;
  taker?: string;
}

interface KnownSwapToken {
  mint: string;
  decimals: number;
}

const KNOWN_SWAP_TOKENS: Record<string, KnownSwapToken> = {
  SOL: { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4q35zyGZbT3p2kJ9c1J4', decimals: 6 },
  JUP: { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
  BONK: { mint: 'DezXAZ8z7PnrnRJjz3ZnQ1pV38hZF5jB8L7S9vcFEzX', decimals: 5 },
  WIF: { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLzD3cJbKJ4n', decimals: 6 },
};

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function tryHostedSwapOrder(
  options: GlobalOptions,
  input: HostedSwapInput,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: unknown }> {
  try {
    const normalized = await hostedSwapOrderBody(options, input);
    return {
      ok: true,
      value: await renderWebRequest<Record<string, unknown>>(options, '/api/swap/order', {
        method: 'POST',
        body: JSON.stringify(normalized),
      }, { label: 'Jupiter hosted swap' }),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

async function hostedSwapOrderBody(
  options: GlobalOptions,
  input: HostedSwapInput,
): Promise<Record<string, unknown>> {
  const inputToken = resolveKnownSwapToken(input.inputToken ?? 'SOL', 'input token');
  const outputToken = resolveKnownSwapToken(input.outputToken ?? 'USDC', 'output token');
  const taker = input.taker?.trim() || await connectedWallet(options);
  if (!taker) {
    throw new Error('Connect a wallet before using hosted Jupiter swap quotes.');
  }
  return {
    inputMint: inputToken.mint,
    outputMint: outputToken.mint,
    amount: decimalToRawAmount(input.amount, inputToken.decimals),
    taker,
    ...(input.slippageBps !== undefined ? { slippageBps: input.slippageBps } : {}),
  };
}

async function connectedWallet(options: GlobalOptions): Promise<string | null> {
  const status = await tryBridgeRequest<WalletStatus>(options, '/bridge/action/status');
  if (!status.ok || !status.value.connected) return null;
  return status.value.address?.trim() || null;
}

function resolveKnownSwapToken(token: string, label: string): KnownSwapToken {
  const trimmed = token.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  const known = KNOWN_SWAP_TOKENS[trimmed.toUpperCase()];
  if (known) return known;
  if (MINT_RE.test(trimmed)) {
    throw new Error(`Hosted swap needs a known token symbol so it can convert ${label} amounts safely. Use the local bridge for custom mint ${trimmed}.`);
  }
  throw new Error(`Hosted swap does not know ${label} "${token}". Use SOL, USDC, USDT, JUP, BONK, WIF, or the local bridge.`);
}

function decimalToRawAmount(amount: string, decimals: number): string {
  const trimmed = amount.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(trimmed)) {
    throw new Error(`Swap amount must be a positive decimal string; got "${amount}".`);
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Swap amount has too many decimal places for this token; max ${decimals}.`);
  }
  const scale = 10n ** BigInt(decimals);
  const wholeRaw = BigInt(whole) * scale;
  const fractionRaw = BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  const raw = wholeRaw + fractionRaw;
  if (raw <= 0n) {
    throw new Error('Swap amount must be greater than zero.');
  }
  return raw.toString();
}
