/**
 * Shared bridge so dev-tab modules can ask the connected wallet to sign a
 * cloud-flow message without reaching into `main.ts` module-private state.
 * `main.ts` calls `setCloudWalletBridge({ signMessage, cloudRequest })` at
 * boot; dev-tab modules call the exported helpers below.
 */

export interface CloudWalletSignResult {
  signature: string;
  encoding: 'base58';
  /**
   * Phantom Mobile MWA cannot signMessage, so for that wallet we sign a memo-only
   * throwaway transaction whose memo data == the proof bytes (see
   * `walletProofSigning.ts`). Server-side verifiers must accept both encodings.
   * Absent / 'utf8-message' = the wallet signed the UTF-8 message bytes directly.
   */
  proofEncoding?: 'utf8-message' | 'tx-memo-proof';
  proofTxBase64?: string;
  proofMemoText?: string;
}

export interface CloudWalletBridge {
  signMessage(message: string, summary: string): Promise<CloudWalletSignResult>;
  cloudRequest<T>(path: string, init?: RequestInit): Promise<T>;
}

let bridge: CloudWalletBridge | null = null;

export function setCloudWalletBridge(impl: CloudWalletBridge): void {
  bridge = impl;
}

export function cloudWalletAvailable(): boolean {
  return bridge !== null;
}

export async function cloudWalletSignMessage(message: string, summary: string): Promise<CloudWalletSignResult> {
  if (!bridge) throw new Error('Wallet bridge is not ready. Connect a wallet first.');
  return bridge.signMessage(message, summary);
}

export async function cloudWalletRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (!bridge) throw new Error('Wallet bridge is not ready. Connect a wallet first.');
  return bridge.cloudRequest<T>(path, init);
}
