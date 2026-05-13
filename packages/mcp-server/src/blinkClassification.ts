export type BlinkClassificationCategory =
  | 'safe_claim'
  | 'safe_governance_vote'
  | 'safe_donation_or_tip'
  | 'lp_position_management'
  | 'nft_marketplace'
  | 'mint_or_buy'
  | 'disguised_transfer'
  | 'token_account_drain'
  | 'unknown_program_interaction'
  | 'unparseable';

export type BlinkDefaultVerdict = 'approve' | 'needs_input' | 'deny';

export interface BlinkClassificationProfile {
  category: BlinkClassificationCategory;
  defaultVerdict: BlinkDefaultVerdict;
  evidenceSlots: string[];
  label: string;
  rationale: string;
}

export const BLINK_CLASSIFICATION_PROFILES: Record<BlinkClassificationCategory, BlinkClassificationProfile> = {
  safe_claim: {
    category: 'safe_claim',
    defaultVerdict: 'approve',
    evidenceSlots: ['protocolConnector', 'blinkAction', 'simulation'],
    label: 'Claim rewards',
    rationale: 'Claims accrued rewards from a registered protocol without moving principal.',
  },
  safe_governance_vote: {
    category: 'safe_governance_vote',
    defaultVerdict: 'approve',
    evidenceSlots: ['protocolConnector', 'blinkAction', 'simulation'],
    label: 'Governance vote',
    rationale: 'Casts a governance vote on a registered realm or DAO.',
  },
  safe_donation_or_tip: {
    category: 'safe_donation_or_tip',
    defaultVerdict: 'approve',
    evidenceSlots: ['recipient', 'tokenMint', 'simulation'],
    label: 'Tip or donation',
    rationale: 'Transfers a small amount to a known recipient as a tip or donation.',
  },
  lp_position_management: {
    category: 'lp_position_management',
    defaultVerdict: 'approve',
    evidenceSlots: ['protocolConnector', 'blinkAction', 'simulation', 'limits'],
    label: 'LP position change',
    rationale: 'Adjusts a liquidity position (add, remove, collect fees) on a registered AMM.',
  },
  nft_marketplace: {
    category: 'nft_marketplace',
    defaultVerdict: 'approve',
    evidenceSlots: ['protocolConnector', 'blinkAction', 'simulation', 'limits'],
    label: 'NFT marketplace action',
    rationale: 'Lists, bids, or buys an NFT through a registered marketplace.',
  },
  mint_or_buy: {
    category: 'mint_or_buy',
    defaultVerdict: 'approve',
    evidenceSlots: ['protocolConnector', 'blinkAction', 'simulation', 'limits'],
    label: 'Mint or buy',
    rationale: 'Mints or purchases an asset from a registered launchpad.',
  },
  disguised_transfer: {
    category: 'disguised_transfer',
    defaultVerdict: 'deny',
    evidenceSlots: ['recipient', 'tokenMint', 'simulation'],
    label: 'Disguised transfer',
    rationale: 'Value leaves the wallet to an address that does not match the named protocol.',
  },
  token_account_drain: {
    category: 'token_account_drain',
    defaultVerdict: 'deny',
    evidenceSlots: ['tokenMint', 'simulation'],
    label: 'Token account drain',
    rationale: 'The transaction closes an SPL account or moves the entire balance of a mint.',
  },
  unknown_program_interaction: {
    category: 'unknown_program_interaction',
    defaultVerdict: 'needs_input',
    evidenceSlots: ['protocolConnector', 'blinkAction', 'simulation'],
    label: 'Unknown program',
    rationale: 'One or more invoked program IDs are not registered with any connector or action spec.',
  },
  unparseable: {
    category: 'unparseable',
    defaultVerdict: 'needs_input',
    evidenceSlots: ['blinkAction'],
    label: 'Unparseable Blink',
    rationale: 'The action URL or simulation could not be parsed.',
  },
};

const VALID_CATEGORIES = new Set<BlinkClassificationCategory>(
  Object.keys(BLINK_CLASSIFICATION_PROFILES) as BlinkClassificationCategory[],
);

export function isBlinkClassificationCategory(value: unknown): value is BlinkClassificationCategory {
  return typeof value === 'string' && VALID_CATEGORIES.has(value as BlinkClassificationCategory);
}

export function normalizeBlinkClassification(value: unknown): BlinkClassificationCategory {
  return isBlinkClassificationCategory(value) ? value : 'unparseable';
}

export function blinkClassificationProfile(value: unknown): BlinkClassificationProfile {
  return BLINK_CLASSIFICATION_PROFILES[normalizeBlinkClassification(value)];
}

const VERDICT_RANK: Record<BlinkDefaultVerdict, number> = {
  approve: 0,
  needs_input: 1,
  deny: 2,
};

export function applyBlinkVerdictFloor(
  category: BlinkClassificationCategory,
  topLevelVerdict: BlinkDefaultVerdict,
): BlinkDefaultVerdict {
  const floor = BLINK_CLASSIFICATION_PROFILES[category].defaultVerdict;
  return VERDICT_RANK[floor] > VERDICT_RANK[topLevelVerdict] ? floor : topLevelVerdict;
}

export const BLINK_CLASSIFIER_REVIEW_PROMPT = [
  'Add a fifth reviewer with role "blink_classifier" when plan.actionType is "blink_action".',
  'This reviewer classifies the Blink before risk votes. Pick exactly one category from:',
  'safe_claim, safe_governance_vote, safe_donation_or_tip, lp_position_management, nft_marketplace, mint_or_buy, disguised_transfer, token_account_drain, unknown_program_interaction, unparseable.',
  'Use simulation results (programs invoked, accounts written, lamport/SPL deltas), the Blink host domain, the connector capability registry, and the user\'s stated intent.',
  'A Blink is a disguised_transfer when net value leaves the wallet to an address unrelated to the named protocol.',
  'It is a token_account_drain when the simulation closes an SPL account or moves the entire balance of a mint.',
  'It is unknown_program_interaction when invoked program IDs do not appear in the connector registry or a published action spec.',
  'If the action URL or simulation cannot be parsed, return unparseable.',
  'The risk reviewer must consume this classification and deny on disguised_transfer or token_account_drain, return needs_input on unknown_program_interaction or unparseable, and approve safe_* categories absent other red flags.',
  'Record the chosen category in evidence.blinkClassification = {category, confidence, rationale (one sentence), redFlags (array of short strings)}.',
].join(' ');
