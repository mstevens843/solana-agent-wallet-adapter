export interface WorkspaceMoreRegisteredTab {
  id: string;
  label: string;
  guard: () => boolean;
}

export interface WorkspaceMoreMenuItem {
  id: string;
  label: string;
}

export const REQUIRED_WORKSPACE_MORE_MENU_ITEMS: readonly WorkspaceMoreMenuItem[] = [
  { id: 'positions', label: 'Positions' },
  { id: 'schedule', label: 'Repeat Payments' },
  { id: 'labs', label: 'Save Proof' },
  { id: 'agent-protocols', label: 'Agent Payments' },
  { id: 'skills', label: 'Skills' },
  { id: 'sessions', label: 'Sessions' },
] as const;

export const MOBILE_WORKSPACE_MORE_MENU_ITEMS: readonly WorkspaceMoreMenuItem[] = [
  { id: 'preferences', label: 'Preferences' },
  { id: 'completed', label: 'Done' },
  { id: 'positions', label: 'Positions' },
  { id: 'schedule', label: 'Repeat Payments' },
  { id: 'labs', label: 'Save Proof' },
  { id: 'agent-protocols', label: 'Agent Payments' },
  { id: 'skills', label: 'Skills' },
  { id: 'sessions', label: 'Sessions' },
] as const;

export function workspaceMoreMenuItems(
  registeredTabs: readonly WorkspaceMoreRegisteredTab[],
): WorkspaceMoreMenuItem[] {
  const items: WorkspaceMoreMenuItem[] = [...REQUIRED_WORKSPACE_MORE_MENU_ITEMS];
  const seen = new Set(items.map((item) => item.id));

  for (const tab of registeredTabs) {
    if (seen.has(tab.id) || !tab.guard()) continue;
    seen.add(tab.id);
    items.push({ id: tab.id, label: tab.label });
  }

  return items;
}

export function mobileWorkspaceMoreMenuItems(
  registeredTabs: readonly WorkspaceMoreRegisteredTab[],
): WorkspaceMoreMenuItem[] {
  const items: WorkspaceMoreMenuItem[] = [...MOBILE_WORKSPACE_MORE_MENU_ITEMS];
  const seen = new Set(items.map((item) => item.id));

  for (const tab of registeredTabs) {
    if (tab.id === 'spend' || seen.has(tab.id) || !tab.guard()) continue;
    seen.add(tab.id);
    items.push({ id: tab.id, label: tab.label });
  }

  return items;
}
