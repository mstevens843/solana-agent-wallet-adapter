import { describe, expect, it } from 'vitest';

import { CHAT_TOOL_NAMES } from '../../../../packages/workflow/src/chatAgent/tools.js';
import {
  chatToolDisplayLabel,
  chatToolRunningLabelText,
  explicitChatToolRunningLabelText,
  fallbackChatToolLabel,
  hasExplicitChatToolLabels,
} from '../chatAgent/toolLabels.js';

describe('chat tool thinking labels', () => {
  it('has explicit display and running labels for every shared read tool', () => {
    for (const tool of CHAT_TOOL_NAMES) {
      expect(hasExplicitChatToolLabels(tool), `missing label for ${tool}`).toBe(true);
      expect(chatToolDisplayLabel(tool)).not.toMatch(/^Get /);
      expect(chatToolRunningLabelText(tool)).toMatch(/…$/u);
    }
  });

  it('keeps a readable fallback for unknown legacy tool ids', () => {
    expect(fallbackChatToolLabel('solana_jupiter_price')).toBe('Jupiter price');
    expect(chatToolDisplayLabel('custom_wallet_report')).toBe('Custom wallet report');
    expect(explicitChatToolRunningLabelText('custom_wallet_report')).toBeUndefined();
    expect(chatToolRunningLabelText('custom_wallet_report')).toBe('Running Custom wallet report…');
  });
});
