import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, 'EvidencePanel.tsx'), 'utf8');
const artifacts = readFileSync(join(here, '../../../components/artifacts/ArtifactsSurface.tsx'), 'utf8');

describe('truthful decision analytics UX', () => {
  it('freezes submitted assumptions and explains every displayed interval', () => {
    expect(panel).toContain('<fieldset disabled={isRunning} aria-busy={isRunning}>');
    expect(panel).toContain('run.sensitivity.perturbationPct');
    expect(panel).toContain('run.impact.drivers.map');
    expect(panel).toContain('하위 10% 분위');
    expect(panel).toContain('중앙 분위');
    expect(panel).toContain('상위 10% 분위');
    expect(panel).toContain('확정 예산이 아닙니다');
    expect(artifacts).toContain('입력 가정 기반 중앙 분위');
    expect(artifacts).toContain('확정 예산이 아닙니다');
  });
});
