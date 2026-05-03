import type { SigningRequestId } from './types.js';

export function newSigningRequestId(): SigningRequestId {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `sar_${toHex(bytes)}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
