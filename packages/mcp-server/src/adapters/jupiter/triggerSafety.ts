export const TRIGGER_AUTOMATION_WARNING =
  'Future Trigger fills execute through Jupiter automation; they do not return to the Agentic approval inbox.';

export const TRIGGER_CUSTODY_WARNING =
  'Order funds are deposited into a Jupiter-managed Privy custody vault, not your wallet.';

export const TRIGGER_OUTPUT_NOT_GUARANTEED_WARNING =
  'Output amount is not guaranteed at trigger time; routing happens when the trigger fires.';

export const TRIGGER_CANCEL_WITHDRAW_SEPARATE_WARNING =
  'Cancel and withdrawal are separate steps. Cancelling does not return funds to your wallet on its own.';

export const TRIGGER_EXPIRED_FUNDS_WARNING =
  'Expired or cancelled order funds remain in the Jupiter Trigger vault until you complete the withdraw flow.';

export const TRIGGER_JWT_VOLATILE_WARNING =
  'Trigger authentication is held only in volatile process memory; restart requires re-authentication.';

export const TRIGGER_HIGH_SLIPPAGE_WARNING =
  'Slippage is above the configured warn threshold; execution prioritizes certainty over price.';

export interface TriggerWarningOptions {
  includeAutomation?: boolean;
  includeCustody?: boolean;
  includeOutputNotGuaranteed?: boolean;
  includeCancelWithdrawSeparation?: boolean;
  includeExpiredFundsVault?: boolean;
  includeHighSlippage?: boolean;
}

export function triggerSummarySuffix(options: TriggerWarningOptions): string {
  const parts: string[] = [];
  if (options.includeCustody) parts.push(TRIGGER_CUSTODY_WARNING);
  if (options.includeAutomation) parts.push(TRIGGER_AUTOMATION_WARNING);
  if (options.includeOutputNotGuaranteed) parts.push(TRIGGER_OUTPUT_NOT_GUARANTEED_WARNING);
  if (options.includeCancelWithdrawSeparation) parts.push(TRIGGER_CANCEL_WITHDRAW_SEPARATE_WARNING);
  if (options.includeExpiredFundsVault) parts.push(TRIGGER_EXPIRED_FUNDS_WARNING);
  if (options.includeHighSlippage) parts.push(TRIGGER_HIGH_SLIPPAGE_WARNING);
  if (parts.length === 0) return '';
  return ` (${parts.join(' ')})`;
}

export function triggerOrderCreateWarnings(): string[] {
  return [
    TRIGGER_CUSTODY_WARNING,
    TRIGGER_AUTOMATION_WARNING,
    TRIGGER_OUTPUT_NOT_GUARANTEED_WARNING,
    TRIGGER_CANCEL_WITHDRAW_SEPARATE_WARNING,
  ];
}

export function triggerCancelWarnings(): string[] {
  return [TRIGGER_CANCEL_WITHDRAW_SEPARATE_WARNING, TRIGGER_EXPIRED_FUNDS_WARNING];
}

export function triggerEditWarnings(): string[] {
  return [TRIGGER_AUTOMATION_WARNING, TRIGGER_EXPIRED_FUNDS_WARNING];
}

export function triggerWithdrawWarnings(): string[] {
  return [TRIGGER_CUSTODY_WARNING];
}

export function triggerRegisterVaultWarnings(): string[] {
  return [TRIGGER_CUSTODY_WARNING, TRIGGER_JWT_VOLATILE_WARNING];
}
