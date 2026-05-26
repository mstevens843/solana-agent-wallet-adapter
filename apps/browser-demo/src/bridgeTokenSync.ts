// Pure derivation of the bridge URL/token update implied by a `TauriBridgeStatus`.
//
// In Tauri mode the Rust side (`apps/desktop-shell/src-tauri/src/lib.rs`) is
// the source of truth for the bridge URL + token, because it rotates the
// legacy `local-agent-wallet` token to a per-install random one. The browser
// webview must mirror those values onto `state.bridgeToken` / `state.bridgeUrl`
// or every `/bridge/*` request goes out with the wrong token and gets 401'd.
//
// Kept DOM-free + state-free so it's testable in isolation. The wrapper in
// `main.ts` applies the result to live state and sessionStorage.

import type { TauriBridgeStatus } from './tauriNative.js';

export interface BridgeConfigUpdate {
  bridgeUrl: string | null;
  bridgeToken: string | null;
}

export function computeBridgeConfigUpdate(
  status: TauriBridgeStatus | null,
): BridgeConfigUpdate {
  if (!status) {
    return { bridgeUrl: null, bridgeToken: null };
  }
  const url = status.bridgeUrl?.trim() ?? '';
  const token = status.bridgeToken?.trim() ?? '';
  return {
    bridgeUrl: url ? url : null,
    bridgeToken: token ? token : null,
  };
}
