import { Inject, Injectable } from '@nestjs/common';
import { ConsultingGraphRagBridge, type ConsultingGraphRagHit, type ConsultingGraphRagRecallScope } from './consulting-graphrag-bridge.service.js';
import { ConsultingTopicResolver, type ConsultingResolvedScope } from './consulting-topic-resolver.service.js';
import { EvidenceSufficiencyEvaluator, type EvidenceSufficiencyDecision } from './evidence-sufficiency-evaluator.service.js';
import { EvidenceToDecisionService, type ClaimInput, type EvidenceInput, type GraphEdgeInput } from './evidence-to-decision.service.js';

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
    @Inject(EvidenceToDecisionService) private readonly evidenceToDecision: EvidenceToDecisionService,
  ) {}

  async build(input: ConsultingMemoryContextInput): Promise<string> {
    try {
      const fanout = await this.resolver.resolveThreadFanout(input.threadId);
      if (!fanout || fanout.scope.archived) return '';
      const recallScopes: ConsultingGraphRagRecallScope[] = fanout.recallScopes
        .filter((scope) => !scope.archived)
        .map((scope) => ({ topicSlug: scope.topicSlug, label: scope.label, relation: scope.relation, weight: scope.weight }));
      const diffusionWeighted = this.diffusionWeightedScopes(recallScopes);
      const recall = await this.bridge.recallMany({ scopes: diffusionWeighted.scopes, query: input.query, topK: 8 });
      const decision = this.evaluator.evaluate({ query: input.query, hits: recall.hits });
      const hits = this.diffusionRankHits(recall.hits, diffusionWeighted.scores).slice(0, 5);
      return this.render(fanout.scope, hits, decision, this.evidenceDecisionLines(input.query, hits, decision));
    } catch {
      // GraphRAG context is a best-effort side channel. Never break chat streaming.
      return '';
    }
  }

  private render(scope: ConsultingResolvedScope, hits: ConsultingGraphRagHit[], decision: EvidenceSufficiencyDecision, evidenceDecisionLines: string[]): string {
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
      ...evidenceDecisionLines,
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

  private evidenceDecisionLines(query: string, hits: ConsultingGraphRagHit[], decision: EvidenceSufficiencyDecision): string[] {
    const claims = this.claimsFromHits(query, hits);
    const evidence = this.evidenceFromHits(hits);
    const lattice = this.evidenceToDecision.buildClaimVerificationLattice({ claims, evidence });
    const diffusion = this.evidenceToDecision.diffuseGraph({
      seedIds: ['thread:current'],
      edges: this.graphEdgesFromHits(hits),
      mode: 'ppr',
      iterations: 8,
    });
    const documentUnits = this.evidenceToDecision.buildDocumentRetrievalUnits({
      documents: hits
        .filter((hit) => hit.kind === 'file' || hit.kind === 'document' || /\.pdf$/iu.test(hit.docTitle ?? ''))
        .map((hit, index) => ({
          id: `hit-${index + 1}`,
          title: hit.docTitle ?? `${hit.kind}-${index + 1}`,
          text: hit.text,
          qualityScore: this.hitQualityScore(hit),
        })),
    });
    const review = this.evidenceToDecision.prioritizeReviewQueue({
      items: this.reviewItemsFromDecision(decision, lattice.summary.notEnoughInfo + lattice.summary.refutes),
    });
    const modalityCounts = documentUnits.reduce<Record<string, number>>((acc, unit) => {
      acc[unit.modality] = (acc[unit.modality] ?? 0) + 1;
      return acc;
    }, {});
    const topDiffused = diffusion.ranked.slice(0, 3).map((item) => `${item.id}=${item.score}`).join(', ');
    const crossProject = hits.some((hit) => hit.sourceRelation === 'cross_project') ? 'cross_project diffusion 적용' : 'same-scope diffusion 적용';

    return [
      '',
      '### Evidence-to-Decision v1',
      `- claim_verdicts: supports=${lattice.summary.supports}, refutes=${lattice.summary.refutes}, not_enough_info=${lattice.summary.notEnoughInfo}`,
      `- graph_diffusion: ${diffusion.method}; ${crossProject}; top=${topDiffused || 'none'}`,
      `- document_units: table=${modalityCounts.table ?? 0}, text=${modalityCounts.text ?? 0}, page_visual=${modalityCounts.page_visual ?? 0}`,
      `- active_review_top: ${review[0] ? `${review[0].title} score=${review[0].priorityScore}` : 'none'}`,
      `- LLM 사용 지시: claim_verdicts가 refutes/not_enough_info이면 단정 금지; cross_project diffusion 항목은 참조 라벨을 붙이고 현재 범위 사실처럼 말하지 않는다.`,
    ];
  }

  private diffusionWeightedScopes(scopes: ConsultingGraphRagRecallScope[]): { scopes: ConsultingGraphRagRecallScope[]; scores: Record<string, number> } {
    if (scopes.length === 0) return { scopes, scores: {} };
    const diffusion = this.evidenceToDecision.diffuseGraph({
      seedIds: ['thread:current'],
      edges: scopes.map((scope) => ({
        from: 'thread:current',
        to: `scope:${scope.topicSlug}`,
        weight: scope.weight,
        relation: scope.relation === 'cross_project' ? 'cross_project' : 'same_project',
      })),
      mode: 'ppr',
      iterations: 6,
    });
    return {
      scopes: scopes.map((scope) => {
        const diffusionScore = diffusion.scores[`scope:${scope.topicSlug}`] ?? 0;
        const dampening = scope.relation === 'cross_project' ? 0.85 : 1;
        return { ...scope, weight: Number((scope.weight * (1 + diffusionScore) * dampening).toFixed(4)) };
      }),
      scores: diffusion.scores,
    };
  }

  private diffusionRankHits(hits: ConsultingGraphRagHit[], scopeScores: Record<string, number>): ConsultingGraphRagHit[] {
    return [...hits].sort((a, b) => this.diffusionHitScore(b, scopeScores) - this.diffusionHitScore(a, scopeScores));
  }

  private diffusionHitScore(hit: ConsultingGraphRagHit, scopeScores: Record<string, number>): number {
    const base = hit.rerankScore ?? hit.fusedScore ?? hit.score ?? 0;
    const scopeScore = hit.sourceTopicSlug ? (scopeScores[`scope:${hit.sourceTopicSlug}`] ?? 0) : 0;
    const sameScopeBoost = hit.sourceRelation === 'current' || hit.sourceRelation === 'same_project' ? 0.04 : 0;
    const crossPenalty = hit.sourceRelation === 'cross_project' ? 0.03 : 0;
    return base + scopeScore * 0.25 + sameScopeBoost - crossPenalty;
  }

  private claimsFromHits(query: string, hits: ConsultingGraphRagHit[]): ClaimInput[] {
    const byId = new Map<string, ClaimInput>();
    hits.forEach((hit, index) => {
      const linkedClaims = hit.linked.filter((link) => /^claim:/iu.test(link));
      const ids = linkedClaims.length > 0 ? linkedClaims : [`query-claim-${index + 1}`];
      ids.forEach((id) => {
        if (byId.has(id)) return;
        const scopeImpact = hit.sourceRelation === 'cross_project' ? 0.55 : 0.75;
        byId.set(id, { id, text: linkedClaims.length > 0 ? `${id} ${this.compact(hit.text).slice(0, 260)}` : `${query} ${this.compact(hit.text).slice(0, 180)}`, decisionImpact: scopeImpact });
      });
    });
    if (byId.size === 0 && query.trim().length > 0) byId.set('query', { id: 'query', text: query, decisionImpact: 0.5 });
    return [...byId.values()].slice(0, 8);
  }

  private evidenceFromHits(hits: ConsultingGraphRagHit[]): EvidenceInput[] {
    return hits.map((hit, index) => ({
      id: `hit-${index + 1}`,
      text: hit.text,
      qualityScore: this.hitQualityScore(hit),
      linkedClaimIds: hit.linked.filter((link) => /^claim:/iu.test(link)),
    }));
  }

  private graphEdgesFromHits(hits: ConsultingGraphRagHit[]): GraphEdgeInput[] {
    const edges: GraphEdgeInput[] = [];
    hits.forEach((hit, index) => {
      const relation = hit.sourceRelation === 'cross_project' ? 'cross_project' : 'same_project';
      const sourceNode = `${hit.sourceRelation ?? 'current'}:${hit.sourceTopicSlug ?? hit.docTitle ?? index + 1}`;
      edges.push({ from: 'thread:current', to: sourceNode, weight: hit.sourceWeight ?? hit.score ?? 0.5, relation });
      const path = (hit.graphPath && hit.graphPath.length > 0 ? hit.graphPath : hit.linked).slice(0, 6);
      for (let i = 0; i < path.length - 1; i += 1) {
        const from = path[i];
        const to = path[i + 1];
        if (from && to) edges.push({ from, to, weight: 0.7, relation: 'same_project' });
      }
    });
    return edges;
  }

  private reviewItemsFromDecision(decision: EvidenceSufficiencyDecision, riskyClaimCount: number) {
    const items = [];
    if (decision.status !== 'sufficient') {
      items.push({
        id: `crag-${decision.status}`,
        kind: 'evidence_gap',
        title: `CRAG ${decision.status}`,
        decisionImpact: decision.status === 'insufficient' ? 0.85 : 0.65,
        uncertainty: decision.status === 'insufficient' ? 0.9 : 0.7,
        evidenceGap: decision.status === 'insufficient' ? 1 : 0.65,
      });
    }
    if (riskyClaimCount > 0) {
      items.push({
        id: 'claim-verdict-risk',
        kind: 'claim',
        title: `검증 필요 claim ${riskyClaimCount}건`,
        decisionImpact: 0.75,
        uncertainty: 0.75,
        evidenceGap: Math.min(1, riskyClaimCount / 3),
      });
    }
    return items;
  }

  private hitQualityScore(hit: ConsultingGraphRagHit): number {
    const score = hit.rerankScore ?? hit.score ?? 0.5;
    return Math.max(0, Math.min(100, Math.round(score * 100)));
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
