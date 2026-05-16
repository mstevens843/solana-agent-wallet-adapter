import { MppVerifyError } from './errors.js';
import {
  SOL_NATIVE_MINT,
  type JsonObject,
  type MppApprovalParams,
  type MppChallenge,
  type MppPaymentMethod,
} from './types.js';
import { canonicalChallengeHash, selectSupportedPaymentMethod, toJsonValue } from './verifier.js';

export interface ChallengeToApprovalOptions {
  paymentMethod?: MppPaymentMethod;
}

/**
 * Map a verified MPP challenge into the approval shape used by render-web and
 * the local prepared-action store.
 */
export function challengeToApprovalParams(
  challenge: MppChallenge,
  walletAddress: string,
  opts: ChallengeToApprovalOptions = {},
): MppApprovalParams {
  const paymentMethod = opts.paymentMethod ?? selectSupportedPaymentMethod(challenge);
  const kind = paymentMethod.kind === 'solana-sol' ? 'transfer_sol' : 'transfer_spl';
  const token = tokenForPayment(challenge, paymentMethod);
  const merchantOrRecipient = challenge.merchant?.name?.trim() || challenge.merchant?.id?.trim() || paymentMethod.recipient;
  const summary = `Agent requested ${challenge.amount} ${token} to ${merchantOrRecipient} via MPP. Pay to unlock ${challenge.resourceUrl}.`;
  const params: JsonObject = {
    fromAddress: walletAddress,
    toAddress: paymentMethod.recipient,
    recipient: paymentMethod.recipient,
    amount: challenge.amount,
    token,
    tokenSymbol: token,
    ...(kind === 'transfer_sol'
      ? { amountSol: challenge.amount, tokenMint: SOL_NATIVE_MINT }
      : { tokenMint: paymentMethod.mint as string }),
  };
  const metadata: JsonObject = {
    connectorId: 'mpp',
    connectorName: 'Machine Payments Protocol',
    capability: 'inbound_payment',
    operation: 'mpp_challenge',
    actionSource: 'mpp_challenge',
    approvalBoundary: 'per_run',
    mppChallengeHash: canonicalChallengeHash(challenge),
    mppChallenge: {
      protocolVersion: challenge.protocolVersion,
      resourceUrl: challenge.resourceUrl,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      ...(challenge.merchant ? { merchant: toJsonValue(challenge.merchant) } : {}),
    },
    mppPaymentMethod: toJsonValue(paymentMethod),
    actionProposal: toJsonValue(challenge),
  };
  return {
    kind,
    summary,
    cluster: paymentMethod.network,
    amount: challenge.amount,
    token,
    recipient: paymentMethod.recipient,
    params,
    metadata,
  };
}

export function tokenForPayment(challenge: MppChallenge, paymentMethod: MppPaymentMethod): string {
  if (paymentMethod.kind === 'solana-sol') return 'SOL';
  const currency = challenge.currency.trim();
  if (currency) return currency.toUpperCase();
  if (paymentMethod.mint) return paymentMethod.mint;
  throw new MppVerifyError('unsupported_rail', 'SPL payment method is missing mint/currency.', '$.paymentMethods');
}
