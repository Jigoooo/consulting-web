import { Inject, Injectable } from '@nestjs/common';
import { ConsultingGraphRagBridge, type ConsultingGraphRagHit } from './consulting-graphrag-bridge.service.js';
import { ConsultingTopicResolver, type ConsultingResolvedScope } from './consulting-topic-resolver.service.js';

export interface ConsultingMemoryContextInput {
  threadId: string;
  query: string;
}

@Injectable()
export class ConsultingMemoryContextBuilder {
  constructor(
    @Inject(ConsultingTopicResolver) private readonly resolver: ConsultingTopicResolver,
    @Inject(ConsultingGraphRagBridge) private readonly bridge: ConsultingGraphRagBridge,
  ) {}

  async build(input: ConsultingMemoryContextInput): Promise<string> {
    try {
      const scope = await this.resolver.resolveThread(input.threadId);
      if (!scope || scope.archived) return '';
      const recall = await this.bridge.recall({ topicSlug: scope.consultingTopicSlug, query: input.query, topK: 5 });
      if (recall.hits.length === 0) return '';
      return this.render(scope, recall.hits.slice(0, 5));
    } catch {
      // GraphRAG context is a best-effort side channel. Never break chat streaming.
      return '';
    }
  }

  private render(scope: ConsultingResolvedScope, hits: ConsultingGraphRagHit[]): string {
    const lines = [
      '## 기존 컨설팅 GraphRAG 참고 기억',
      '',
      '아래 내용은 기존 텔레그램/문서 기반 컨설팅 GraphRAG에서 검색된 참고 기억이다.',
      '답변에 활용하되, 현재 사용자의 질문과 직접 관련 있는 항목만 근거로 삼고 과장하지 않는다.',
      '',
      `- 연결된 컨설팅 과업: ${scope.consultingTopicSlug}`,
      `- 현재 web 범위: ${scope.projectName} > ${scope.channelName} > ${scope.topicName} > ${scope.threadTitle}`,
      `- scope path: ${scope.scopePath}`,
      '',
      '### 검색 hit',
    ];
    hits.forEach((hit, index) => {
      const title = hit.docTitle ?? hit.kind;
      const tier = hit.utilityTier ? ` / ${hit.utilityTier}` : '';
      const linked = hit.linked.length > 0 ? ` / linked: ${hit.linked.slice(0, 5).join(', ')}` : '';
      lines.push('', `#### ${index + 1}. ${title}${tier}${linked}`, this.compact(hit.text));
    });
    lines.push('', '### 사용 규칙', '- 확실한 근거처럼 단정하지 말고 “기존 자료 기준” 또는 “검색된 근거 기준”으로 표현한다.', '- 다른 프로젝트/보관 자료가 섞인 경우 반드시 라벨을 붙인다.');
    return lines.join('\n');
  }

  private compact(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 1_200);
  }
}
