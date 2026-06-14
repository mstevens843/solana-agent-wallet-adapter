export type SkillsSubTabId = 'browse' | 'installed' | 'profile' | 'publish' | (string & {});

export interface SkillsSubTabSpec {
  id: SkillsSubTabId;
  label: string;
  mobileLabel?: string;
  description: string;
  render: () => string;
  onMount?: () => void;
}

const subTabs: SkillsSubTabSpec[] = [];

export function registerSkillsSubTab(spec: SkillsSubTabSpec): void {
  if (subTabs.some((existing) => existing.id === spec.id)) return;
  subTabs.push(spec);
}

export function listSkillsSubTabs(): readonly SkillsSubTabSpec[] {
  return subTabs;
}

export function findSkillsSubTab(id: string): SkillsSubTabSpec | undefined {
  return subTabs.find((tab) => tab.id === id);
}

// Active sub-tab tracker. Lives here (not in DemoState) so the Skills tab
// owns its own internal navigation. main.ts click handler calls the setter;
// the skills panel reads the getter on each render.
let activeSubTabId: SkillsSubTabId = 'browse';

export function getActiveSkillsSubTab(): SkillsSubTabId {
  return activeSubTabId;
}

export function setActiveSkillsSubTab(id: SkillsSubTabId): void {
  activeSubTabId = id;
}
