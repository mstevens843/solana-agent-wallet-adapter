export const JUPITER_IOS_MANUAL_APPROVAL_URL = 'jupiter://';
export const JUPITER_IOS_MANUAL_APPROVAL_ACTION_LABEL = 'Open Jupiter';

// When we can bring the user back automatically — either Jupiter bounces them
// back (older iOS) or our return notification does (iOS 17+/18, where Apple
// blocks silent app-to-app redirects). The signed result always arrives over
// the WalletConnect relay regardless of app-switching.
const JUPITER_IOS_AUTO_RETURN_PREFIX = "Approve in Jupiter. We'll bring you back here when it's done.";

// When the user denied notifications: we can't guarantee a return on iOS 18, so
// ask them to come back themselves (the manual "Open Jupiter" button still helps).
const JUPITER_IOS_MANUAL_RETURN_PREFIX = 'Approve in Jupiter, then come back to Agentic to see the result.';

export interface JupiterIosApprovalMessageOptions {
  /** False when the user denied return notifications; switches copy to manual-return. */
  canNotify?: boolean;
}

export function jupiterIosManualApprovalMessage(
  message?: string,
  options?: JupiterIosApprovalMessageOptions,
): string {
  const prefix =
    options?.canNotify === false ? JUPITER_IOS_MANUAL_RETURN_PREFIX : JUPITER_IOS_AUTO_RETURN_PREFIX;
  const detail = message?.trim();
  return detail ? `${prefix} ${detail}` : prefix;
}
