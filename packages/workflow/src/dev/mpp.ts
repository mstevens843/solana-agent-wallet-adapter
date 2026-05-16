// Phase 0 scaffolding — Phase 1 will implement validateCreateMppRequest()
// mirroring `dev/ap2.ts`. The render-web /api/mpp/* routes import this.

import { WorkflowValidationError, type WorkflowCluster } from '../index.js';
import type { MppChallenge } from '@solana-agent-wallet-adapter/mpp-adapter';

export interface MppCreate {
  challenge: MppChallenge;
  cluster?: WorkflowCluster;
  receivedAt: string;
  agentLabel?: string;
}

export function validateCreateMppRequest(_body: unknown, path = '$'): MppCreate {
  throw new WorkflowValidationError(
    'not_implemented',
    'validateCreateMppRequest is not implemented yet (Phase 1).',
    path,
  );
}
