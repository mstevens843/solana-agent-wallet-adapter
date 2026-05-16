export type StreamingErrorCode =
  | 'invalid_input'
  | 'invalid_amount'
  | 'invalid_public_key'
  | 'invalid_schema'
  | 'session_expired'
  | 'session_revoked'
  | 'session_not_active'
  | 'voucher_invalid_signature'
  | 'voucher_replay'
  | 'voucher_exceeds_remaining'
  | 'voucher_recipient_not_allowed'
  | 'not_implemented';

export class StreamingInvalidInputError extends Error {
  readonly code: StreamingErrorCode = 'invalid_input';
  constructor(message = 'Invalid streaming session input.') {
    super(message);
    this.name = 'StreamingInvalidInputError';
  }
}

export class StreamingInvalidAmountError extends Error {
  readonly code: StreamingErrorCode = 'invalid_amount';
  constructor(message = 'Amount must be a positive decimal token amount.') {
    super(message);
    this.name = 'StreamingInvalidAmountError';
  }
}

export class StreamingInvalidPublicKeyError extends Error {
  readonly code: StreamingErrorCode = 'invalid_public_key';
  constructor(message = 'Public key must be a valid base58-encoded Solana public key.') {
    super(message);
    this.name = 'StreamingInvalidPublicKeyError';
  }
}

export class StreamingInvalidSchemaError extends Error {
  readonly code: StreamingErrorCode = 'invalid_schema';
  constructor(message = 'Voucher schema is invalid.') {
    super(message);
    this.name = 'StreamingInvalidSchemaError';
  }
}

export class SessionExpiredError extends Error {
  readonly code: StreamingErrorCode = 'session_expired';
  constructor(message = 'Session has expired.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export class SessionRevokedError extends Error {
  readonly code: StreamingErrorCode = 'session_revoked';
  constructor(message = 'Session has been revoked.') {
    super(message);
    this.name = 'SessionRevokedError';
  }
}

export class SessionNotActiveError extends Error {
  readonly code: StreamingErrorCode = 'session_not_active';
  constructor(message = 'Session is not active.') {
    super(message);
    this.name = 'SessionNotActiveError';
  }
}

export class VoucherInvalidSignatureError extends Error {
  readonly code: StreamingErrorCode = 'voucher_invalid_signature';
  constructor(message = 'Voucher signature does not match the session signer.') {
    super(message);
    this.name = 'VoucherInvalidSignatureError';
  }
}

export class VoucherReplayError extends Error {
  readonly code: StreamingErrorCode = 'voucher_replay';
  constructor(message = 'Voucher nonce has already been used.') {
    super(message);
    this.name = 'VoucherReplayError';
  }
}

export class VoucherExceedsRemainingError extends Error {
  readonly code: StreamingErrorCode = 'voucher_exceeds_remaining';
  constructor(message = 'Voucher amount exceeds session remaining cap.') {
    super(message);
    this.name = 'VoucherExceedsRemainingError';
  }
}

export class VoucherRecipientNotAllowedError extends Error {
  readonly code: StreamingErrorCode = 'voucher_recipient_not_allowed';
  constructor(message = 'Voucher recipient is not in the session allowlist.') {
    super(message);
    this.name = 'VoucherRecipientNotAllowedError';
  }
}

export class StreamingNotImplementedError extends Error {
  readonly code: StreamingErrorCode = 'not_implemented';
  constructor(symbol: string) {
    super(`${symbol} is not implemented yet (Phase 2A).`);
    this.name = 'StreamingNotImplementedError';
  }
}
