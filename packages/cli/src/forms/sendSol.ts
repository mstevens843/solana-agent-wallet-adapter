import type { GlobalOptions } from '../shared/types.js';
import { input, header } from '../tui/index.js';
import { validateBase58, validatePositiveDecimal } from './validators.js';
import { fetchBalanceLines, printBalanceHeader } from './balancePreview.js';

export interface SendSolDraft {
  recipient: string;
  amountSol: string;
  note?: string;
}

export async function promptSendSolForm(
  options?: GlobalOptions,
  prefill: Partial<SendSolDraft> = {},
): Promise<SendSolDraft> {
  console.log(header('New SOL transfer'));
  if (options) {
    printBalanceHeader(await fetchBalanceLines(options));
  }
  const recipient = await input({
    message: 'Recipient address',
    ...(prefill.recipient !== undefined ? { default: prefill.recipient } : {}),
    validate: validateBase58,
  });
  const amountSol = await input({
    message: 'Amount (SOL)',
    ...(prefill.amountSol !== undefined ? { default: prefill.amountSol } : {}),
    validate: validatePositiveDecimal,
  });
  const noteRaw = await input({
    message: 'Note (optional)',
    default: prefill.note ?? '',
  });
  const draft: SendSolDraft = {
    recipient: recipient.trim(),
    amountSol: amountSol.trim(),
  };
  if (noteRaw.trim()) draft.note = noteRaw.trim();
  return draft;
}
