import { describe, expect, it } from 'vitest';
import { EvidenceSufficiencyEvaluator } from '../src/consulting/evidence-sufficiency-evaluator.service.js';
import type { ConsultingGraphRagHit } from '../src/consulting/consulting-graphrag-bridge.service.js';

function hit(overrides: Partial<ConsultingGraphRagHit>): ConsultingGraphRagHit {
  return {
    kind: 'file',
    score: 0.5,
    docTitle: 'fixture',
    utilityTier: 'qualified_usable',
    text: '정원 인건비 재정소요 근거 자료',
    linked: ['claim:CL-D5-01'],
    graphPath: ['claim:CL-D5-01'],
    signalBreakdown: { file_semantic: { rank: 1, rrf: 0.01639 }, file_graph: { rank: 1, rrf: 0.01639 } },
    ...overrides,
  };
}

describe('EvidenceSufficiencyEvaluator', () => {
  it('marks evidence as sufficient when query terms, claim links, and signals align', () => {
    const result = new EvidenceSufficiencyEvaluator().evaluate({
      query: '정원 인건비 재정소요 판단 근거',
      hits: [hit({})],
    });

    expect(result.status).toBe('sufficient');
    expect(result.reason).toContain('query_terms');
    expect(result.requiredAction).toBe('answer_with_citations');
  });

  it('marks cross-project-only evidence as ambiguous, not current-scope proof', () => {
    const result = new EvidenceSufficiencyEvaluator().evaluate({
      query: '정원 인건비 재정소요 판단 근거',
      hits: [hit({ sourceRelation: 'cross_project', sourceLabel: '다른 프로젝트: 예산' })],
    });

    expect(result.status).toBe('ambiguous');
    expect(result.requiredAction).toBe('answer_with_scope_label_or_ask');
    expect(result.reason).toContain('cross_project_only');
  });

  it('marks missing or off-topic evidence as insufficient and blocks unsupported answers', () => {
    const empty = new EvidenceSufficiencyEvaluator().evaluate({ query: '승진 수당 기준', hits: [] });
    const offTopic = new EvidenceSufficiencyEvaluator().evaluate({
      query: '승진 수당 기준',
      hits: [hit({ text: '정원 인건비 재정소요 근거 자료', linked: [], signalBreakdown: null })],
    });

    expect(empty.status).toBe('insufficient');
    expect(empty.requiredAction).toBe('refuse_or_request_evidence');
    expect(offTopic.status).toBe('insufficient');
    expect(offTopic.reason).toContain('low_overlap');
  });
});
