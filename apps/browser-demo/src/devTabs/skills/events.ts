export const SKILLS_INSTALLS_CHANGED_EVENT = 'skills-installs-changed';

export type SkillsInstallsChangedSource = 'browse' | 'installed';

export interface SkillsInstallsChangedDetail {
  source: SkillsInstallsChangedSource;
  skillId?: string;
  installId?: string;
  status?: string;
}

export function emitSkillsInstallsChanged(detail: SkillsInstallsChangedDetail): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(
    new CustomEvent<SkillsInstallsChangedDetail>(SKILLS_INSTALLS_CHANGED_EVENT, {
      detail,
    }),
  );
}

export function onSkillsInstallsChanged(
  handler: (detail: SkillsInstallsChangedDetail) => void,
): () => void {
  if (typeof document === 'undefined') return () => {};
  const listener = (event: Event) => {
    handler((event as CustomEvent<SkillsInstallsChangedDetail>).detail);
  };
  document.addEventListener(SKILLS_INSTALLS_CHANGED_EVENT, listener);
  return () => document.removeEventListener(SKILLS_INSTALLS_CHANGED_EVENT, listener);
}
