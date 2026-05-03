import { randomBytes } from 'node:crypto';

import type { SigningRequestId } from './types.js';

export function newSigningRequestId(): SigningRequestId {
  return `sar_${randomBytes(12).toString('hex')}`;
}
