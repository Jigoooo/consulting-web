import { Injectable } from '@nestjs/common';
import type { ConsultingGraphRagHit } from './consulting-graphrag-bridge.service.js';

export type ConsultingJudgmentGuardIssueCode =
  | 'source_intake_parse_failure'
  | 'stale_source_warning'
  | 'applicability_map_required'
  | 'decision_gate_order_required'
  | 'latest_authority_required'
  | 'comparator_consistency_required'
  | 'counterargument_required'
  | 'user_correction_pattern'
  | 'overclaim_strength_risk';

export interface ConsultingJudgmentGuardIssue {
  code: ConsultingJudgmentGuardIssueCode;
  severity: 'warning' | 'blocker';
  message: string;
  requiredAction: string;
}

export interface ConsultingJudgmentGuardResult {
  required: boolean;
  issues: ConsultingJudgmentGuardIssue[];
  issueSummary: string;
  promptRules: string[];
  currentTimeIso: string;
}

const USER_CORRECTION_RE = /(이거\s*아니|아니야|틀렸|잘못|지적|반복|다시\s*봐|반박|왜\s*.*아니)/iu;
const POLICY_RE = /(법령|규정|지침|예산편성|공기업|공단|공무원|근로자|통상임금|총인건비|수당|노무|판례|고용노동부)/iu;
const APPLICABILITY_RE = /(공무원|공단|공사|직영기업|근로자|지방공기업|준용|직접\s*적용|별표\s*9)/iu;
const GATE_ORDER_RE = /(게이트|선행|후행|통상임금|총인건비|AND|OR|단락|short.?circuit|불필요)/iu;
const LATEST_AUTHORITY_RE = /(최신|고용노동부|판례|지침|예규|고시|법령|노사지도|202[4-9])/iu;
const COMPARATOR_RE = /(유사기관|벤치마킹|비교기관|타\s*기관|사례|다수|소수|전무)/iu;
const OVERCLAIM_RE = /(불가|금지|확정|반드시|무조건|직접\s*금지|할\s*수\s*없|해야\s*한다)/iu;
const TIME_SENSITIVE_SOURCE_RE = /(호봉표|봉급표|보수표|급여표|임금표|법령|조례|규정|지침|고시|예규|판례|조직도|정원표|인력현황)/iu;
const NUMERIC_EVIDENCE_RE = /\d[\d,.]*\s*(?:원|명|%|퍼센트|호봉|급|년|개월|일|건|개)/iu;
const SOURCE_DATE_RE = /(?:^|[^\d])(?:19|20)\d{2}(?:\s*년|[./-]\d{1,2}|(?=\s|_|-))|기준일|시행일|개정일|공포일|기준\s*[:：]|as\s+of|effective[_\s-]?date/iu;
const LOW_TEXT_THRESHOLD = 80;

function uniqueIssues(issues: ConsultingJudgmentGuardIssue[]): ConsultingJudgmentGuardIssue[] {
  const seen = new Set<ConsultingJudgmentGuardIssueCode>();
  const out: ConsultingJudgmentGuardIssue[] = [];
  for (const issue of issues) {
    if (seen.has(issue.code)) continue;
    seen.add(issue.code);
    out.push(issue);
  }
  return out;
}

function allText(query: string, hits: ConsultingGraphRagHit[], userFeedback?: string): string {
  return [query, userFeedback ?? '', ...hits.map((hit) => `${hit.docTitle ?? ''} ${hit.utilityTier ?? ''} ${hit.text}`)].join('\n');
}

@Injectable()
export class ConsultingJudgmentGuardService {
  evaluate(input: { query: string; hits: ConsultingGraphRagHit[]; userFeedback?: string; now?: Date }): ConsultingJudgmentGuardResult {
    const text = allText(input.query, input.hits, input.userFeedback);
    const issues: ConsultingJudgmentGuardIssue[] = [];
    const lowTextHit = input.hits.find((hit) => (hit.text ?? '').trim().length < LOW_TEXT_THRESHOLD && /pdf|스캔|scan|image|ocr/iu.test(`${hit.docTitle ?? ''} ${hit.kind}`));
    if (lowTextHit) {
      issues.push({
        code: 'source_intake_parse_failure',
        severity: 'blocker',
        message: `문서 ${lowTextHit.docTitle ?? lowTextHit.kind}의 추출 텍스트가 너무 짧아 OCR/원문 재확인이 필요합니다.`,
        requiredAction: '빈/저품질 추출은 근거 부재가 아니라 파싱 실패로 표시하고 OCR 또는 multimodal extraction을 요구한다.',
      });
    }

    const undatedTimeSensitiveHit = input.hits.find((hit) => {
      const sourceText = `${hit.docTitle ?? ''}\n${hit.text ?? ''}`;
      return TIME_SENSITIVE_SOURCE_RE.test(sourceText)
        && NUMERIC_EVIDENCE_RE.test(sourceText)
        && !SOURCE_DATE_RE.test(sourceText);
    });
    if (undatedTimeSensitiveHit) {
      issues.push({
        code: 'stale_source_warning',
        severity: 'warning',
        message: `시간민감 자료 ${undatedTimeSensitiveHit.docTitle ?? undatedTimeSensitiveHit.kind}에 기준일/effective date가 없습니다.`,
        requiredAction: '호봉표·법령·조직도 등 수치 근거는 기준일/시행일을 확인하고, 확인 전에는 현재값으로 단정하지 않는다.',
      });
    }

    if (POLICY_RE.test(text) && APPLICABILITY_RE.test(text)) {
      issues.push({
        code: 'applicability_map_required',
        severity: 'warning',
        message: '규정 적용대상과 적용성격을 분리해야 합니다.',
        requiredAction: '각 근거를 directly_applicable / analogical / background_only로 라벨링하고 대상 엔티티를 명시한다.',
      });
    }

    if (GATE_ORDER_RE.test(text)) {
      issues.push({
        code: 'decision_gate_order_required',
        severity: 'warning',
        message: '선행/후행 판단 게이트 순서를 구조화해야 합니다.',
        requiredAction: 'AND/OR/short-circuit 구조를 먼저 만들고, 실패한 선행 게이트 뒤의 판단은 보조/불필요로 표시한다.',
      });
    }

    if (POLICY_RE.test(text) && LATEST_AUTHORITY_RE.test(text)) {
      issues.push({
        code: 'latest_authority_required',
        severity: 'warning',
        message: '최신 공식 권위자료 확인이 필요한 사안입니다.',
        requiredAction: '공식 지침/법령/최신 판례 우선순위를 확인하고 오래된 해설이나 기억만으로 단정하지 않는다.',
      });
    }

    if (COMPARATOR_RE.test(text)) {
      issues.push({
        code: 'comparator_consistency_required',
        severity: 'warning',
        message: '벤치마킹/유사기관 사용 방향을 항목별로 다르게 적용할 위험이 있습니다.',
        requiredAction: '다수/소수/전무/명칭차이의 가중치 방향을 하나로 정하고 모든 항목에 동일하게 적용한다.',
      });
    }

    if (POLICY_RE.test(text) || OVERCLAIM_RE.test(text)) {
      issues.push({
        code: 'counterargument_required',
        severity: 'warning',
        message: '강한 결론 전 반대측의 가장 강한 반박을 먼저 통과해야 합니다.',
        requiredAction: '노조/감사/고객 반대신문 3개를 작성하고, 한 개가 핵심 논리를 무너뜨리면 결론 강도를 낮춘다.',
      });
    }

    if (USER_CORRECTION_RE.test(`${input.query}\n${input.userFeedback ?? ''}`)) {
      issues.push({
        code: 'user_correction_pattern',
        severity: 'warning',
        message: '사용자 재지적/수정 신호가 감지되었습니다.',
        requiredAction: '이번 지적을 실패유형으로 분류하고 다음 답변의 적용성/게이트/결론강도 규칙에 즉시 반영한다.',
      });
    }

    if (OVERCLAIM_RE.test(text)) {
      issues.push({
        code: 'overclaim_strength_risk',
        severity: 'warning',
        message: '불가/금지/확정 같은 강한 표현이 직접 근거 없이 사용될 위험이 있습니다.',
        requiredAction: '직접적용 근거가 없으면 불가/금지가 아니라 원안 부적정/조건부/재설계 필요로 낮춘다.',
      });
    }

    const deduped = uniqueIssues(issues);
    return {
      required: deduped.length > 0,
      issues: deduped,
      issueSummary: deduped.map((issue) => `${issue.code}:${issue.severity}`).join(', ') || 'none',
      promptRules: this.promptRules(),
      currentTimeIso: (input.now ?? new Date()).toISOString(),
    };
  }

  renderPromptContract(result: ConsultingJudgmentGuardResult): string {
    const lines = [
      '### 컨설팅 판단 안전 게이트 v1',
      `- runtime_current_time: ${result.currentTimeIso}`,
      '- 최신/현재 판단은 모델 기억 날짜가 아니라 위 runtime_current_time을 기준으로 한다.',
      '- RAG 검색 hit는 “자료 후보”일 뿐이며, 결론 전에 적용성·게이트 순서·결론 강도를 별도 판단한다.',
      '- Source intake: 빈/저품질 PDF 추출은 근거 부재가 아니라 파싱 실패로 보고 OCR/원문 확인을 요구한다.',
      '- Source freshness: 호봉표·법령·조직도 등 시간민감 수치 근거는 기준일/시행일이 없으면 현재값으로 단정하지 않는다.',
      '- Applicability map: 모든 결정적 근거를 directly_applicable / analogical / background_only 중 하나로 라벨링한다.',
      '- Decision graph: AND/OR/short-circuit 순서를 먼저 세우고, 선행 게이트 실패 시 후행 계산/비교는 보조로만 둔다.',
      '- Latest authority: 법·노무·재정·정책 사안은 최신 공식 지침/법령/판례를 우선한다.',
      '- Comparator consistency: 벤치마킹은 모든 항목에 같은 방향의 가중치로 적용하고 유불리에 따라 바꾸지 않는다.',
      '- Counterargument: 강한 결론 전에 반대측 최강 반박을 작성하고, 반박이 유효하면 결론 강도를 낮춘다.',
      '- User correction loop: 사용자가 “이거 아니야”라고 지적한 패턴은 실패유형으로 분류해 다음 판단 게이트에 즉시 반영한다.',
      '- Claim strength: 불가/금지/확정 표현은 directly_applicable 근거가 있을 때만 쓰고, 아니면 원안 부적정/조건부/재설계 필요로 표현한다.',
      `- detected_issues: ${result.issueSummary}`,
    ];
    if (result.issues.length > 0) {
      lines.push('- required_actions:');
      for (const issue of result.issues) lines.push(`  - ${issue.code}: ${issue.requiredAction}`);
    }
    return lines.join('\n');
  }

  private promptRules(): string[] {
    return [
      'source_intake_parse_gate',
      'source_freshness_gate',
      'applicability_map_gate',
      'decision_logic_graph_gate',
      'latest_authority_gate',
      'comparator_consistency_gate',
      'counterargument_attack_gate',
      'user_correction_self_hardening_gate',
      'claim_strength_gate',
    ];
  }
}
