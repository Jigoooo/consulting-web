import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./ThreadView.module.css', import.meta.url), 'utf8');

describe('mobile thread header policy', () => {
  it('stacks the title and controls while allowing search to shrink below 720px', () => {
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.head\s*\{[^}]*flex-direction:\s*column/s);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.right\s*\{[^}]*width:\s*100%[^}]*margin-left:\s*0/s);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.threadSearch\s*\{[^}]*min-width:\s*0[^}]*flex:\s*1/s);
  });
});
