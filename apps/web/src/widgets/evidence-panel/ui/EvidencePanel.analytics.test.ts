import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDecisionAnalyticsRunPending } from './EvidencePanel';

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, 'EvidencePanel.tsx'), 'utf8');
const artifacts = readFileSync(join(here, '../../../components/artifacts/ArtifactsSurface.tsx'), 'utf8');

describe('decision analytics product UI', () => {
  it('renders audited stability, critical axes, impact intervals, and a bounded manual form', () => {
    expect(panel).toContain('useRunDecisionAnalytics(threadId)');
    expect(panel).toContain('승자 안정성');
    expect(panel).toContain('순위 역전 임계축');
    expect(panel).toContain('P10');
    expect(panel).toContain('P50');
    expect(panel).toContain('P90');
    expect(panel).toContain('영향 추정 실행');
    expect(panel).toContain('입력값을 곱하는 모델');
    expect(panel).toContain('data-testid="decision-analytics-audit"');
  });

  it('binds analytics beside an immutable artifact version without mutating markdown content', () => {
    expect(artifacts).toContain('useArtifactVersionDecisionAnalytics(shown?.sourceThreadId, shown?.id)');
    expect(artifacts).toContain('artifactVersionId: shown.id');
    expect(artifacts).toContain('본문과 분리된 감사 원장');
    expect(artifacts).toContain('현재 버전에 결정 분석 연결');
  });

  it('isolates local drafts and pending state when the latest scorecard changes', () => {
    expect(panel).toContain("key={decision.data?.latestScorecard?.id ?? 'empty-scorecard'}");
    expect(isDecisionAnalyticsRunPending(
      true,
      { scorecardId: 'scorecard-a' },
      'scorecard-b',
    )).toBe(false);
    expect(isDecisionAnalyticsRunPending(
      true,
      { scorecardId: 'scorecard-b' },
      'scorecard-b',
    )).toBe(true);
    expect(isDecisionAnalyticsRunPending(false, { scorecardId: 'scorecard-b' }, 'scorecard-b')).toBe(false);
  });
});
