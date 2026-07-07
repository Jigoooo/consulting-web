import { Inject, Injectable } from '@nestjs/common';
import { ConsultingGraphRagBridge, type ConsultingGraphRagHit, type ConsultingGraphRagRecallScope } from './consulting-graphrag-bridge.service.js';
import { ConsultingTopicResolver, type ConsultingResolvedScope } from './consulting-topic-resolver.service.js';
import { EvidenceSufficiencyEvaluator, type EvidenceSufficiencyDecision } from './evidence-sufficiency-evaluator.service.js';

export interface ConsultingMemoryContextInput {
  threadId: string;
  query: string;
}

@Injectable()
export class ConsultingMemoryContextBuilder {
  constructor(
    @Inject(ConsultingTopicResolver) private readonly resolver: ConsultingTopicResolver,
    @Inject(ConsultingGraphRagBridge) private readonly bridge: ConsultingGraphRagBridge,
    @Inject(EvidenceSufficiencyEvaluator) private readonly evaluator: EvidenceSufficiencyEvaluator,
  ) {}

  async build(input: ConsultingMemoryContextInput): Promise<string> {
    try {
      const fanout = await this.resolver.resolveThreadFanout(input.threadId);
      if (!fanout || fanout.scope.archived) return '';
      const recallScopes: ConsultingGraphRagRecallScope[] = fanout.recallScopes
        .filter((scope) => !scope.archived)
        .map((scope) => ({ topicSlug: scope.topicSlug, label: scope.label, relation: scope.relation, weight: scope.weight }));
      const recall = await this.bridge.recallMany({ scopes: recallScopes, query: input.query, topK: 5 });
      const decision = this.evaluator.evaluate({ query: input.query, hits: recall.hits });
      return this.render(fanout.scope, recall.hits.slice(0, 5), decision);
    } catch {
      // GraphRAG context is a best-effort side channel. Never break chat streaming.
      return '';
    }
  }

  private render(scope: ConsultingResolvedScope, hits: ConsultingGraphRagHit[], decision: EvidenceSufficiencyDecision): string {
    const lines = [
      '## 기존 컨설팅 GraphRAG 참고 기억',
      '',
      '아래 내용은 기존 텔레그램/문서 기반 컨설팅 GraphRAG에서 검색된 참고 기억이다.',
      '답변에 활용하되, 현재 사용자의 질문과 직접 관련 있는 항목만 근거로 삼고 과장하지 않는다.',
      '',
      `- 연결된 컨설팅 과업: ${scope.consultingTopicSlug}`,
      '- 다른 프로젝트 자료는 참조용이며 현재 범위의 사실처럼 단정하지 않는다.',
      `- 현재 web 범위: ${scope.projectName} > ${scope.channelName} > ${scope.topicName} > ${scope.threadTitle}`,
      `- scope path: ${scope.scopePath}`,
      '',
      `### CRAG 판단: ${decision.status}`,
      `- reason: ${decision.reason}`,
      `- required_action: ${decision.requiredAction}`,
      ...(decision.status === 'insufficient'
        ? ['- 기존 자료상 근거 부족: 답변을 생성하지 말고, 필요한 근거/자료를 요청하거나 “기존 자료상 근거 부족”이라고 말한다.']
        : []),
      ...(decision.status === 'ambiguous'
        ? ['- 검색 근거가 애매함: 다른 프로젝트/범위 라벨을 붙이고, 현재 범위의 사실처럼 단정하지 않는다.']
        : []),
      '',
      '### 검색 hit',
    ];
    if (hits.length === 0) {
      lines.push('', '(검색 hit 없음)');
    }
    hits.forEach((hit, index) => {
      const title = hit.docTitle ?? hit.kind;
      const tier = hit.utilityTier ? ` / ${hit.utilityTier}` : '';
      const linked = hit.linked.length > 0 ? ` / linked: ${hit.linked.slice(0, 5).join(', ')}` : '';
      const source = hit.sourceRelation === 'cross_project'
        ? ` / ${this.crossProjectLabel(hit)}`
        : (hit.sourceLabel ? ` / ${hit.sourceLabel}` : '');
      lines.push('', `#### ${index + 1}. ${title}${tier}${linked}${source}`, this.metadataLine(hit), this.compact(hit.text));
    });
    lines.push('', '### 사용 규칙', '- 확실한 근거처럼 단정하지 말고 “기존 자료 기준” 또는 “검색된 근거 기준”으로 표현한다.', '- 다른 프로젝트/보관 자료가 섞인 경우 반드시 라벨을 붙인다.', '- CRAG 판단이 insufficient이면 근거 없는 답변을 금지한다.');
    return lines.join('\n');
  }

  private compact(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 1_200);
  }

  private crossProjectLabel(hit: ConsultingGraphRagHit): string {
    const label = hit.sourceLabel ?? hit.sourceTopicSlug ?? '미상';
    return label.startsWith('다른 프로젝트') ? label : `다른 프로젝트: ${label}`;
  }

  private metadataLine(hit: ConsultingGraphRagHit): string {
    const parts: string[] = [];
    if (typeof hit.score === 'number') parts.push(`score=${this.round(hit.score)}`);
    if (typeof hit.rerankScore === 'number') parts.push(`rerank=${this.round(hit.rerankScore)}`);
    if (typeof hit.fusedScore === 'number') parts.push(`fused=${this.round(hit.fusedScore)}`);
    const signals = this.signalSummary(hit.signalBreakdown);
    if (signals) parts.push(`signals: ${signals}`);
    const graphPath = (hit.graphPath && hit.graphPath.length > 0 ? hit.graphPath : hit.linked).slice(0, 5);
    if (graphPath.length > 0) parts.push(`graph path: ${graphPath.join(' -> ')}`);
    return parts.length > 0 ? `- ${parts.join(' / ')}` : '- score=unknown';
  }

  private signalSummary(signalBreakdown: ConsultingGraphRagHit['signalBreakdown']): string | null {
    if (!signalBreakdown) return null;
    const out: string[] = [];
    for (const [name, raw] of Object.entries(signalBreakdown)) {
      if (!raw || typeof raw !== 'object') continue;
      const rank = (raw as { rank?: unknown }).rank;
      const rrf = (raw as { rrf?: unknown }).rrf;
      if (typeof rank === 'number') out.push(`${name}#${rank}`);
      else if (typeof rrf === 'number' && rrf > 0) out.push(`${name}`);
    }
    return out.length > 0 ? out.slice(0, 6).join(', ') : null;
  }

  private round(value: number): string {
    return Number(value.toFixed(4)).toString();
  }
}
