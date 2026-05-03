import { describe, expect, it } from 'vitest';

import { ProtocolError } from '../errors.js';
import type { ErrorCode } from '../types.js';

const cases: Array<[ErrorCode, boolean]> = [
  ['user_rejected', false],
  ['user_no_response', true],
  ['wallet_unreachable', true],
  ['invalid_request', false],
  ['unsupported_method', false],
  ['simulation_failed', true],
  ['cluster_mismatch', false],
  ['expired', true],
  ['unauthorized', false],
];

describe('ProtocolError', () => {
  it('round-trips payloads and keeps recoverability stable', () => {
    for (const [code, recoverable] of cases) {
      const error = new ProtocolError(code, `message:${code}`);
      expect(error.recoverable).toBe(recoverable);
      expect(error.toPayload()).toEqual({
        code,
        message: `message:${code}`,
        recoverable,
      });
      expect(ProtocolError.fromPayload(error.toPayload()).toPayload()).toEqual(
        error.toPayload(),
      );
    }
  });
});
