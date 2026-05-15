import { skills } from '@solana-agent-wallet-adapter/workflow/dev';

import { DEV_AUTHOR_WALLET, MANIFEST_EXPIRES_AT, USDC_MINT } from '../constants.js';

export const yieldAutoRotateSkill: skills.SkillManifest = {
  id: 'yield-auto-rotate',
  name: 'Yield Auto-Rotate',
  version: '1.0.0',
  authorWallet: DEV_AUTHOR_WALLET,
  description:
    'Routes idle USDC into the highest-APY lending vault each day across Jupiter Lend Earn, Kamino, Marginfi, and Lulo. Each rotation still requires your manual approval.',
  category: 'yield',
  schedule: {
    kind: 'cron',
    spec: '0 13 * * *',
  },
  action: {
    connectorAction: 'yield.auto_rotate',
    paramsTemplate: {
      token: USDC_MINT,
      amount: '1000',
      minApyDeltaBps: 50,
    },
  },
  caps: {
    perRunMaxAmount: '1000',
    lifetimeMaxAmount: '10000',
    allowlistedTokens: [USDC_MINT],
    expiresAt: MANIFEST_EXPIRES_AT,
  },
  monetization: {
    kind: 'monthly',
    amount: '0.99',
    payoutWallet: DEV_AUTHOR_WALLET,
  },
};
