export const DEVICE_AGENT_BOUNDARIES = {
  PLAN: 'AI prepares a plan only. Wallet approval and signing happen later in the user wallet.',
  REVIEW: 'This AI review can approve, deny, or request more input. It cannot sign or submit a transaction.',
  ASK: 'This is conversational Q&A about a draft. It cannot sign or submit a transaction.',
  REVIEW_DEFAULT_INSTRUCTION:
    'Review this draft before it is sent for wallet approval. Decide approve, deny, or needs_input.',
} as const;

export type DeviceAgentBoundaryKey = keyof typeof DEVICE_AGENT_BOUNDARIES;
