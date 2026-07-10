import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'EvidencePanel.tsx'), 'utf8');

// Contract-level UI regression: retrieval-hit feedback must stay in the
// verification panel (not be conflated with evidence_items in the sources tab).
describe('EvidencePanel retrieval feedback', () => {
  it('loads thread retrieval hits and exposes one-click positive plus failure-taxonomy actions', () => {
    expect(source).toContain('useRetrievalHits(threadId)');
    expect(source).toContain('useRetrievalHitFeedback(threadId)');
    expect(source).toContain('검색 근거 품질');
    expect(source).toContain('유효');
    expect(source).toContain('다른 프로젝트');
    expect(source).toContain('원문 과다');
    expect(source).toContain('오래된 자료');
    expect(source).toContain('중복');
  });

  it('keeps explicit all, refuted, and unsupported review-queue filters wired to the query', () => {
    expect(source).toContain("useState<ReviewQueueFilter>('all')");
    expect(source).toContain('useReviewQueue(threadId, reviewFilter)');
    expect(source).toContain("{ id: 'refuted_claim', label: '반박' }");
    expect(source).toContain("{ id: 'unsupported_claim', label: '근거부족' }");
    expect(source).toContain('aria-pressed={reviewFilter === filter.id}');
  });
});
