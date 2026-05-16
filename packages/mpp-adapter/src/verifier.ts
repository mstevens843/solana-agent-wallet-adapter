// Phase 0 scaffolding — Phase 1 will implement verifyMppChallenge() and the
// canonical challenge-hash helper. Mirrors `packages/ap2-adapter/src/verifier.ts`.

import { MppVerifyError } from './errors.js';
import type { MppChallenge, MppCluster } from './types.js';

export interface VerifyMppChallengeOptions {
  clockNow: Date;
  expectedCluster?: MppCluster;
  maxAmount?: string;
  allowedMints?: readonly string[];
}

export interface VerifiedMppChallenge {
  verified: true;
  challenge: MppChallenge;
  challengeHash: string;
}

export function verifyMppChallenge(
  _challenge: MppChallenge,
  _opts: VerifyMppChallengeOptions,
): VerifiedMppChallenge {
  throw new MppVerifyError('not_implemented', 'verifyMppChallenge is not implemented yet (Phase 1).');
}

export function canonicalChallengeHash(_challenge: MppChallenge): string {
  throw new MppVerifyError('not_implemented', 'canonicalChallengeHash is not implemented yet (Phase 1).');
}
