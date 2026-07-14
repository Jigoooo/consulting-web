import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evidencePanelLoadState } from './evidencePanelState';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'EvidencePanel.tsx'), 'utf8');

describe('evidence panel data states', () => {
  it('distinguishes loading, error, empty, ready, and stale-data states', () => {
    expect(evidencePanelLoadState(true, false, 0)).toBe('loading');
    expect(evidencePanelLoadState(false, true, 0)).toBe('error');
    expect(evidencePanelLoadState(false, false, 0)).toBe('empty');
    expect(evidencePanelLoadState(false, false, 2)).toBe('ready');
    expect(evidencePanelLoadState(false, true, 2)).toBe('stale');
  });

  it('renders retryable errors for every evidence intelligence query', () => {
    expect(source).toContain("sourceState === 'error'");
    expect(source).toContain("sourceState === 'stale'");
    expect(source).toContain('decision.isError');
    expect(source).toContain('retrieval.isError');
    expect(source).toContain('review.isError');
    expect(source).toContain('function PanelError');
  });
});
