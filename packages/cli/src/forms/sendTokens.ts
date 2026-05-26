import type { GlobalOptions } from '../shared/types.js';
import { input, select, header } from '../tui/index.js';
import { validateBase58, validatePositiveDecimal, validateNonEmpty } from './validators.js';
import { fetchBalanceLines, printBalanceHeader } from './balancePreview.js';
import { maybePrintSafetyChip } from './tokenSafety.js';

export interface SendTokensDraft {
  token: string;
  recipient: string;
  amount: string;
  note?: string;
}

export interface SendTokensFormOptions {
  defaultToken?: string;
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

export async function promptSendTokensForm(
  options?: GlobalOptions,
  prefill: Partial<SendTokensDraft> = {},
  formOptions: SendTokensFormOptions = {},
): Promise<SendTokensDraft> {
  console.log(header('New token transfer'));
  const fallback = formOptions.defaultToken && COMMON_TOKENS.some((t) => t.value === formOptions.defaultToken)
    ? formOptions.defaultToken
    : 'SOL';
  const defaultToken = prefill.token && COMMON_TOKENS.some((t) => t.value === prefill.token)
    ? prefill.token
    : fallback;
  let token = await select<string>({
    message: 'Token',
    default: defaultToken,
    choices: [...COMMON_TOKENS],
  });
  if (token === '__custom__') {
    token = await input({
      message: 'Token symbol or mint address',
      validate: validateNonEmpty,
    });
  }
  if (options) {
    await maybePrintSafetyChip(options, token);
    printBalanceHeader(await fetchBalanceLines(options, token));
  }
  const recipient = await input({
    message: 'Recipient address',
    ...(prefill.recipient !== undefined ? { default: prefill.recipient } : {}),
    validate: validateBase58,
  });
  const amount = await input({
    message: `Amount (${token})`,
    ...(prefill.amount !== undefined ? { default: prefill.amount } : {}),
    validate: validatePositiveDecimal,
  });
  const noteRaw = await input({
    message: 'Note (optional)',
    default: prefill.note ?? '',
  });
  const draft: SendTokensDraft = {
    token: token.trim(),
    recipient: recipient.trim(),
    amount: amount.trim(),
  };
  if (noteRaw.trim()) draft.note = noteRaw.trim();
  return draft;
}
