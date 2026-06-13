// Mirror the cast pattern used in main.ts (resolveDevControls) to avoid needing
// a vite/client triple-slash reference at the package level.
const viteEnv = (import.meta as ImportMeta & {
  env?: {
    VITE_AGENTIC_DEV_WALLET_ALLOWLIST?: string;
    VITE_AGENTIC_DEV_AP2_ACP?: string;
    VITE_AGENTIC_DEVICE_AGENT?: string;
    VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST?: string;
    VITE_AGENTIC_ANDROID_DEVICE_AGENT?: string;
    VITE_AGENTIC_IOS_DEVICE_AGENT?: string;
    VITE_AGENTIC_BROWSER_DEVICE_AGENT?: string;
  };
}).env;

const RAW_ALLOWLIST = String(viteEnv?.VITE_AGENTIC_DEV_WALLET_ALLOWLIST ?? '');
const RAW_FLAG = String(viteEnv?.VITE_AGENTIC_DEV_AP2_ACP ?? '');
const RAW_DEVICE_AGENT_FLAG = String(viteEnv?.VITE_AGENTIC_DEVICE_AGENT ?? '');
const RAW_DEVICE_AGENT_ALLOWLIST = String(viteEnv?.VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST ?? '');
const RAW_ANDROID_DEVICE_AGENT_FLAG = String(viteEnv?.VITE_AGENTIC_ANDROID_DEVICE_AGENT ?? '');
const RAW_IOS_DEVICE_AGENT_FLAG = String(viteEnv?.VITE_AGENTIC_IOS_DEVICE_AGENT ?? '');
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
export const IOS_DEVICE_AGENT_ENABLED: boolean = enabledFlag(RAW_IOS_DEVICE_AGENT_FLAG);
export const BROWSER_DEVICE_AGENT_ENABLED: boolean = enabledFlag(RAW_BROWSER_DEVICE_AGENT_FLAG);
export const DEVICE_AGENT_WALLET_ALLOWLIST: readonly string[] = Object.freeze(
  RAW_DEVICE_AGENT_ALLOWLIST.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

export function isDevWallet(address: string | undefined | null): boolean {
  if (!address) return false;
  if (!DEV_LAYER1_ENABLED) return false;
  return DEV_WALLET_ALLOWLIST.includes(address);
}

export function isDeviceAgentWallet(address: string | undefined | null): boolean {
  return Boolean(address);
}

export interface BrowserNativeRuntimeEligibilityInput {
  deviceAgentEnabled: boolean;
  browserDeviceAgentEnabled: boolean;
  walletAddress?: string | null;
  isAndroidApp: boolean;
  isIosApp?: boolean;
  showDevControls: boolean;
  deviceAgentWalletAllowlisted?: boolean;
}

export function browserNativeRuntimeEligibleForSurface(
  input: BrowserNativeRuntimeEligibilityInput,
): boolean {
  if (!input.deviceAgentEnabled) return false;
  if (!input.browserDeviceAgentEnabled) return false;
  if (input.isAndroidApp) return false;
  if (input.isIosApp) return false;
  if (input.showDevControls) return true;
  return Boolean(input.walletAddress);
}

export function isBrowserNativeRuntimeEligible(
  walletAddress: string | undefined | null,
  isAndroidApp: boolean,
): boolean {
  return browserNativeRuntimeEligibleForSurface({
    deviceAgentEnabled: DEVICE_AGENT_ENABLED,
    browserDeviceAgentEnabled: BROWSER_DEVICE_AGENT_ENABLED,
    walletAddress,
    isAndroidApp,
    showDevControls: false,
  });
}
