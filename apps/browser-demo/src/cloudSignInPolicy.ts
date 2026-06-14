export interface AndroidSiwsCloudSignInPolicyInput {
  isAndroidNative: boolean;
  hasWalletAddress: boolean;
  siwsFastPathEnabled?: boolean;
}

export function shouldUseAndroidSiwsCloudSignIn(input: AndroidSiwsCloudSignInPolicyInput): boolean {
  return input.siwsFastPathEnabled === true && input.isAndroidNative && !input.hasWalletAddress;
}

export function shouldFallbackToProofAfterAndroidSiwsError(err: unknown): boolean {
  if (isUserRejectedWalletAction(err)) return false;
  return isAndroidSiwsUnsupported(err) || isRecoverableAndroidSiwsCloudAuthFailure(err);
}

export function isAndroidSiwsUnsupported(err: unknown): boolean {
  if (errorCode(err) === 'unsupported_method') return true;
  const message = errorMessage(err);
  return /SIWS_UNSUPPORTED_FOR_WALLET/i.test(message) ||
    /unsupported(?:\s+\S+){0,5}\s+(?:SIWS|Sign In With Solana)/i.test(message) ||
    /(?:SIWS|Sign In With Solana)(?:\s+\S+){0,5}\s+unsupported/i.test(message);
}

export function isRecoverableAndroidSiwsCloudAuthFailure(err: unknown): boolean {
  if (isUserRejectedWalletAction(err)) return false;
  const message = errorMessage(err);
  return /Wallet signature could not be verified/i.test(message) ||
    /Signed SIWS message does not match auth nonce/i.test(message) ||
    /Signed (?:domain|issued time|expiration time) does not match auth nonce/i.test(message) ||
    /Signed domain does not match this server/i.test(message) ||
    /Invalid or already used auth nonce/i.test(message) ||
    /Auth nonce has expired/i.test(message) ||
    /Sign in to Agentic Cloud before using cloud workflow actions/i.test(message) ||
    /\bunauthori[sz]ed\b/i.test(message);
}

function isUserRejectedWalletAction(err: unknown): boolean {
  if (errorCode(err) === 'user_rejected') return true;
  return /\b(user rejected|user denied|wallet rejected|wallet denied|cancelled|canceled|dismissed)\b/i.test(errorMessage(err));
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return '';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}
