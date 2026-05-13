export const RECURRING_AUTOMATION_WARNING =
  'Future Jupiter Recurring fills execute through Jupiter automation without returning to the Agentic approval inbox.';

export const RECURRING_FEE_WARNING =
  'Jupiter Recurring charges a 0.1% Jupiter fee; integrator fees are not currently supported.';

export const RECURRING_PRICE_ORDER_DEPRECATED_WARNING =
  'Price-based Jupiter Recurring orders are deprecated; only manage existing price orders after explicit acceptance.';

export function recurringCreateWarnings(input: {
  hasPriceRange?: boolean;
  hasRoundingRemainder?: boolean;
} = {}): string[] {
  const warnings = [RECURRING_AUTOMATION_WARNING, RECURRING_FEE_WARNING];
  if (input.hasPriceRange) {
    warnings.push('The configured price range can delay or prevent future Recurring fills.');
  }
  if (input.hasRoundingRemainder) {
    warnings.push('The total amount is not evenly divisible by numberOfOrders; Jupiter will enforce the exact on-chain accounting.');
  }
  return warnings;
}

export function recurringCancelWarnings(): string[] {
  return [
    'Cancelling a Jupiter Recurring order requires wallet approval for Jupiter\'s cancellation transaction.',
    'Cancellation stops future Jupiter-native automation after the signed cancellation transaction lands.',
  ];
}

export function recurringPriceOrderWarnings(): string[] {
  return [RECURRING_PRICE_ORDER_DEPRECATED_WARNING, RECURRING_FEE_WARNING];
}
