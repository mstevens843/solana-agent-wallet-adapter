import { skills } from '@solana-agent-wallet-adapter/workflow/dev';

import { DEV_AUTHOR_WALLET, MANIFEST_EXPIRES_AT, USDC_MINT, WSOL_MINT } from '../constants.js';

export const fridayDcaSkill: skills.SkillManifest = {
  id: 'friday-dca',
  name: 'Friday DCA',
  version: '1.0.0',
  authorWallet: DEV_AUTHOR_WALLET,
  description:
    'Buys SOL with USDC every Friday at 14:00 UTC. Each fill still requires your manual wallet approval.',
  category: 'dca',
  schedule: {
    kind: 'cron',
    spec: '0 14 * * 5',
  },
  action: {
    connectorAction: 'prepare_swap',
    paramsTemplate: {
      inputMint: USDC_MINT,
      outputMint: WSOL_MINT,
      amount: '50',
      slippageBps: 50,
    },
  },
  caps: {
    perRunMaxAmount: '50',
    lifetimeMaxAmount: '2600',
    allowlistedTokens: [USDC_MINT, WSOL_MINT],
    expiresAt: MANIFEST_EXPIRES_AT,
    maxExecutions: 52,
  },
};
