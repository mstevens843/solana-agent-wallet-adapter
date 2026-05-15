import { skills } from '@solana-agent-wallet-adapter/workflow/dev';

import { bridgeIdleUsdcSkill } from './manifests/bridgeIdleUsdc.js';
import { fridayDcaSkill } from './manifests/fridayDca.js';
import { pythStopLossSkill } from './manifests/pythStopLoss.js';
import { recurringDonationSkill } from './manifests/recurringDonation.js';
import { yieldAutoRotateSkill } from './manifests/yieldAutoRotate.js';

export { bridgeIdleUsdcSkill } from './manifests/bridgeIdleUsdc.js';
export { fridayDcaSkill } from './manifests/fridayDca.js';
export { pythStopLossSkill } from './manifests/pythStopLoss.js';
export { recurringDonationSkill } from './manifests/recurringDonation.js';
export { yieldAutoRotateSkill } from './manifests/yieldAutoRotate.js';

export const LAUNCH_SKILLS: readonly skills.SkillManifest[] = [
  fridayDcaSkill,
  yieldAutoRotateSkill,
  pythStopLossSkill,
  bridgeIdleUsdcSkill,
  recurringDonationSkill,
];
