import { skills } from '@solana-agent-wallet-adapter/workflow/dev';

import { DEV_AUTHOR_WALLET, MANIFEST_EXPIRES_AT, USDC_MINT } from '../constants.js';

export const recurringDonationSkill: skills.SkillManifest = {
  id: 'recurring-donation',
  name: 'Recurring Donation',
  version: '1.0.0',
  authorWallet: DEV_AUTHOR_WALLET,
  description:
    'Sends a fixed monthly USDC donation to a recipient wallet you choose at install time. Each transfer requires your manual approval.',
  category: 'donation',
  schedule: {
    kind: 'cron',
    spec: '0 14 1 * *',
  },
  action: {
    connectorAction: 'prepare_transfer_spl',
    paramsTemplate: {
      token: USDC_MINT,
      recipient: '{{install.recipient}}',
      amount: '10',
    },
  },
  caps: {
    perRunMaxAmount: '10',
    lifetimeMaxAmount: '120',
    allowlistedTokens: [USDC_MINT],
    expiresAt: MANIFEST_EXPIRES_AT,
    maxExecutions: 12,
  },
};
