function parseList(value: string): readonly string[] {
  return Object.freeze(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export function devWalletAllowlist(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return parseList(env.AGENTIC_DEV_WALLET_ALLOWLIST ?? '');
}

export function deviceAgentWalletAllowlist(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return parseList(env.AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST ?? '');
}

export const DEV_WALLET_ALLOWLIST: readonly string[] = devWalletAllowlist();
export const DEVICE_AGENT_WALLET_ALLOWLIST: readonly string[] = deviceAgentWalletAllowlist();

export function isAllowedDevWallet(walletAddress: string | undefined | null): boolean {
  if (!walletAddress) return false;
  return devWalletAllowlist().includes(walletAddress);
}

export function devLayer1Enabled(): boolean {
  return process.env.AGENTIC_DEV_AP2_ACP === '1';
}

export function deviceAgentFeatureEnabled(): boolean {
  return process.env.AGENTIC_DEVICE_AGENT === '1';
}

export function isAllowedDeviceAgentWallet(walletAddress: string | undefined | null): boolean {
  if (!walletAddress) return false;
  return deviceAgentWalletAllowlist().includes(walletAddress);
}

export function deviceAgentRuntimeAvailability(): { android: boolean; browserNative: boolean } {
  return {
    android: process.env.AGENTIC_DEVICE_AGENT === '1' && process.env.AGENTIC_ANDROID_DEVICE_AGENT !== '0',
    browserNative: process.env.AGENTIC_DEVICE_AGENT === '1' && process.env.AGENTIC_BROWSER_DEVICE_AGENT === '1',
  };
}
