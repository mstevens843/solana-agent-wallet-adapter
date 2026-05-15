import { assertNoForbiddenWorkflowSecrets, WorkflowValidationError } from '../index.js';

// SettlementCluster mirrors SupportedCluster in @solana-agent-wallet-adapter/bridge-router;
// the duplication is intentional to keep packages decoupled.
export type SettlementCluster = 'mainnet-beta' | 'devnet';

export interface PayerHolding {
  mint: string;
  amountRaw: string;
  decimals: number;
  usdPrice?: string;
}

export interface SettlementQuoteRequest {
  usdAmount: string;
  recipient: string;
  targetMint?: string;
  payerWallet?: string;
  cluster?: SettlementCluster;
  payerHoldings?: PayerHolding[];
  maxSlippageBps?: number;
}

const CLUSTERS = ['mainnet-beta', 'devnet'] as const;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const POSITIVE_DECIMAL_RE = /^(?!0+(?:\.0+)?$)\d+(?:\.\d{1,8})?$/;
const NON_NEGATIVE_DECIMAL_RE = /^\d+(?:\.\d+)?$/;
const UNSIGNED_INTEGER_RE = /^\d+$/;
const MAX_USD = 1_000_000;
const MAX_SLIPPAGE_BPS = 1_000;
const MAX_DECIMALS = 18;

export function validateSettlementQuoteRequest(input: unknown, path = '$'): SettlementQuoteRequest {
  assertNoForbiddenWorkflowSecrets(input, path);
  const record = requireObject(input, path);

  const usdAmount = requirePositiveDecimal(record.usdAmount, `${path}.usdAmount`);
  if (Number(usdAmount) > MAX_USD) {
    throw new WorkflowValidationError(
      'out_of_range',
      `usdAmount exceeds dev cap of ${MAX_USD}.`,
      `${path}.usdAmount`,
    );
  }
  const recipient = requireBase58(record.recipient, `${path}.recipient`);
  const targetMint = record.targetMint === undefined
    ? undefined
    : requireBase58(record.targetMint, `${path}.targetMint`);
  const payerWallet = record.payerWallet === undefined
    ? undefined
    : requireBase58(record.payerWallet, `${path}.payerWallet`);
  const cluster = record.cluster === undefined
    ? undefined
    : requireEnum(record.cluster, CLUSTERS, `${path}.cluster`);
  const maxSlippageBps = record.maxSlippageBps === undefined
    ? undefined
    : requireBoundedInteger(record.maxSlippageBps, 0, MAX_SLIPPAGE_BPS, `${path}.maxSlippageBps`);
  const payerHoldings = record.payerHoldings === undefined
    ? undefined
    : requirePayerHoldings(record.payerHoldings, `${path}.payerHoldings`);

  return {
    usdAmount,
    recipient,
    ...(targetMint !== undefined && { targetMint }),
    ...(payerWallet !== undefined && { payerWallet }),
    ...(cluster !== undefined && { cluster }),
    ...(maxSlippageBps !== undefined && { maxSlippageBps }),
    ...(payerHoldings !== undefined && { payerHoldings }),
  };
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_object', 'Expected a JSON object.', path);
  }
  return value as Record<string, unknown>;
}

function requirePositiveDecimal(value: unknown, path: string): string {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL_RE.test(value)) {
    throw new WorkflowValidationError(
      'invalid_decimal',
      'Expected a positive decimal string (e.g. "50.00").',
      path,
    );
  }
  return value;
}

function requireNonNegativeDecimal(value: unknown, path: string): string {
  if (typeof value !== 'string' || !NON_NEGATIVE_DECIMAL_RE.test(value)) {
    throw new WorkflowValidationError(
      'invalid_decimal',
      'Expected a non-negative decimal string (e.g. "1.50").',
      path,
    );
  }
  return value;
}

function requireUnsignedIntegerString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !UNSIGNED_INTEGER_RE.test(value)) {
    throw new WorkflowValidationError(
      'invalid_integer_string',
      'Expected an unsigned integer string (e.g. "1000000").',
      path,
    );
  }
  return value;
}

function requireBase58(value: unknown, path: string): string {
  if (typeof value !== 'string' || !BASE58_RE.test(value)) {
    throw new WorkflowValidationError('invalid_pubkey', 'Expected a base58 Solana pubkey.', path);
  }
  return value;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value as T[number])) {
    throw new WorkflowValidationError(
      'invalid_enum',
      `Expected one of: ${values.join(', ')}.`,
      path,
    );
  }
  return value as T[number];
}

function requireBoundedInteger(value: unknown, min: number, max: number, path: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new WorkflowValidationError(
      'out_of_range',
      `Expected an integer in [${min}, ${max}].`,
      path,
    );
  }
  return value as number;
}

function requirePayerHoldings(value: unknown, path: string): PayerHolding[] {
  if (!Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_array', 'Expected an array of holdings.', path);
  }
  return value.map((entry, index) => requireHolding(entry, `${path}[${index}]`));
}

function requireHolding(value: unknown, path: string): PayerHolding {
  const record = requireObject(value, path);
  const mint = requireBase58(record.mint, `${path}.mint`);
  const amountRaw = requireUnsignedIntegerString(record.amountRaw, `${path}.amountRaw`);
  const decimals = requireBoundedInteger(record.decimals, 0, MAX_DECIMALS, `${path}.decimals`);
  const usdPrice = record.usdPrice === undefined
    ? undefined
    : requireNonNegativeDecimal(record.usdPrice, `${path}.usdPrice`);
  return {
    mint,
    amountRaw,
    decimals,
    ...(usdPrice !== undefined && { usdPrice }),
  };
}
