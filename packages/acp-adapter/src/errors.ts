export class AcpError extends Error {
  readonly code: string;
  readonly path: string | undefined;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.path = path;
  }
}

export class AcpParseError extends AcpError {
  constructor(code: string, message: string, path?: string) {
    super(code, message, path);
    this.name = 'AcpParseError';
  }
}

export class AcpValidationError extends AcpError {
  constructor(code: string, message: string, path?: string) {
    super(code, message, path);
    this.name = 'AcpValidationError';
  }
}

export class AcpReceiptError extends AcpError {
  constructor(code: string, message: string, path?: string) {
    super(code, message, path);
    this.name = 'AcpReceiptError';
  }
}
