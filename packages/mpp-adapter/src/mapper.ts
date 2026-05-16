// Phase 0 scaffolding — Phase 1 will implement challengeToApprovalParams()
// producing { kind: 'transfer_sol' | 'transfer_spl', summary, cluster, amount,
// token, recipient, params, metadata: { connectorId: 'mpp', mppChallenge: {...} } }.

import { MppVerifyError } from './errors.js';
import type { JsonObject, MppChallenge, MppCluster } from './types.js';

export interface MppApprovalParams {
  kind: 'transfer_sol' | 'transfer_spl';
  summary: string;
  cluster: MppCluster;
  amount: string;
  token: string;
  recipient: string;
  params: JsonObject;
  metadata: JsonObject;
}

export function challengeToApprovalParams(
  _challenge: MppChallenge,
  _walletAddress: string,
): MppApprovalParams {
  throw new MppVerifyError(
    'not_implemented',
    'challengeToApprovalParams is not implemented yet (Phase 1).',
  );
}
