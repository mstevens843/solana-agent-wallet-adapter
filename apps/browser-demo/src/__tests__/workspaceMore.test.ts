import { describe, expect, it } from 'vitest';

import {
  REQUIRED_WORKSPACE_MORE_MENU_ITEMS,
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
});
