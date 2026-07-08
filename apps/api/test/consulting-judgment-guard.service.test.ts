import { describe, expect, it } from 'vitest';
import { ConsultingJudgmentGuardService } from '../src/consulting/consulting-judgment-guard.service.js';
import type { ConsultingGraphRagHit } from '../src/consulting/consulting-graphrag-bridge.service.js';

function hit(overrides: Partial<ConsultingGraphRagHit>): ConsultingGraphRagHit {
  return {
    kind: 'file',
    score: 0.7,
    fusedScore: 0.7,
    rerankScore: 0.8,
    docTitle: '2026 지방공기업 예산편성기준.pdf',
    utilityTier: 'qualified_usable',
    text: '지방공무원 수당규정 별표9 및 지방공기업 예산편성기준을 검토한다.',
    linked: [],
    signalBreakdown: null,
    ...overrides,
  };
}

describe('ConsultingJudgmentGuardService', () => {
  const service = new ConsultingJudgmentGuardService();

  it('classifies repeated user correction plus allowance-policy risks into structured guard issues', () => {
    const result = service.evaluate({
      query: '이거 아니야. 생활체육지도사 수당은 별표9 직접 금지인지, 유사기관 벤치마킹과 통상임금/총인건비 순서를 다시 봐야 해.',
      hits: [
        hit({ text: '', docTitle: '예산편성기준_스캔본.pdf', utilityTier: 'qualified_usable' }),
        hit({ text: '지방공무원 수당규정 별표9는 공무원 수당 항목을 열거한다. 공단 근로자 적용 여부는 별도 검토가 필요하다.' }),
      ],
    });

    expect(result.required).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'source_intake_parse_failure',
      'applicability_map_required',
      'decision_gate_order_required',
      'latest_authority_required',
      'comparator_consistency_required',
      'counterargument_required',
      'user_correction_pattern',
      'overclaim_strength_risk',
    ]));
    expect(result.issueSummary).toContain('source_intake_parse_failure');
  });

  it('renders a prompt contract that separates RAG from applicability, gate order, and claim strength', () => {
    const result = service.evaluate({
      query: '민원창구 수당 신설 가능 여부를 검토해줘',
      hits: [hit({ text: '유사기관 일부는 민원업무 담당자에게 월정액 수당을 지급한다.' })],
      now: new Date('2026-07-08T14:27:38.000Z'),
    });
    const prompt = service.renderPromptContract(result);

    expect(prompt).toContain('### 컨설팅 판단 안전 게이트 v1');
    expect(prompt).toContain('runtime_current_time: 2026-07-08T14:27:38.000Z');
    expect(prompt).toContain('directly_applicable / analogical / background_only');
    expect(prompt).toContain('short-circuit');
    expect(prompt).toContain('벤치마킹은 모든 항목에 같은 방향');
    expect(prompt).toContain('사용자가 “이거 아니야”라고 지적한 패턴');
    expect(prompt).toContain('불가/금지/확정');
  });
});
