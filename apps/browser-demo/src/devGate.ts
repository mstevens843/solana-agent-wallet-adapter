// Mirror the cast pattern used in main.ts (resolveDevControls) to avoid needing
// a vite/client triple-slash reference at the package level.
const viteEnv = (import.meta as ImportMeta & {
  env?: {
    VITE_AGENTIC_DEV_WALLET_ALLOWLIST?: string;
    VITE_AGENTIC_DEV_AP2_ACP?: string;
  };
}).env;

const RAW_ALLOWLIST = String(viteEnv?.VITE_AGENTIC_DEV_WALLET_ALLOWLIST ?? '');
const RAW_FLAG = String(viteEnv?.VITE_AGENTIC_DEV_AP2_ACP ?? '');

export const DEV_WALLET_ALLOWLIST: readonly string[] = Object.freeze(
  RAW_ALLOWLIST.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

export const DEV_LAYER1_ENABLED: boolean = RAW_FLAG === '1';

export function isDevWallet(address: string | undefined | null): boolean {
  if (!address) return false;
  if (!DEV_LAYER1_ENABLED) return false;
  return DEV_WALLET_ALLOWLIST.includes(address);
}
