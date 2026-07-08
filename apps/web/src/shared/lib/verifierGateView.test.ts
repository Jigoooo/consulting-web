import { describe, expect, it } from 'vitest';
import type { VerifierGateSummary } from '@consulting/contracts';
import { describeVerifierGate } from './verifierGateView';

const gate = (decision: VerifierGateSummary['decision'], blockerCount = 0, warningCount = 0): VerifierGateSummary => ({
  decision,
  blockers: Array.from({ length: blockerCount }, (_, i) => ({
    code: 'high_impact_refute' as const,
    severity: 'blocker' as const,
    message: `차단 ${i + 1}`,
  })),
  warnings: Array.from({ length: warningCount }, (_, i) => ({
    code: 'semantic_unsupported' as const,
    severity: 'warning' as const,
    message: `경고 ${i + 1}`,
  })),
});

describe('describeVerifierGate', () => {
  it('labels blocked release gates as danger with issue counts', () => {
    expect(describeVerifierGate(gate('BLOCKED', 2, 1))).toEqual({
      label: '릴리즈 차단',
      tone: 'bad',
      detail: '차단 2 · 경고 1',
      title: '차단 2건, 경고 1건',
    });
  });

  it('keeps general-chat warnings distinct from hard blocks', () => {
    expect(describeVerifierGate(gate('PASS_WITH_WARNINGS', 0, 3))).toEqual({
      label: '검토 필요',
      tone: 'warn',
      detail: '경고 3',
      title: '경고 3건',
    });
  });

  it('shows a compact pass label when there are no issues', () => {
    expect(describeVerifierGate(gate('PASS'))).toEqual({
      label: '게이트 통과',
      tone: 'good',
      detail: '이슈 없음',
      title: '검증 게이트 통과',
    });
  });
});
