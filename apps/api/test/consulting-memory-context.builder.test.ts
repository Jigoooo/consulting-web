import { describe, expect, it } from 'vitest';
import { ConsultingMemoryContextBuilder } from '../src/consulting/consulting-memory-context.builder.js';
import type { ConsultingGraphRagBridge } from '../src/consulting/consulting-graphrag-bridge.service.js';
import type { ConsultingTopicResolver } from '../src/consulting/consulting-topic-resolver.service.js';

describe('ConsultingMemoryContextBuilder', () => {
  it('renders normalized GraphRAG hits with scope labels for Hermes instructions', async () => {
    const resolver = {
      resolveThread: async () => ({
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
      }),
    };
    const bridge = {
      recall: async () => ({
        ok: true,
        topic: 'changwon-org-mgmt-diagnosis',
        query: '정원 인건비 조직진단',
        hits: [{
          kind: 'file',
          score: 0.03,
          docTitle: 'claim:CL-D5-01',
          utilityTier: 'qualified_usable',
          text: '[CL-D5-01] 모든 개선안은 정원·인건비·재정소요 영향과 함께 제시되어야 한다.',
          linked: ['claim:CL-D5-01'],
        }],
      }),
    };

    const builder = new ConsultingMemoryContextBuilder(
      resolver as unknown as ConsultingTopicResolver,
      bridge as unknown as ConsultingGraphRagBridge,
    );
    const context = await builder.build({ threadId: 'thread', query: '정원 인건비 조직진단' });

    expect(context).toContain('## 기존 컨설팅 GraphRAG 참고 기억');
    expect(context).toContain('changwon-org-mgmt-diagnosis');
    expect(context).toContain('창원시 컨설팅 > 분석 > 시설 적정성 진단 > 정원 검토');
    expect(context).toContain('claim:CL-D5-01');
    expect(context).toContain('정원·인건비');
  });
});
