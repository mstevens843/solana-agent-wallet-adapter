import { describe, expect, it } from 'vitest';

import {
  MOBILE_WORKSPACE_MORE_MENU_ITEMS,
  REQUIRED_WORKSPACE_MORE_MENU_ITEMS,
  mobileWorkspaceMoreMenuItems,
  workspaceMoreMenuItems,
  type WorkspaceMoreRegisteredTab,
} from '../workspaceMore.js';

describe('workspace More menu items', () => {
  it('keeps the four product More entries even when no tabs have registered yet', () => {
    expect(workspaceMoreMenuItems([])).toEqual([
      { id: 'labs', label: 'Save Proof' },
      { id: 'agent-protocols', label: 'Agent Payments' },
      { id: 'skills', label: 'Skills' },
      { id: 'sessions', label: 'Sessions' },
    ]);
  });

  it('dedupes required entries and appends guarded registry extras', () => {
    const registered: WorkspaceMoreRegisteredTab[] = [
      { id: 'agent-protocols', label: 'Wrong duplicate label', guard: () => true },
      { id: 'spend', label: 'Spend', guard: () => true },
      { id: 'custom-layer', label: 'Custom Layer', guard: () => true },
      { id: 'hidden-layer', label: 'Hidden Layer', guard: () => false },
    ];

    expect(workspaceMoreMenuItems(registered)).toEqual([
      ...REQUIRED_WORKSPACE_MORE_MENU_ITEMS,
      { id: 'custom-layer', label: 'Custom Layer' },
    ]);
  });

  it('keeps the mobile More order with preferences first and sessions last', () => {
    expect(mobileWorkspaceMoreMenuItems([])).toEqual([
      { id: 'preferences', label: 'Preferences' },
      { id: 'schedule', label: 'Repeat Payments' },
      { id: 'labs', label: 'Save Proof' },
      { id: 'agent-protocols', label: 'Agent Payments' },
      { id: 'skills', label: 'Skills' },
      { id: 'sessions', label: 'Sessions' },
    ]);
  });

  it('dedupes mobile More entries and appends guarded registry extras', () => {
    const registered: WorkspaceMoreRegisteredTab[] = [
      { id: 'schedule', label: 'Wrong duplicate label', guard: () => true },
      { id: 'skills', label: 'Wrong duplicate label', guard: () => true },
      { id: 'spend', label: 'Spend', guard: () => true },
      { id: 'custom-layer', label: 'Custom Layer', guard: () => true },
      { id: 'hidden-layer', label: 'Hidden Layer', guard: () => false },
    ];

    expect(mobileWorkspaceMoreMenuItems(registered)).toEqual([
      ...MOBILE_WORKSPACE_MORE_MENU_ITEMS,
      { id: 'custom-layer', label: 'Custom Layer' },
    ]);
  });
});
