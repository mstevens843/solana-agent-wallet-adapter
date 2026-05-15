import * as launchSkillsModule from '@solana-agent-wallet-adapter/launch-skills';
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';
import type { SkillManifest } from '@solana-agent-wallet-adapter/skills-runtime';

import type { Clock, SkillsStore } from './store.js';
import {
  cloneSkillManifest,
  skillManifestHash,
} from './skillManifestIntegrity.js';

export async function seedLaunchSkillsIfNeeded(
  store: SkillsStore,
  clock: Clock,
): Promise<void> {
  const launchSkills = readLaunchSkills();
  if (launchSkills.length === 0) return;

  const nowIso = clock.now().toISOString();
  for (const rawManifest of launchSkills) {
    const manifest = DevLayer1.skills.validateSkillManifest(rawManifest) as SkillManifest;
    if (await store.getSkillManifest(manifest.id)) continue;
    await store.saveSkillManifest({
      id: manifest.id,
      version: manifest.version,
      authorWallet: manifest.authorWallet,
      createdAt: nowIso,
      updatedAt: nowIso,
      manifest: cloneSkillManifest(manifest),
      manifestHash: skillManifestHash(manifest),
    });
  }
}

function readLaunchSkills(): readonly SkillManifest[] {
  const list = (launchSkillsModule as { LAUNCH_SKILLS?: readonly SkillManifest[] }).LAUNCH_SKILLS;
  return Array.isArray(list) ? list : [];
}
