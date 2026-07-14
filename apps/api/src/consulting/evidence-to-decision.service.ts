import { Injectable } from '@nestjs/common';

export type ClaimVerdictKind = 'supports' | 'refutes' | 'not_enough_info' | 'mixed';
export type DecisionAction = 'recommend' | 'collect_more_evidence' | 'defer';
export type TemporalValue = string | Date;
export type ProvenanceEdgeType = 'SUPPORTS' | 'REFUTES' | 'QUALIFIES' | 'DEPENDS_ON' | 'ASSUMES' | 'DERIVED_FROM' | 'SUPERSEDES' | 'STALE_AFTER';

export interface ClaimInput {
  id: string;
  text: string;
  decisionImpact?: number;
}

export interface VerifierTrace {
  provider: string;
  model: string;
  label?: string;
  latencyMs: number;
  source: 'heuristic' | 'nli' | 'llm';
}

export interface VerificationMetrics {
  totalLatencyMs: number;
  providerCalls: { nli: number; llm: number; heuristic: number };
  providerLatencies: Record<string, number>;
}

export interface EvidenceInput {
  id: string;
  text: string;
  qualityScore?: number;
  linkedClaimIds?: string[];
  validFrom?: TemporalValue;
  validTo?: TemporalValue;
  observedAt?: TemporalValue;
  publishedAt?: TemporalValue;
  collectedAt?: TemporalValue;
  supersededBy?: string;
}

export interface ProvenanceGraphEdge {
  sourceRef: string;
  targetRef: string;
  edgeType: ProvenanceEdgeType;
  confidence: number;
  evidenceRefs: string[];
  validFrom: string | null;
  validTo: string | null;
  observedAt: string | null;
  publishedAt: string | null;
  collectedAt: string | null;
  supersededBy: string | null;
  rationale: string;
  metadata: Record<string, unknown>;
}

export interface ProvenanceGraphResult {
  edges: ProvenanceGraphEdge[];
  reviewItems: ReviewInput[];
}

export interface TemporalEvidenceSelection {
  active: EvidenceInput[];
  stale: EvidenceInput[];
  superseded: EvidenceInput[];
  future: EvidenceInput[];
  timeline: EvidenceInput[];
}

export interface ClaimVerdict {
  claimId: string;
  claimText: string;
  evidenceId: string | null;
  counterEvidenceId?: string | null;
  verdict: ClaimVerdictKind;
  confidence: number;
  matchedTerms: string[];
  contradictedTerms: string[];
  rationale: string;
  decisionImpact: number;
  verifierTrace?: VerifierTrace;
}

export interface ClaimVerificationLattice {
  verdicts: ClaimVerdict[];
  verdictsByClaim: Record<string, ClaimVerdict>;
  summary: { supports: number; refutes: number; mixed: number; notEnoughInfo: number; claimCount: number };
}

export interface StrictJsonVerificationResult {
  verifier: string;
  lattice: ClaimVerificationLattice;
  metrics: VerificationMetrics;
  strictJson: {
    verdicts: Array<{
      claim_id: string;
      verdict: ClaimVerdictKind;
      confidence: number;
      evidence_id: string | null;
      counter_evidence_id?: string | null;
      rationale: string;
    }>;
  };
}

export interface ArtifactDependency {
  id: string;
  kind: string;
  title: string;
  claimIds: string[];
}

export interface TruthMaintenanceItem {
  reason: string;
  affectedClaimIds: string[];
  affectedArtifactIds: string[];
  priorityScore: number;
  requiredAction: 'recheck_claims_and_artifacts';
}

export interface DecisionAlternative {
  id: string;
  label: string;
}

export interface DecisionCriterion {
  id: string;
  label: string;
  weight: number;
  direction?: 'higher_is_better' | 'lower_is_better';
}

export interface DecisionRating {
  alternativeId: string;
  criterionId: string;
  score: number;
  uncertainty?: number;
  evidenceIds?: string[];
}

export interface DecisionScorecardItem {
  alternativeId: string;
  label: string;
  weightedScore: number;
  uncertainty: number;
  evidenceCoverage: number;
  requiredAction: DecisionAction;
  criteriaBreakdown: Array<{
    criterionId: string;
    label: string;
    normalizedWeight: number;
    direction: 'higher_is_better' | 'lower_is_better';
    score: number;
    adjustedScore: number;
    uncertainty: number;
    evidenceIds: string[];
  }>;
}

export interface DecisionScorecard {
  question: string;
  recommendedAlternativeId: string | null;
  ranked: DecisionScorecardItem[];
  normalizedCriteria: Array<DecisionCriterion & { normalizedWeight: number }>;
}

export interface GraphEdgeInput {
  from: string;
  to: string;
  weight?: number;
  relation?: 'same_project' | 'cross_project';
}

export interface DiffuseGraphResult {
  method: 'ppr_no_dep' | 'heat_kernel_no_dep';
  seedIds: string[];
  scores: Record<string, number>;
  ranked: Array<{ id: string; score: number }>;
}

export interface DocumentInput {
  id: string;
  title: string;
  text: string;
  qualityScore?: number;
}

export interface DocumentRetrievalUnit {
  documentId: string;
  modality: 'text' | 'table' | 'page_visual';
  locator: string;
  text: string;
  scorePrior: number;
  metadata: Record<string, unknown>;
}

export interface ReviewInput {
  id: string;
  kind: string;
  title: string;
  decisionImpact: number;
  uncertainty: number;
  evidenceGap: number;
  dueAt?: Date;
}

export interface PrioritizedReviewItem extends ReviewInput {
  deadlineWeight: number;
  priorityScore: number;
  reasons: string[];
}

const STOP_TERMS = new Set([
  '근거', '자료', '판단', '기준', '핵심', '대한', '한다', '된다', '있다', '없다', '그리고', '또는',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into',
]);
const SUFFIX_RE = /(입니다|이었다|했다|한다|하는|하다|에서|으로|부터|까지|에게|보다|처럼|이며|이고|이나|거나|과|와|을|를|은|는|이|가|의|에|도|만|로)$/u;
const CONTRADICTION_PAIRS: Array<[string, string]> = [
  ['증가', '감소'],
  ['늘', '줄'],
  ['상승', '하락'],
  ['확대', '축소'],
  ['필요', '불필요'],
  ['가능', '불가능'],
  ['유지', '폐지'],
  ['찬성', '반대'],
  ['supports', 'refutes'],
  ['increase', 'decrease'],
  ['higher', 'lower'],
  ['yes', 'no'],
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[가-힣A-Za-z0-9]{2,}/gu) ?? []) {
    const term = raw.toLowerCase().replace(SUFFIX_RE, '');
    if (term.length < 2 || STOP_TERMS.has(term) || out.includes(term)) continue;
    out.push(term);
  }
  return out;
}

function contradictionTerms(claimTerms: string[], evidenceTerms: string[]): string[] {
  const out: string[] = [];
  for (const [left, right] of CONTRADICTION_PAIRS) {
    const claimHasLeft = claimTerms.some((term) => term.includes(left));
    const claimHasRight = claimTerms.some((term) => term.includes(right));
    const evidenceHasLeft = evidenceTerms.some((term) => term.includes(left));
    const evidenceHasRight = evidenceTerms.some((term) => term.includes(right));
    if (claimHasLeft && evidenceHasRight) out.push(`${left}↔${right}`);
    if (claimHasRight && evidenceHasLeft) out.push(`${right}↔${left}`);
  }
  return [...new Set(out)];
}

function hasNegatingPhrase(text: string): boolean {
  return /(근거는\s*없|아니|불가능|불필요|반대|refute|not\s+supported|no\s+evidence)/iu.test(text);
}

function hasUnsettledPhrase(text: string): boolean {
  return /(결정되지|확정되지|미정|여부|검토\s*중|not\s+decided|pending|unconfirmed)/iu.test(text);
}

function isPrescriptiveClaim(text: string): boolean {
  return /(해야|필요|즉시|확정|권고|must|should|need)/iu.test(text);
}

function normalizeWeights(criteria: DecisionCriterion[]): Array<DecisionCriterion & { normalizedWeight: number }> {
  const total = criteria.reduce((sum, criterion) => sum + Math.max(0, criterion.weight), 0) || 1;
  return criteria.map((criterion) => ({ ...criterion, normalizedWeight: Math.max(0, criterion.weight) / total }));
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}|(?<=다\.)\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function extractMarkdownTables(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const tables: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.includes('|')) {
      current.push(line.trim());
      continue;
    }
    if (current.length >= 2) tables.push(current.join('\n'));
    current = [];
  }
  if (current.length >= 2) tables.push(current.join('\n'));
  return tables;
}

@Injectable()
export class EvidenceToDecisionService {
  buildStrictJsonVerification(input: { claims: ClaimInput[]; evidence: EvidenceInput[] }): StrictJsonVerificationResult {
    const lattice = this.buildClaimVerificationLattice(input);
    return {
      verifier: 'strict_json_local_nli_v1',
      lattice,
      metrics: {
        totalLatencyMs: 0,
        providerCalls: { nli: 0, llm: 0, heuristic: lattice.verdicts.length },
        providerLatencies: { 'heuristic:local_nli': 0 },
      },
      strictJson: {
        verdicts: lattice.verdicts.map((verdict) => ({
          claim_id: verdict.claimId,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          evidence_id: verdict.evidenceId,
          rationale: verdict.rationale,
        })),
      },
    };
  }

  buildClaimVerificationLattice(input: { claims: ClaimInput[]; evidence: EvidenceInput[] }): ClaimVerificationLattice {
    const verdicts = input.claims.map((claim) => this.verdictForClaim(claim, input.evidence));
    const verdictsByClaim = Object.fromEntries(verdicts.map((verdict) => [verdict.claimId, verdict]));
    return {
      verdicts,
      verdictsByClaim,
      summary: {
        supports: verdicts.filter((verdict) => verdict.verdict === 'supports').length,
        refutes: verdicts.filter((verdict) => verdict.verdict === 'refutes').length,
        mixed: verdicts.filter((verdict) => verdict.verdict === 'mixed').length,
        notEnoughInfo: verdicts.filter((verdict) => verdict.verdict === 'not_enough_info').length,
        claimCount: verdicts.length,
      },
    };
  }

  buildTruthMaintenanceQueue(input: {
    changedEvidenceIds: string[];
    verdicts: ClaimVerdict[];
    artifacts: ArtifactDependency[];
  }): TruthMaintenanceItem[] {
    const changed = new Set(input.changedEvidenceIds);
    const affectedVerdicts = input.verdicts.filter((verdict) => verdict.evidenceId !== null && changed.has(verdict.evidenceId));
    const affectedClaimIds = [...new Set(affectedVerdicts.map((verdict) => verdict.claimId))];
    if (affectedClaimIds.length === 0) return [];
    const affectedArtifacts = input.artifacts.filter((artifact) => artifact.claimIds.some((claimId) => affectedClaimIds.includes(claimId)));
    const maxImpact = affectedVerdicts.reduce((max, verdict) => Math.max(max, verdict.decisionImpact), 0);
    const artifactBoost = Math.min(0.3, affectedArtifacts.length * 0.1);
    return input.changedEvidenceIds
      .filter((evidenceId) => affectedVerdicts.some((verdict) => verdict.evidenceId === evidenceId))
      .map((evidenceId) => ({
        reason: `changed_evidence:${evidenceId}`,
        affectedClaimIds,
        affectedArtifactIds: affectedArtifacts.map((artifact) => artifact.id),
        priorityScore: round4(clamp01(maxImpact + artifactBoost)),
        requiredAction: 'recheck_claims_and_artifacts',
      }));
  }

  buildDecisionScorecard(input: {
    question: string;
    alternatives: DecisionAlternative[];
    criteria: DecisionCriterion[];
    ratings: DecisionRating[];
  }): DecisionScorecard {
    const criteria = normalizeWeights(input.criteria);
    const ranked = input.alternatives.map((alternative) => {
      const breakdown = criteria.map((criterion) => {
        const rating = input.ratings.find((item) => item.alternativeId === alternative.id && item.criterionId === criterion.id);
        const rawScore = clamp01(rating?.score ?? 0);
        const directionalScore = criterion.direction === 'lower_is_better' ? 1 - rawScore : rawScore;
        const uncertainty = clamp01(rating?.uncertainty ?? 0.5);
        const adjustedScore = directionalScore * criterion.normalizedWeight * (1 - uncertainty * 0.35);
        return {
          criterionId: criterion.id,
          label: criterion.label,
          normalizedWeight: round4(criterion.normalizedWeight),
          direction: criterion.direction ?? 'higher_is_better',
          score: round4(rawScore),
          adjustedScore: round4(adjustedScore),
          uncertainty: round4(uncertainty),
          evidenceIds: rating?.evidenceIds ?? [],
        };
      });
      const weightedScore = round4(breakdown.reduce((sum, item) => sum + item.adjustedScore, 0));
      const uncertainty = round4(breakdown.reduce((sum, item) => sum + item.uncertainty, 0) / Math.max(1, breakdown.length));
      const evidenceCoverage = round4(breakdown.filter((item) => item.evidenceIds.length > 0).length / Math.max(1, breakdown.length));
      const requiredAction: DecisionAction = evidenceCoverage < 0.8 || uncertainty > 0.45 ? 'collect_more_evidence' : 'recommend';
      return { alternativeId: alternative.id, label: alternative.label, weightedScore, uncertainty, evidenceCoverage, requiredAction, criteriaBreakdown: breakdown };
    }).sort((a, b) => b.weightedScore - a.weightedScore || b.evidenceCoverage - a.evidenceCoverage);

    return {
      question: input.question,
      recommendedAlternativeId: ranked[0]?.requiredAction === 'recommend' ? ranked[0].alternativeId : null,
      ranked,
      normalizedCriteria: criteria.map((criterion) => ({ ...criterion, normalizedWeight: round4(criterion.normalizedWeight) })),
    };
  }

  buildProvenanceGraph(input: {
    verdicts: ClaimVerdict[];
    evidence: EvidenceInput[];
    asOf?: Date;
  }): ProvenanceGraphResult {
    const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
    const edges: ProvenanceGraphEdge[] = [];
    for (const verdict of input.verdicts) {
      if (!verdict.evidenceId) continue;
      const evidence = evidenceById.get(verdict.evidenceId);
      const edgeType = this.edgeTypeForVerdict(verdict.verdict);
      edges.push({
        sourceRef: `evidence:${verdict.evidenceId}`,
        targetRef: `claim:${verdict.claimId}`,
        edgeType,
        confidence: verdict.confidence,
        evidenceRefs: [verdict.evidenceId],
        validFrom: this.temporalIso(evidence?.validFrom),
        validTo: this.temporalIso(evidence?.validTo),
        observedAt: this.temporalIso(evidence?.observedAt),
        publishedAt: this.temporalIso(evidence?.publishedAt),
        collectedAt: this.temporalIso(evidence?.collectedAt),
        supersededBy: evidence?.supersededBy ? `evidence:${evidence.supersededBy}` : null,
        rationale: verdict.rationale,
        metadata: {
          claimText: verdict.claimText,
          verdict: verdict.verdict,
          matchedTerms: verdict.matchedTerms,
          contradictedTerms: verdict.contradictedTerms,
          asOf: input.asOf?.toISOString() ?? null,
        },
      });
      if (evidence?.supersededBy) {
        edges.push({
          sourceRef: `evidence:${verdict.evidenceId}`,
          targetRef: `evidence:${evidence.supersededBy}`,
          edgeType: 'SUPERSEDES',
          confidence: 1,
          evidenceRefs: [verdict.evidenceId, evidence.supersededBy],
          validFrom: this.temporalIso(evidence.validFrom),
          validTo: this.temporalIso(evidence.validTo),
          observedAt: this.temporalIso(evidence.observedAt),
          publishedAt: this.temporalIso(evidence.publishedAt),
          collectedAt: this.temporalIso(evidence.collectedAt),
          supersededBy: `evidence:${evidence.supersededBy}`,
          rationale: `superseded_by:${evidence.supersededBy}`,
          metadata: { source: 'temporal_validity' },
        });
      }
    }

    const byClaim = new Map<string, ClaimVerdict[]>();
    for (const verdict of input.verdicts) byClaim.set(verdict.claimId, [...(byClaim.get(verdict.claimId) ?? []), verdict]);
    const reviewItems: ReviewInput[] = [];
    for (const [claimId, verdicts] of byClaim.entries()) {
      const hasSupport = verdicts.some((verdict) => verdict.verdict === 'supports');
      const hasCounter = verdicts.some((verdict) => verdict.verdict === 'refutes' || verdict.verdict === 'mixed');
      if (!hasSupport || !hasCounter) continue;
      const representative = verdicts[0]!;
      const maxImpact = verdicts.reduce((max, verdict) => Math.max(max, verdict.decisionImpact), 0);
      const avgConfidence = verdicts.reduce((sum, verdict) => sum + verdict.confidence, 0) / Math.max(1, verdicts.length);
      reviewItems.push({
        id: `contradiction:${claimId}`,
        kind: 'contradiction',
        title: `근거가 갈리는 쟁점: ${representative.claimText.slice(0, 90)}`,
        decisionImpact: clamp01(maxImpact),
        uncertainty: round4(clamp01(1 - avgConfidence + 0.25)),
        evidenceGap: 0.75,
      });
    }

    return { edges, reviewItems: this.prioritizeReviewQueue({ items: reviewItems }) };
  }

  selectTemporallyValidEvidence(input: { evidence: EvidenceInput[]; asOf: Date }): TemporalEvidenceSelection {
    const active: EvidenceInput[] = [];
    const stale: EvidenceInput[] = [];
    const superseded: EvidenceInput[] = [];
    const future: EvidenceInput[] = [];
    const asOf = input.asOf.getTime();
    for (const item of input.evidence) {
      const validFrom = this.temporalMillis(item.validFrom);
      const validTo = this.temporalMillis(item.validTo);
      if (item.supersededBy) {
        superseded.push(item);
      } else if (validFrom !== null && validFrom > asOf) {
        future.push(item);
      } else if (validTo !== null && validTo < asOf) {
        stale.push(item);
      } else {
        active.push(item);
      }
    }
    const byValidFromDesc = (a: EvidenceInput, b: EvidenceInput) => (this.temporalMillis(b.validFrom) ?? 0) - (this.temporalMillis(a.validFrom) ?? 0)
      || (this.temporalMillis(b.observedAt) ?? this.temporalMillis(b.publishedAt) ?? 0) - (this.temporalMillis(a.observedAt) ?? this.temporalMillis(a.publishedAt) ?? 0)
      || a.id.localeCompare(b.id);
    active.sort(byValidFromDesc);
    stale.sort(byValidFromDesc);
    superseded.sort(byValidFromDesc);
    future.sort(byValidFromDesc);
    return { active, stale, superseded, future, timeline: [...active, ...stale, ...superseded, ...future] };
  }

  diffuseGraph(input: {
    seedIds: string[];
    edges: GraphEdgeInput[];
    mode?: 'ppr' | 'heat';
    iterations?: number;
    alpha?: number;
  }): DiffuseGraphResult {
    const seedIds = [...new Set(input.seedIds)];
    const nodes = [...new Set([...seedIds, ...input.edges.flatMap((edge) => [edge.from, edge.to])])];
    const adjacency = new Map<string, Array<{ to: string; weight: number }>>();
    for (const edge of input.edges) {
      const dampened = (edge.weight ?? 1) * (edge.relation === 'cross_project' ? 0.6 : 1);
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), { to: edge.to, weight: Math.max(0, dampened) }]);
      adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), { to: edge.from, weight: Math.max(0, dampened) }]);
    }

    const seedMass = seedIds.length > 0 ? 1 / seedIds.length : 0;
    let scores = Object.fromEntries(nodes.map((node) => [node, seedIds.includes(node) ? seedMass : 0]));
    const iterations = Math.max(1, Math.min(input.iterations ?? 10, 50));
    if (input.mode === 'heat') {
      for (let i = 0; i < iterations; i += 1) scores = this.heatStep(scores, adjacency, seedIds, seedMass);
      return this.diffusionResult('heat_kernel_no_dep', seedIds, scores);
    }

    const alpha = clamp01(input.alpha ?? 0.15);
    for (let i = 0; i < iterations; i += 1) scores = this.pprStep(scores, adjacency, nodes, seedIds, seedMass, alpha);
    return this.diffusionResult('ppr_no_dep', seedIds, scores);
  }

  buildDocumentRetrievalUnits(input: { documents: DocumentInput[] }): DocumentRetrievalUnit[] {
    const units: DocumentRetrievalUnit[] = [];
    for (const doc of input.documents) {
      const tables = extractMarkdownTables(doc.text);
      tables.forEach((table, index) => {
        units.push({
          documentId: doc.id,
          modality: 'table',
          locator: `${doc.title}#table-${index + 1}`,
          text: table,
          scorePrior: round4(0.7 + clamp01((doc.qualityScore ?? 50) / 100) * 0.25),
          metadata: { title: doc.title, tableIndex: index + 1, pilot: 'markdown_table_v1' },
        });
      });

      splitParagraphs(doc.text.replace(/\|[^\n]+\|/g, ' ')).slice(0, 8).forEach((part, index) => {
        if (part.length < 8) return;
        units.push({
          documentId: doc.id,
          modality: 'text',
          locator: `${doc.title}#text-${index + 1}`,
          text: part,
          scorePrior: round4(0.45 + clamp01((doc.qualityScore ?? 50) / 100) * 0.25),
          metadata: { title: doc.title, paragraphIndex: index + 1, pilot: 'text_block_v1' },
        });
      });

      if (/\.pdf$/iu.test(doc.title)) {
        units.push({
          documentId: doc.id,
          modality: 'page_visual',
          locator: `${doc.title}#page-unknown`,
          text: `visual-layout-placeholder: ${doc.title}`,
          scorePrior: round4(0.35 + clamp01((doc.qualityScore ?? 50) / 100) * 0.1),
          metadata: { title: doc.title, pilot: 'colpali_ready_placeholder', needsImageEmbedding: true },
        });
      }
    }
    return units.sort((a, b) => b.scorePrior - a.scorePrior || a.locator.localeCompare(b.locator));
  }

  prioritizeReviewQueue(input: { items: ReviewInput[]; now?: Date }): PrioritizedReviewItem[] {
    const now = input.now ?? new Date();
    return input.items.map((item) => {
      const deadlineWeight = this.deadlineWeight(item.dueAt, now);
      const priorityScore = round4(clamp01(item.decisionImpact) * clamp01(item.uncertainty) * clamp01(item.evidenceGap) * deadlineWeight);
      const reasons = [
        `impact=${round4(clamp01(item.decisionImpact))}`,
        `uncertainty=${round4(clamp01(item.uncertainty))}`,
        `evidence_gap=${round4(clamp01(item.evidenceGap))}`,
      ];
      if (deadlineWeight > 1) reasons.push(`deadline_weight=${round4(deadlineWeight)}`);
      return { ...item, deadlineWeight: round4(deadlineWeight), priorityScore, reasons };
    }).sort((a, b) => b.priorityScore - a.priorityScore || a.title.localeCompare(b.title));
  }

  private verdictForClaim(claim: ClaimInput, evidence: EvidenceInput[]): ClaimVerdict {
    const claimTerms = terms(claim.text);
    let best: ClaimVerdict | null = null;
    for (const item of evidence) {
      const evidenceTerms = terms(item.text);
      const matchedTerms = claimTerms.filter((term) => evidenceTerms.some((candidate) => candidate.includes(term) || term.includes(candidate)));
      const contradictedTerms = contradictionTerms(claimTerms, evidenceTerms);
      const linkedBoost = item.linkedClaimIds?.includes(claim.id) ? 0.2 : 0;
      const qualityBoost = clamp01((item.qualityScore ?? 50) / 100) * 0.15;
      const overlapScore = matchedTerms.length / Math.max(1, Math.min(claimTerms.length, 6));
      const refuteScore = contradictedTerms.length > 0 ? Math.max(0.55, overlapScore + 0.25) : (hasNegatingPhrase(item.text) && overlapScore >= 0.35 ? overlapScore + 0.2 : 0);
      const unsettledPenalty = hasUnsettledPhrase(item.text) && isPrescriptiveClaim(claim.text);
      const supportScore = unsettledPenalty ? Math.min(0.45, overlapScore + linkedBoost + qualityBoost) : overlapScore + linkedBoost + qualityBoost;
      const verdict = this.classifyVerdict(supportScore, refuteScore);
      const confidence = round4(clamp01(Math.max(supportScore, refuteScore)));
      const candidate: ClaimVerdict = {
        claimId: claim.id,
        claimText: claim.text,
        evidenceId: item.id,
        verdict,
        confidence,
        matchedTerms,
        contradictedTerms,
        rationale: `${verdict}; overlap=${round4(overlapScore)}; quality=${item.qualityScore ?? 'n/a'}; evidence=${item.id}`,
        decisionImpact: clamp01(claim.decisionImpact ?? 0.5),
        verifierTrace: { provider: 'local_nli', model: 'term-overlap-contradiction-v1', label: verdict, latencyMs: 0, source: 'heuristic' },
      };
      if (!best || this.verdictRank(candidate) > this.verdictRank(best)) best = candidate;
    }
    if (!best || best.verdict === 'not_enough_info') {
      return {
        claimId: claim.id,
        claimText: claim.text,
        evidenceId: best?.evidenceId ?? null,
        verdict: 'not_enough_info',
        confidence: best?.confidence ?? 0,
        matchedTerms: best?.matchedTerms ?? [],
        contradictedTerms: best?.contradictedTerms ?? [],
        rationale: best ? `not_enough_info; best=${best.rationale}` : 'not_enough_info; no evidence',
        decisionImpact: clamp01(claim.decisionImpact ?? 0.5),
        verifierTrace: best?.verifierTrace ?? { provider: 'local_nli', model: 'term-overlap-contradiction-v1', label: 'not_enough_info', latencyMs: 0, source: 'heuristic' },
      };
    }
    return best;
  }

  private classifyVerdict(supportScore: number, refuteScore: number): ClaimVerdictKind {
    if (refuteScore >= 0.55 && refuteScore >= supportScore - 0.05) return 'refutes';
    if (supportScore >= 0.55 && refuteScore >= 0.55) return 'mixed';
    if (supportScore >= 0.55) return 'supports';
    return 'not_enough_info';
  }

  private verdictRank(verdict: ClaimVerdict): number {
    const tieBreak = verdict.verdict === 'mixed' ? 0.04 : verdict.verdict === 'refutes' ? 0.03 : verdict.verdict === 'supports' ? 0.02 : 0.01;
    return verdict.confidence + tieBreak;
  }

  private pprStep(
    scores: Record<string, number>,
    adjacency: Map<string, Array<{ to: string; weight: number }>>,
    nodes: string[],
    seedIds: string[],
    seedMass: number,
    alpha: number,
  ): Record<string, number> {
    const next = Object.fromEntries(nodes.map((node) => [node, seedIds.includes(node) ? alpha * seedMass : 0]));
    for (const node of nodes) {
      const neighbors = adjacency.get(node) ?? [];
      const total = neighbors.reduce((sum, edge) => sum + edge.weight, 0);
      if (total <= 0) continue;
      for (const edge of neighbors) next[edge.to] = (next[edge.to] ?? 0) + (1 - alpha) * (scores[node] ?? 0) * (edge.weight / total);
    }
    return next;
  }

  private heatStep(
    scores: Record<string, number>,
    adjacency: Map<string, Array<{ to: string; weight: number }>>,
    seedIds: string[],
    seedMass: number,
  ): Record<string, number> {
    const next = { ...scores };
    for (const [node, neighbors] of adjacency.entries()) {
      const total = neighbors.reduce((sum, edge) => sum + edge.weight, 0);
      if (total <= 0) continue;
      const localAverage = neighbors.reduce((sum, edge) => sum + (scores[edge.to] ?? 0) * (edge.weight / total), 0);
      next[node] = 0.55 * (scores[node] ?? 0) + 0.45 * localAverage;
    }
    for (const seedId of seedIds) next[seedId] = (next[seedId] ?? 0) + 0.1 * seedMass;
    return next;
  }

  private diffusionResult(method: DiffuseGraphResult['method'], seedIds: string[], rawScores: Record<string, number>): DiffuseGraphResult {
    const total = Object.values(rawScores).reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
    const scores = Object.fromEntries(Object.entries(rawScores).map(([id, score]) => [id, round4(Math.max(0, score) / total)]));
    const ranked = Object.entries(scores).map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { method, seedIds, scores, ranked };
  }

  private edgeTypeForVerdict(verdict: ClaimVerdictKind): ProvenanceEdgeType {
    if (verdict === 'supports') return 'SUPPORTS';
    if (verdict === 'refutes') return 'REFUTES';
    if (verdict === 'mixed') return 'QUALIFIES';
    return 'QUALIFIES';
  }

  private temporalIso(value: TemporalValue | undefined): string | null {
    const millis = this.temporalMillis(value);
    return millis === null ? null : new Date(millis).toISOString();
  }

  private temporalMillis(value: TemporalValue | undefined): number | null {
    if (value === undefined) return null;
    const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(millis) ? millis : null;
  }

  private deadlineWeight(dueAt: Date | undefined, now: Date): number {
    if (!dueAt) return 1;
    const hours = (dueAt.getTime() - now.getTime()) / 3_600_000;
    if (hours <= 0) return 1.8;
    if (hours <= 6) return 1.5;
    if (hours <= 24) return 1.25;
    return 1.05;
  }
}
