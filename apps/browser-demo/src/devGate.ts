// Mirror the cast pattern used in main.ts (resolveDevControls) to avoid needing
// a vite/client triple-slash reference at the package level.
const viteEnv = (import.meta as ImportMeta & {
  env?: {
    VITE_AGENTIC_DEV_WALLET_ALLOWLIST?: string;
    VITE_AGENTIC_DEV_AP2_ACP?: string;
    VITE_AGENTIC_DEVICE_AGENT?: string;
    VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST?: string;
    VITE_AGENTIC_ANDROID_DEVICE_AGENT?: string;
    VITE_AGENTIC_BROWSER_DEVICE_AGENT?: string;
  };
}).env;

const DEFAULT_DEVICE_AGENT_WALLETS = [
  '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
  '7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w',
] as const;

const RAW_ALLOWLIST = String(viteEnv?.VITE_AGENTIC_DEV_WALLET_ALLOWLIST ?? '');
const RAW_FLAG = String(viteEnv?.VITE_AGENTIC_DEV_AP2_ACP ?? '');
const RAW_DEVICE_AGENT_FLAG = String(viteEnv?.VITE_AGENTIC_DEVICE_AGENT ?? '');
const RAW_DEVICE_AGENT_ALLOWLIST = String(viteEnv?.VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST ?? '');
const RAW_ANDROID_DEVICE_AGENT_FLAG = String(viteEnv?.VITE_AGENTIC_ANDROID_DEVICE_AGENT ?? '');
const RAW_BROWSER_DEVICE_AGENT_FLAG = String(viteEnv?.VITE_AGENTIC_BROWSER_DEVICE_AGENT ?? '');

function enabledFlag(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export const DEV_WALLET_ALLOWLIST: readonly string[] = Object.freeze(
  RAW_ALLOWLIST.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

export const DEV_LAYER1_ENABLED: boolean = RAW_FLAG === '1';
export const DEVICE_AGENT_ENABLED: boolean = enabledFlag(RAW_DEVICE_AGENT_FLAG);
export const ANDROID_DEVICE_AGENT_ENABLED: boolean = enabledFlag(RAW_ANDROID_DEVICE_AGENT_FLAG);
export const BROWSER_DEVICE_AGENT_ENABLED: boolean = enabledFlag(RAW_BROWSER_DEVICE_AGENT_FLAG);
export const DEVICE_AGENT_WALLET_ALLOWLIST: readonly string[] = Object.freeze(
  (RAW_DEVICE_AGENT_ALLOWLIST.trim()
    ? RAW_DEVICE_AGENT_ALLOWLIST.split(',')
    : DEFAULT_DEVICE_AGENT_WALLETS
  )
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

export function isDevWallet(address: string | undefined | null): boolean {
  if (!address) return false;
  if (!DEV_LAYER1_ENABLED) return false;
  return DEV_WALLET_ALLOWLIST.includes(address);
}

export function isDeviceAgentWallet(address: string | undefined | null): boolean {
  if (!address) return false;
  return DEVICE_AGENT_WALLET_ALLOWLIST.includes(address);
}

export function isBrowserNativeRuntimeEligible(
  walletAddress: string | undefined | null,
  isAndroidApp: boolean,
): boolean {
  if (!DEVICE_AGENT_ENABLED) return false;
  if (!BROWSER_DEVICE_AGENT_ENABLED) return false;
  if (isAndroidApp) return false;
  return isDeviceAgentWallet(walletAddress);
}
