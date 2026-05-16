export type MppErrorCode =
  | 'invalid_json'
  | 'forbidden_secret'
  | 'oversize_payload'
  | 'missing_field'
  | 'invalid_field'
  | 'invalid_schema'
  | 'unsupported_protocol'
  | 'invalid_expiry'
  | 'expired_challenge'
  | 'unsupported_rail'
  | 'mint_not_allowed'
  | 'amount_exceeds_cap'
  | 'invalid_signature'
  | 'receipt_hash_mismatch';

export class MppParseError extends Error {
  readonly path?: string;

  constructor(readonly code: MppErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'MppParseError';
    if (path !== undefined) this.path = path;
  }
}

export class MppVerifyError extends Error {
  readonly path?: string;

  constructor(readonly code: MppErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'MppVerifyError';
    if (path !== undefined) this.path = path;
  }
}

export class MppReceiptError extends Error {
  readonly path?: string;

  constructor(readonly code: MppErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'MppReceiptError';
    if (path !== undefined) this.path = path;
  }
}
