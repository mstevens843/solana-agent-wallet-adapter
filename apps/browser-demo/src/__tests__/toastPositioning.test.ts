import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function sourceBetween(start: string, end: string): string {
  const startIndex = stylesSource.indexOf(start);
  const endIndex = stylesSource.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`CSS markers not found: ${start} -> ${end}`);
  }
  return stylesSource.slice(startIndex, endIndex);
}

describe('mobile toast positioning', () => {
  it('positions the mobile toast stack from toast-specific safe-area clearance', () => {
    const mobileToastBlock = sourceBetween(
      '  .toast-stack {\n    bottom: auto;',
      '\n\n  body:has(.shell.android-shell)',
    );

    expect(mobileToastBlock).toContain('top: var(--toast-mobile-top-clearance)');
    expect(mobileToastBlock).toContain('max-height: calc(100dvh - var(--toast-mobile-top-clearance) - var(--toast-mobile-bottom-clearance))');
    expect(mobileToastBlock).toContain('overflow-y: auto');
    expect(mobileToastBlock).not.toContain('--mobile-nav-safe-top');
  });

  it('defines deterministic native shell top clearances at body scope', () => {
    expect(stylesSource).toContain('--toast-mobile-top-clearance: calc(16px + env(safe-area-inset-top, 0px));');
    expect(stylesSource).toContain('body:has(.shell.android-shell) {\n    --toast-mobile-bottom-clearance: var(--bottom-dock-clearance);\n    --toast-mobile-top-clearance: max(48px, calc(env(safe-area-inset-top, 0px) + 16px));\n  }');
    expect(stylesSource).toContain('body:has(.shell.ios-native-shell) {\n    --toast-mobile-bottom-clearance: var(--bottom-dock-clearance);\n    --toast-mobile-top-clearance: max(64px, calc(env(safe-area-inset-top, 0px) + 16px));\n  }');
  });
});
