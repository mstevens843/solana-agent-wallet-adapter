import type { ErrorCode, ProtocolErrorPayload } from './types.js';

const RECOVERABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  'user_no_response',
  'wallet_unreachable',
  'simulation_failed',
  'expired',
]);

export class ProtocolError extends Error implements ProtocolErrorPayload {
  readonly code: ErrorCode;
  readonly recoverable: boolean;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProtocolError';
    this.code = code;
    this.recoverable = RECOVERABLE_CODES.has(code);
  }

  toPayload(): ProtocolErrorPayload {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
    };
  }

  static fromPayload(payload: ProtocolErrorPayload): ProtocolError {
    return new ProtocolError(payload.code, payload.message);
  }
}
