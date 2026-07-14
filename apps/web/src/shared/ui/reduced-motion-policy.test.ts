import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relativePath: string) {
  return readFileSync(new URL(relativePath, new URL('../../', import.meta.url)), 'utf8');
}

describe('reduced-motion policy', () => {
  it('clamps animation iteration-count to 1 so infinite loops cannot strobe under reduced-motion', () => {
    const css = read('styles/global.css');
    const block = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/s);
    expect(block, 'global * reduced-motion reset block should exist').not.toBeNull();
    const body = block![1];
    expect(body).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(body).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(body).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
  });
});
