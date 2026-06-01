export const JUPITER_IOS_MANUAL_APPROVAL_URL = 'jupiter://';
export const JUPITER_IOS_MANUAL_APPROVAL_ACTION_LABEL = 'Open Jupiter';

const JUPITER_IOS_MANUAL_APPROVAL_PREFIX = "Open Jupiter to approve. Return to Agentic when it's done.";

export function jupiterIosManualApprovalMessage(message?: string): string {
  const detail = message?.trim();
  return detail ? `${JUPITER_IOS_MANUAL_APPROVAL_PREFIX} ${detail}` : JUPITER_IOS_MANUAL_APPROVAL_PREFIX;
}
