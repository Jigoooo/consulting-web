import { describe, expect, it } from 'vitest';
import { CitationPostCheckService } from '../src/consulting/citation-post-check.service.js';
import type { ConsultingGraphRagHit } from '../src/consulting/consulting-graphrag-bridge.service.js';

const evidence: ConsultingGraphRagHit[] = [{
  kind: 'file',
  score: 0.9,
  docTitle: 'fixture',
  utilityTier: 'qualified_usable',
  text: '[CL-D5-01] 모든 개선안은 정원·인건비·재정소요 영향과 함께 제시되어야 한다.',
  linked: ['claim:CL-D5-01'],
  graphPath: ['claim:CL-D5-01'],
  signalBreakdown: null,
}];

describe('CitationPostCheckService', () => {
  it('accepts cited claims when citation code and text overlap retrieved evidence', () => {
    const result = new CitationPostCheckService().verify({
      answer: '검색된 근거 기준으로, 개선안은 정원·인건비·재정소요 영향을 함께 제시해야 합니다. [CL-D5-01]',
      evidence,
    });

    expect(result.ok).toBe(true);
    expect(result.supportedClaims).toHaveLength(1);
    expect(result.citationMismatches).toHaveLength(0);
    expect(result.unsupportedClaims).toHaveLength(0);
  });

  it('flags citations that are not present in retrieved evidence', () => {
    const result = new CitationPostCheckService().verify({
      answer: '승진 수당 기준은 이미 확정되어 있습니다. [CL-NOT-FOUND]',
      evidence,
    });

    expect(result.ok).toBe(false);
    expect(result.citationMismatches[0]).toMatchObject({ citation: 'CL-NOT-FOUND', reason: 'citation_not_retrieved' });
  });

  it('flags factual-looking uncited claims as unsupported', () => {
    const result = new CitationPostCheckService().verify({
      answer: '정원은 즉시 늘려도 됩니다. 인건비 부담은 없습니다.',
      evidence,
    });

    expect(result.ok).toBe(false);
    expect(result.unsupportedClaims.length).toBeGreaterThan(0);
    expect(result.unsupportedClaims[0]?.reason).toBe('missing_citation');
  });
});
