import type { GlobalOptions } from '../shared/types.js';
import { input, select, header } from '../tui/index.js';
import { validatePositiveDecimal, validateSlippageBps, validateNonEmpty } from './validators.js';
import { fetchBalanceLines, printBalanceHeader } from './balancePreview.js';
import { maybePrintSafetyChip } from './tokenSafety.js';

export interface SwapDraft {
  amount: string;
  inputToken: string;
  outputToken: string;
  slippageBps?: number;
  note?: string;
}

const COMMON_TOKENS = [
  { name: 'SOL',  value: 'SOL' },
  { name: 'USDC', value: 'USDC' },
  { name: 'USDT', value: 'USDT' },
  { name: 'JUP',  value: 'JUP' },
  { name: 'BONK', value: 'BONK' },
  { name: 'WIF',  value: 'WIF' },
  { name: 'PYUSD', value: 'PYUSD' },
  { name: 'POPCAT', value: 'POPCAT' },
  { name: 'Other (paste mint address or symbol)', value: '__custom__' },
] as const;

async function pickToken(message: string, defaultValue: string): Promise<string> {
  const choice = await select<string>({
    message,
    default: defaultValue,
    choices: [...COMMON_TOKENS],
  });
  if (choice === '__custom__') {
    return input({
      message: 'Token symbol or mint',
      validate: validateNonEmpty,
    }).then((v) => v.trim());
  }
  return choice;
}

export async function promptSwapForm(
  options?: GlobalOptions,
  prefill: Partial<SwapDraft> = {},
): Promise<SwapDraft> {
  console.log(header('New token swap'));
  const inputToken = await pickToken('Sell token', prefill.inputToken ?? 'SOL');
  if (options) {
    await maybePrintSafetyChip(options, inputToken);
    printBalanceHeader(await fetchBalanceLines(options, inputToken));
  }
  const outputToken = await pickToken('Buy token', prefill.outputToken ?? 'USDC');
  if (options) {
    await maybePrintSafetyChip(options, outputToken);
  }
  const amount = await input({
    message: `Amount (${inputToken})`,
    ...(prefill.amount !== undefined ? { default: prefill.amount } : {}),
    validate: validatePositiveDecimal,
  });
  const slippageRaw = await input({
    message: 'Slippage (bps, blank = 50)',
    default: prefill.slippageBps !== undefined ? String(prefill.slippageBps) : '',
    validate: validateSlippageBps,
  });
  const noteRaw = await input({
    message: 'Note (optional)',
    default: prefill.note ?? '',
  });
  const draft: SwapDraft = {
    amount: amount.trim(),
    inputToken,
    outputToken,
  };
  const slippageTrimmed = slippageRaw.trim();
  if (slippageTrimmed) draft.slippageBps = Number(slippageTrimmed);
  if (noteRaw.trim()) draft.note = noteRaw.trim();
  return draft;
}
