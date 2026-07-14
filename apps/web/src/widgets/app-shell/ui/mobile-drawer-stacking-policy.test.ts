import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function numericZIndex(css: string, selector: string): number {
  const body = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? '';
  const value = body.match(/z-index:\s*(\d+)/)?.[1];
  if (!value) throw new Error(`missing numeric z-index for .${selector}`);
  return Number(value);
}

describe('mobile drawer stacking policy', () => {
  it('keeps the drawer trigger above the thread header so it remains clickable', () => {
    const shellCss = readFileSync(new URL('./AppShell.module.css', import.meta.url), 'utf8');
    const threadCss = readFileSync(new URL('../../thread-view/ui/ThreadView.module.css', import.meta.url), 'utf8');

    expect(numericZIndex(shellCss, 'drawerBtn')).toBeGreaterThan(numericZIndex(threadCss, 'head'));
  });
});
