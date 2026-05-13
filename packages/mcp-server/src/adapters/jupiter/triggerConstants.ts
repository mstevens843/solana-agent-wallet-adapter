export const JUPITER_TRIGGER_PRODUCT = 'trigger' as const;

export type JupiterTriggerOperation =
  | 'register_vault'
  | 'single_order'
  | 'oco_order'
  | 'otoco_order'
  | 'edit_order'
  | 'cancel_order'
  | 'withdraw_order_funds';

export const JUPITER_TRIGGER_OPERATIONS: JupiterTriggerOperation[] = [
  'register_vault',
  'single_order',
  'oco_order',
  'otoco_order',
  'edit_order',
  'cancel_order',
  'withdraw_order_funds',
];

export const JUPITER_TRIGGER_JWT_SAFETY_MS = 60 * 60 * 1000;
export const JUPITER_TRIGGER_JWT_MAX_TTL_MS = 23 * 60 * 60 * 1000;
export const JUPITER_TRIGGER_CHALLENGE_MAX_TTL_MS = 5 * 60 * 1000;

export type JupiterTriggerChallengeType = 'message' | 'transaction';
export type JupiterTriggerOrderState =
  | 'open'
  | 'pending'
  | 'filled'
  | 'expired'
  | 'cancelled'
  | 'ready_to_cancel'
  | 'all';
