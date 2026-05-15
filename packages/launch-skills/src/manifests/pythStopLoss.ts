import { skills } from '@solana-agent-wallet-adapter/workflow/dev';

import {
  DEV_AUTHOR_WALLET,
  MANIFEST_EXPIRES_AT,
  PYTH_SOL_USD_FEED,
  USDC_MINT,
  WSOL_MINT,
} from '../constants.js';

const SOL_USD_FLOOR_TRIGGER = JSON.stringify({
  feedId: PYTH_SOL_USD_FEED,
  op: '<',
  threshold: '100',
});

export const pythStopLossSkill: skills.SkillManifest = {
  id: 'pyth-stop-loss',
  name: 'Pyth Stop-Loss',
  version: '1.0.0',
  authorWallet: DEV_AUTHOR_WALLET,
  description:
    'Sells SOL to USDC when the Pyth SOL/USD feed prints below your configured floor price. Fires at most once per install. Manual approval required.',
  category: 'stops',
  schedule: {
    kind: 'price-trigger',
    spec: SOL_USD_FLOOR_TRIGGER,
  },
  action: {
    connectorAction: 'prepare_swap',
    paramsTemplate: {
      inputMint: WSOL_MINT,
      outputMint: USDC_MINT,
      amount: '10',
      slippageBps: 100,
    },
  },
  caps: {
    perRunMaxAmount: '10',
    lifetimeMaxAmount: '10',
    allowlistedTokens: [WSOL_MINT, USDC_MINT],
    expiresAt: MANIFEST_EXPIRES_AT,
    maxExecutions: 1,
  },
};
