import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = new URL('../../', import.meta.url);

function read(relativePath: string) {
  return readFileSync(new URL(relativePath, srcRoot), 'utf8');
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? cssFiles(path) : entry.endsWith('.css') ? [path] : [];
  });
}

describe('editorial product design policy', () => {
  it('uses a solid editorial monogram instead of a generic AI gradient mark', () => {
    const mark = read('shared/icons/BrandMark.tsx');

    expect(mark).toContain('data-brand-mark="j-monogram"');
    expect(mark).not.toMatch(/linearGradient|useId|cwBrandBg/);
  });

  it('keeps auth and product chrome free of decorative aurora, gradients, and glow', () => {
    const authTsx = read('features/auth-session/ui/AuthKit.tsx');
    const authCss = read('features/auth-session/ui/Auth.module.css');
    const shellCss = read('widgets/app-shell/ui/AppShell.module.css');
    const threadCss = read('widgets/thread-view/ui/ThreadView.module.css');
    const sharedCss = read('shared/ui/shared-ui.css');

    expect(authTsx).not.toMatch(/blob1|blob2|random\(-/);
    expect(authCss).not.toMatch(/radial-gradient|linear-gradient|accent-glow/);
    expect(shellCss.match(/\.rail\s*\{([^}]*)\}/s)?.[1] ?? '').not.toContain('gradient');
    expect(shellCss).not.toContain('accent-glow');
    // Functional skeleton shimmer may use a neutral gradient. Brand/accent
    // gradients and glow remain forbidden on persistent product chrome.
    expect(threadCss).not.toContain('accent-glow');
    expect(threadCss).not.toMatch(/linear-gradient\([^)]*(?:var\(--accent\)|#6b74e0|#8b8f98)/);
    expect(sharedCss).not.toMatch(/accent-glow|translateY\(-1px\)/);
  });

  it('uses restrained tokenized surfaces instead of elevated static cards and raw status colors', () => {
    const tokens = read('styles/tokens.css');
    const trace = read('components/observability/TraceViewerSurface.module.css');
    const artifacts = read('components/artifacts/Artifacts.module.css');
    const evidence = read('widgets/evidence-panel/ui/EvidencePanel.module.css');

    expect(tokens).toMatch(/--accent:\s*#3f5f8f/);
    expect(tokens).toMatch(/--accent-glow:\s*transparent/);
    expect(tokens).toMatch(/--radius-card:\s*10px/);
    expect(tokens.match(/--shadow-card:\s*([^;]+);/)?.[1] ?? '').not.toContain('0 0 0 1px');
    expect(trace).not.toContain('box-shadow: var(--shadow-card)');
    expect(artifacts).not.toContain('box-shadow: var(--shadow-card)');
    expect(`${artifacts}\n${evidence}`).not.toMatch(/#(?:d97706|f59e0b|dc2626|ef4444|16a34a|22c55e)/i);
  });

  it('keeps product typography within the shared 400–700 hierarchy', () => {
    const cssRoot = new URL('.', new URL('../../', import.meta.url)).pathname;
    const offenders = cssFiles(cssRoot).flatMap((path) => {
      const css = readFileSync(path, 'utf8');
      return [...css.matchAll(/font-weight:\s*(\d{3,4})/g)]
        .filter((match) => Number(match[1]) > 700)
        .map((match) => `${path}:${match[1]}`);
    });

    expect(offenders).toEqual([]);
  });
});
