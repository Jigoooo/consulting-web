import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('../../', import.meta.url));

function read(relativePath: string) {
  return readFileSync(new URL(relativePath, new URL('../../', import.meta.url)), 'utf8');
}

describe('keyboard focus visibility policy', () => {
  it('does not globally suppress focus-visible outlines for interactive controls', () => {
    const css = read('styles/global.css');

    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px\s+solid\s+var\(--accent\)/s);
    expect(css).not.toMatch(/button:focus-visible[^{]*\{[^}]*outline:\s*none/s);
    expect(css).not.toMatch(/\[role=['"]button['"]\]:focus-visible[^{]*\{[^}]*outline:\s*none/s);
  });

  it('keeps the shared button focus-visible treatment perceivable', () => {
    const css = read('shared/ui/shared-ui.css');
    const focusRule = css.match(/\.cwButton:focus-visible\s*\{([^}]*)\}/s)?.[1] ?? '';

    expect(srcRoot).toContain('/apps/web/src/');
    expect(focusRule).not.toMatch(/outline:\s*none/);
    expect(focusRule).toMatch(/outline:\s*2px\s+solid\s+var\(--accent\)/);
  });

  it('does not suppress focus rings on dark app-rail actions', () => {
    const css = read('widgets/app-shell/ui/AppShell.module.css');

    expect(css).not.toMatch(/\.(?:wsAdd|railAction):focus-visible\s*\{[^}]*outline:\s*none/s);
  });
});
