import { describe, expect, it } from 'vitest';
import { buildConsultingRecallArgs, CONSULTING_RECALL_TIMEOUT_MS, ConsultingGraphRagBridge, normalizeConsultingRecallJson, type ConsultingGraphRagRecallResult } from '../src/consulting/consulting-graphrag-bridge.service.js';

describe('ConsultingGraphRagBridge advanced recall contract', () => {
  it('enables rerank by default and gives the consulting brain CLI enough time for deep recall', () => {
    const args = buildConsultingRecallArgs({ topicSlug: 'changwon-org-mgmt-diagnosis', query: '정원 인건비', topK: 12 });

    expect(args).toContain('--rerank');
    expect(args).not.toContain('--no-rerank');
    expect(args).toContain('--backend');
    expect(args[args.indexOf('--backend') + 1]).toBe('pg');
    expect(args).toContain('--top-k');
    expect(args[args.indexOf('--top-k') + 1]).toBe('10');
    expect(CONSULTING_RECALL_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
  });

  it('surfaces rerank mode and component signal counts from recall JSON', () => {
    const normalized = normalizeConsultingRecallJson({
      ok: true,
      topic: 'topic-a',
      query: 'q',
      rerank: 'cross-encoder',
      rerank_error: 'cross_encoder_unavailable',
      signals: { semantic: 3, lexical: 2, graph: 1, file_semantic: 4, file_lexical: 5, file_graph: 6, tog2_deep: 7 },
      hits: [{
        kind: 'dialogue',
        rerank_score: 0.81,
        fused_score: 0.25,
        doc_title: 'doc',
        utility_tier: 'qualified_usable',
        context_text: '정원 인건비 근거',
        linked: ['claim:CL-1'],
        signal_breakdown: { semantic: { rank: 1, raw_score: 0.91, rrf: 0.01639 }, graph: { rank: null, raw_score: null, rrf: 0 } },
      }],
    }, { topicSlug: 'fallback-topic', query: 'fallback-q' });

    expect(normalized.ok).toBe(true);
    expect(normalized.status).toBe('ok');
    expect(normalized.rerank).toBe('cross-encoder');
    expect(normalized.rerankError).toBe('cross_encoder_unavailable');
    expect(normalized.signals).toEqual({ semantic: 3, lexical: 2, graph: 1, fileSemantic: 4, fileLexical: 5, fileGraph: 6, tog2Deep: 7 });
    expect(normalized.hits[0]?.score).toBe(0.81);
    expect(normalized.hits[0]?.rerankScore).toBe(0.81);
    expect(normalized.hits[0]?.fusedScore).toBe(0.25);
    expect(normalized.hits[0]?.graphPath).toEqual(['claim:CL-1']);
    expect(normalized.hits[0]?.signalBreakdown).toMatchObject({ semantic: { rank: 1 }, graph: { rrf: 0 } });
  });

  it('separates empty successful recall from recall failure', () => {
    const empty = normalizeConsultingRecallJson({ ok: true, topic: 't', query: 'q', hits: [] }, { topicSlug: 't', query: 'q' });
    const failed = normalizeConsultingRecallJson({ ok: false, topic: 't', query: 'q', hits: [] }, { topicSlug: 't', query: 'q' });

    expect(empty.status).toBe('empty');
    expect(failed.status).toBe('error');
  });

  it('fans out across workspace topics, applies cross-project dampening, and preserves labels', async () => {
    class FakeBridge extends ConsultingGraphRagBridge {
      calls: string[] = [];
      override async recall(input: { topicSlug: string; query: string; topK?: number }): Promise<ConsultingGraphRagRecallResult> {
        this.calls.push(input.topicSlug);
        return {
          status: 'ok',
          ok: true,
          topic: input.topicSlug,
          query: input.query,
          rerank: 'cross-encoder',
          rerankError: null,
          signals: { semantic: 1, lexical: 0, graph: 0, fileSemantic: 0, fileLexical: 0, fileGraph: 0, tog2Deep: 0 },
          hits: [{
            kind: 'dialogue',
            score: input.topicSlug === 'current-topic' ? 0.5 : 1,
            docTitle: null,
            utilityTier: null,
            text: `${input.topicSlug} hit`,
            linked: [`claim:${input.topicSlug}`],
            signalBreakdown: null,
          }],
        };
      }
    }
    const bridge = new FakeBridge();

    const result = await bridge.recallMany({
      query: '예산 정원',
      topK: 5,
      scopes: [
        { topicSlug: 'current-topic', label: '현재 프로젝트: A', relation: 'current', weight: 1 },
        { topicSlug: 'other-topic', label: '다른 프로젝트: B', relation: 'cross_project', weight: 0.6 },
        { topicSlug: 'other-topic', label: '중복', relation: 'cross_project', weight: 0.3 },
      ],
    });

    expect(bridge.calls).toEqual(['current-topic', 'other-topic']);
    expect(result.status).toBe('ok');
    expect(result.hits[0]?.sourceRelation).toBe('cross_project');
    expect(result.hits[0]?.sourceLabel).toBe('다른 프로젝트: B');
    expect(result.hits[0]?.adjustedScore).toBe(0.6);
    expect(result.hits[1]?.adjustedScore).toBe(0.5);
  });
});
