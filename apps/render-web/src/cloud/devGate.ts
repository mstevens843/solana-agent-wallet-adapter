const RAW_ALLOWLIST = process.env.AGENTIC_DEV_WALLET_ALLOWLIST ?? '';
const RAW_DEVICE_AGENT_ALLOWLIST = process.env.AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST ?? '';

const DEFAULT_DEVICE_AGENT_WALLETS = [
  '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
  '7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w',
] as const;

function parseList(value: string, fallback: readonly string[] = []): readonly string[] {
  const source = value.trim() ? value.split(',') : fallback;
  return Object.freeze(
    source
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export const DEV_WALLET_ALLOWLIST: readonly string[] = parseList(RAW_ALLOWLIST);
export const DEVICE_AGENT_WALLET_ALLOWLIST: readonly string[] = parseList(
  RAW_DEVICE_AGENT_ALLOWLIST,
  DEFAULT_DEVICE_AGENT_WALLETS,
);

export function isAllowedDevWallet(walletAddress: string | undefined | null): boolean {
  if (!walletAddress) return false;
  return DEV_WALLET_ALLOWLIST.includes(walletAddress);
}

export function devLayer1Enabled(): boolean {
  return process.env.AGENTIC_DEV_AP2_ACP === '1';
}

export function deviceAgentFeatureEnabled(): boolean {
  return process.env.AGENTIC_DEVICE_AGENT === '1';
}

export function isAllowedDeviceAgentWallet(walletAddress: string | undefined | null): boolean {
  if (!walletAddress) return false;
  return DEVICE_AGENT_WALLET_ALLOWLIST.includes(walletAddress);
}

export function deviceAgentRuntimeAvailability(): { android: boolean; browserNative: boolean } {
  return {
    android: process.env.AGENTIC_DEVICE_AGENT === '1' && process.env.AGENTIC_ANDROID_DEVICE_AGENT !== '0',
    browserNative: process.env.AGENTIC_DEVICE_AGENT === '1' && process.env.AGENTIC_BROWSER_DEVICE_AGENT === '1',
  };
}
