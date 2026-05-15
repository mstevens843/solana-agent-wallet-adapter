import { skills } from '@solana-agent-wallet-adapter/workflow/dev';

import { DEV_AUTHOR_WALLET, MANIFEST_EXPIRES_AT, USDC_MINT } from '../constants.js';

export const bridgeIdleUsdcSkill: skills.SkillManifest = {
  id: 'bridge-idle-usdc',
  name: 'Bridge Idle USDC',
  version: '1.0.0',
  authorWallet: DEV_AUTHOR_WALLET,
  description:
    'Bridges idle USDC from Solana to Base via Wormhole on a weekly cadence. Manual approval required for each bridge.',
  category: 'bridge',
  schedule: {
    kind: 'cron',
    spec: '0 15 * * 1',
  },
  action: {
    connectorAction: 'prepare_wormhole_transfer',
    paramsTemplate: {
      sourceMint: USDC_MINT,
      destinationChain: 'Base',
      destinationAddress: '{{install.destinationAddress}}',
      amount: '500',
      routeType: 'auto',
    },
  },
  caps: {
    perRunMaxAmount: '500',
    lifetimeMaxAmount: '5000',
    allowlistedTokens: [USDC_MINT],
    expiresAt: MANIFEST_EXPIRES_AT,
    maxExecutions: 12,
  },
};
