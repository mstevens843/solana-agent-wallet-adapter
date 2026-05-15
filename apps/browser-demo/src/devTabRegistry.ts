export interface DevTabSpec {
  id: string;
  label: string;
  mobileLabel?: string;
  guard: () => boolean;
  render: () => string;
  onMount?: () => void;
}

const tabs: DevTabSpec[] = [];

export function registerDevTab(spec: DevTabSpec): void {
  if (tabs.some((existing) => existing.id === spec.id)) return;
  tabs.push(spec);
}

export function listDevTabs(): readonly DevTabSpec[] {
  return tabs;
}

export function findDevTab(id: string): DevTabSpec | undefined {
  return tabs.find((tab) => tab.id === id);
}
