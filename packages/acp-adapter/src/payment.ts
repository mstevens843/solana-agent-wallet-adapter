import type { AcpCartValidationResult, AcpTransferParams } from './types.js';

export interface CartToTransferOptions {
  readonly dueAt?: string;
  readonly note?: string;
}

export function cartToTransferParams(
  validated: AcpCartValidationResult,
  options: CartToTransferOptions = {},
): AcpTransferParams {
  const { cart } = validated;
  const dueAt = options.dueAt ?? cart.expiresAt;
  const note = options.note ?? cart.memo ?? `ACP cart ${cart.id}: ${cart.merchant.name}`;
  return Object.freeze({
    token: cart.paymentToken,
    recipient: cart.merchant.recipient,
    amount: validated.transferAmount,
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(note !== undefined ? { note } : {}),
  });
}
