import { describe, expect, it } from 'vitest';
import { ConsultingMemoryContextBuilder } from '../src/consulting/consulting-memory-context.builder.js';
import { EvidenceSufficiencyEvaluator } from '../src/consulting/evidence-sufficiency-evaluator.service.js';
import type { ConsultingGraphRagBridge } from '../src/consulting/consulting-graphrag-bridge.service.js';
import type { ConsultingTopicResolver } from '../src/consulting/consulting-topic-resolver.service.js';

describe('ConsultingMemoryContextBuilder', () => {
  it('renders normalized GraphRAG hits with scope labels for Hermes instructions', async () => {
    const resolver = {
      resolveThreadFanout: async () => ({
        scope: {
          workspaceId: 'ws',
          projectId: 'project',
          channelId: 'channel',
          topicId: 'topic',
          threadId: 'thread',
          projectName: '창원시 컨설팅',
          channelName: '분석',
          topicName: '시설 적정성 진단',
          threadTitle: '정원 검토',
          consultingTopicSlug: 'changwon-org-mgmt-diagnosis',
          consultingTopicId: 5,
          linkLevel: 'project' as const,
          scopePath: '창원시 컨설팅/분석/시설 적정성 진단/정원 검토',
          archived: false,
        },
        recallScopes: [
          { topicSlug: 'changwon-org-mgmt-diagnosis', topicId: 5, label: '현재 프로젝트: 창원시 컨설팅', relation: 'current' as const, weight: 1, archived: false },
          { topicSlug: 'other-consulting-topic', topicId: 6, label: '다른 프로젝트: 예산 컨설팅', relation: 'cross_project' as const, weight: 0.6, archived: false },
        ],
      }),
    };
    const bridge = {
      recallMany: async () => ({
        status: 'ok',
        ok: true,
        topic: 'changwon-org-mgmt-diagnosis,other-consulting-topic',
        query: '정원 인건비 조직진단',
        rerank: 'cross-encoder',
        rerankError: null,
        signals: null,
        hits: [{
          kind: 'file',
          score: 0.03,
          fusedScore: 0.028,
          rerankScore: 0.81,
          docTitle: 'claim:CL-D5-01',
          utilityTier: 'qualified_usable',
          text: '[CL-D5-01] 모든 개선안은 정원·인건비·재정소요 영향과 함께 제시되어야 한다.',
          linked: ['claim:CL-D5-01'],
          graphPath: ['claim:CL-D5-01'],
          signalBreakdown: { file_semantic: { rank: 1, rrf: 0.01639 }, file_graph: { rank: 2, rrf: 0.01613 } },
          sourceTopicSlug: 'other-consulting-topic',
          sourceLabel: '다른 프로젝트: 예산 컨설팅',
          sourceRelation: 'cross_project' as const,
        }],
      }),
    };

    const builder = new ConsultingMemoryContextBuilder(
      resolver as unknown as ConsultingTopicResolver,
      bridge as unknown as ConsultingGraphRagBridge,
      new EvidenceSufficiencyEvaluator(),
    );
    const context = await builder.build({ threadId: 'thread', query: '정원 인건비 조직진단' });

    expect(context).toContain('## 기존 컨설팅 GraphRAG 참고 기억');
    expect(context).toContain('changwon-org-mgmt-diagnosis');
    expect(context).toContain('창원시 컨설팅 > 분석 > 시설 적정성 진단 > 정원 검토');
    expect(context).toContain('다른 프로젝트: 예산 컨설팅');
    expect(context).toContain('claim:CL-D5-01');
    expect(context).toContain('score=0.03');
    expect(context).toContain('rerank=0.81');
    expect(context).toContain('signals: file_semantic#1, file_graph#2');
    expect(context).toContain('graph path: claim:CL-D5-01');
    expect(context).toContain('CRAG 판단: ambiguous');
    expect(context).toContain('정원·인건비');
  });

  it('returns an explicit insufficient-evidence instruction instead of silently omitting recall context', async () => {
    const resolver = {
      resolveThreadFanout: async () => ({
        scope: {
          workspaceId: 'ws', projectId: 'project', channelId: 'channel', topicId: 'topic', threadId: 'thread',
          projectName: '창원시 컨설팅', channelName: '분석', topicName: '시설 적정성 진단', threadTitle: '정원 검토',
          consultingTopicSlug: 'changwon-org-mgmt-diagnosis', consultingTopicId: 5, linkLevel: 'project' as const,
          scopePath: '창원시 컨설팅/분석/시설 적정성 진단/정원 검토', archived: false,
        },
        recallScopes: [{ topicSlug: 'changwon-org-mgmt-diagnosis', topicId: 5, label: '현재 프로젝트: 창원시 컨설팅', relation: 'current' as const, weight: 1, archived: false }],
      }),
    };
    const bridge = {
      recallMany: async () => ({
        status: 'empty', ok: true, topic: 'changwon-org-mgmt-diagnosis', query: '승진 수당 기준', rerank: 'cross-encoder', rerankError: null, signals: null, hits: [],
      }),
    };

    const context = await new ConsultingMemoryContextBuilder(
      resolver as unknown as ConsultingTopicResolver,
      bridge as unknown as ConsultingGraphRagBridge,
      new EvidenceSufficiencyEvaluator(),
    ).build({ threadId: 'thread', query: '승진 수당 기준' });

    expect(context).toContain('CRAG 판단: insufficient');
    expect(context).toContain('기존 자료상 근거 부족');
    expect(context).toContain('답변을 생성하지 말고');
  });
});
