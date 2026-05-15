const RAW_ALLOWLIST = process.env.AGENTIC_DEV_WALLET_ALLOWLIST ?? '';

export const DEV_WALLET_ALLOWLIST: readonly string[] = Object.freeze(
  RAW_ALLOWLIST.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

export function isAllowedDevWallet(walletAddress: string | undefined | null): boolean {
  if (!walletAddress) return false;
  return DEV_WALLET_ALLOWLIST.includes(walletAddress);
}

export function devLayer1Enabled(): boolean {
  return process.env.AGENTIC_DEV_AP2_ACP === '1';
}
