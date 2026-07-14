import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The scope lifecycle is "archive" end-to-end: the backend uses
 * scope_lifecycle_transitions, an `archived` status, PARENT_ARCHIVED errors and a
 * restoreArchived mutation. The UI must speak the same word — the archived-scopes
 * entry point and panel previously called archived items "숨긴 항목/숨긴 프로젝트",
 * which drifted from the "보관" action verb used everywhere else and confused the
 * restore entry point. This test pins the unified "보관" vocabulary.
 */
function readAppShell(): string {
  return readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8');
}

describe('archive lifecycle terminology', () => {
  it('names the archived-scopes entry point and panel with the 보관 vocabulary', () => {
    const src = readAppShell();
    // The restore entry point + panel title use 보관한 항목, not 숨긴 항목.
    expect(src).toContain('보관한 항목');
    expect(src).not.toContain('숨긴 항목');
    // Archived scopes are described as 보관한 …, never 숨긴 프로젝트/채널/대화.
    expect(src).not.toMatch(/숨긴\s*프로젝트·채널·대화/);
  });

  it('keeps the archive action verbs (보관하기 / 복원) intact', () => {
    const src = readAppShell();
    expect(src).toContain('보관하기');
    expect(src).toContain('복원');
  });
});
