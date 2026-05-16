// Phase 0 scaffolding — Phase 1 will implement buildMppPaymentReceipt() with
// deterministic canonical-JSON hashing, mirroring `packages/ap2-adapter/src/receipt.ts`.

import { MppReceiptError } from './errors.js';
import type { MppChallenge, MppCluster, MppCredential, MppReceipt } from './types.js';

export interface BuildMppPaymentReceiptInput {
  challenge: MppChallenge;
  credential: MppCredential;
  walletAddress: string;
  cluster: MppCluster;
  txid?: string;
  settledAt: string;
  issuedAt?: string;
}

export function buildMppPaymentReceipt(_input: BuildMppPaymentReceiptInput): MppReceipt {
  throw new MppReceiptError('not_implemented', 'buildMppPaymentReceipt is not implemented yet (Phase 1).');
}

export function parseMppPaymentReceipt(_value: unknown): MppReceipt {
  throw new MppReceiptError('not_implemented', 'parseMppPaymentReceipt is not implemented yet (Phase 1).');
}

export function verifyMppPaymentReceiptHash(_receipt: MppReceipt): boolean {
  throw new MppReceiptError('not_implemented', 'verifyMppPaymentReceiptHash is not implemented yet (Phase 1).');
}
