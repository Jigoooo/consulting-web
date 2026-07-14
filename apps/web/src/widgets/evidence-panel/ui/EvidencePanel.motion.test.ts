import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'EvidencePanel.module.css'), 'utf8');
const tsx = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'EvidencePanel.tsx'), 'utf8');

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  return match?.[1] ?? '';
}

describe('evidence add-form motion policy', () => {
  it('does not stagger individual form controls when opening or closing the right-panel form', () => {
    expect(css).not.toContain('cwFieldRise');
    expect(css).not.toMatch(/animation-delay\s*:/);
  });

  it('does not animate the add button margin while the form closes', () => {
    expect(cssRule('.addBtnShell')).not.toMatch(/margin-top/);
    expect(cssRule('.addBtnShellHidden')).not.toMatch(/margin-top/);
  });

  it('does not transition the add-form or add-button height', () => {
    expect(cssRule('.formShell')).not.toMatch(/transition\s*:/);
    expect(cssRule('.addBtnShell')).not.toMatch(/transition\s*:/);
  });

  it('removes hidden surfaces from layout instead of collapsing them as accordions', () => {
    expect(cssRule('.formShell')).toMatch(/display:\s*none/);
    expect(cssRule('.formShellOpen')).toMatch(/display:\s*block/);
    expect(cssRule('.addBtnShellHidden')).toMatch(/display:\s*none/);
  });

  it('keeps closed form card spacing out of hidden layout state', () => {
    const closedInner = cssRule('.formInner');
    const openInner = cssRule('.formShellOpen .formInner');

    expect(closedInner).not.toMatch(/margin-top:\s*6px/);
    expect(closedInner).not.toMatch(/padding:\s*8px/);
    expect(closedInner).not.toMatch(/box-shadow:\s*var\(--shadow-1\)/);
    expect(openInner).toMatch(/margin-top:\s*6px/);
    expect(openInner).toMatch(/padding:\s*8px/);
    expect(openInner).toMatch(/box-shadow:\s*var\(--shadow-1\)/);
  });
});

describe('evidence tab motion policy', () => {
  it('uses a transform-driven thumb for mode tabs instead of repainting the selected button background', () => {
    expect(cssRule('.modeTabs::before')).toMatch(/transform:\s*translateX/);
    expect(cssRule('.modeTabs::before')).toMatch(/transition:\s*transform/);
    expect(cssRule('.modeTabOn')).not.toMatch(/background:/);
  });

  it('animates mode panel changes horizontally with reduced-motion fallback', () => {
    expect(cssRule('.modePanel')).toMatch(/animation:\s*cwEvidencePanelSlide/);
    expect(css).toContain('@keyframes cwEvidencePanelSlideForward');
    expect(css).toContain('@keyframes cwEvidencePanelSlideBack');
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('does not zoom or fully disappear the panel during tab changes', () => {
    const modeMotion = css.slice(
      css.indexOf('@keyframes cwEvidencePanelSlideForward'),
      css.indexOf('.decisionStack'),
    );
    expect(modeMotion).not.toMatch(/scale\(/);
    expect(modeMotion).not.toMatch(/opacity:\s*0/);
  });

  it('uses a transform-driven thumb for the channel/project scope switch', () => {
    expect(cssRule('.scopeSwitch::before')).toMatch(/transform:\s*translateX/);
    expect(cssRule('.scopeSwitch::before')).toMatch(/transition:\s*transform/);
    expect(cssRule('.scopeBtnOn')).not.toMatch(/background:/);
  });

  it('preloads project-wide evidence before the first project-scope click to avoid blank flicker', () => {
    expect(tsx).toContain('useProjectEvidence(projectId, Boolean(projectId))');
    expect(tsx).not.toContain("useProjectEvidence(projectId, scope === 'project')");
  });
});
