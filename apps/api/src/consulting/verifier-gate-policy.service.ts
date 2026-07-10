import { Injectable } from '@nestjs/common';
import type { ClaimVerdict } from './evidence-to-decision.service.js';
import type { ExactnessRunStatus } from './exactness-gate.service.js';
import type { ConsultingJudgmentGuardIssue } from './consulting-judgment-guard.service.js';

export type VerifierGateMode = 'general_chat' | 'analysis_draft' | 'report_decision' | 'final_export';
export type VerifierGateDecision = 'PASS' | 'PASS_WITH_WARNINGS' | 'BLOCKED';
export type VerifierGateIssueCode =
  | 'missing_verifier_telemetry'
  | 'exactness_blocked'
  | 'citation_issue'
  | 'high_impact_refute'
  | 'high_impact_unsupported'
  | 'semantic_refute'
  | 'semantic_unsupported'
  | 'judgment_guard_blocker'
  | ConsultingJudgmentGuardIssue['code'];

export interface VerifierGateIssue {
  code: VerifierGateIssueCode;
  severity: 'warning' | 'blocker';
  message: string;
  claimId?: string;
}

export interface VerifierGateInput {
  mode: VerifierGateMode;
  exactnessStatus?: ExactnessRunStatus;
  citationIssueCount?: number;
  verdicts?: ClaimVerdict[];
  judgmentIssues?: ConsultingJudgmentGuardIssue[];
}

export interface VerifierGateResult {
  decision: VerifierGateDecision;
  blockers: VerifierGateIssue[];
  warnings: VerifierGateIssue[];
}

const HIGH_IMPACT_THRESHOLD = 0.8;

@Injectable()
export class VerifierGatePolicyService {
  evaluate(input: VerifierGateInput): VerifierGateResult {
    const blockers: VerifierGateIssue[] = [];
    const warnings: VerifierGateIssue[] = [];
    const push = (issue: Omit<VerifierGateIssue, 'severity'>, shouldBlock: boolean): void => {
      const target = shouldBlock ? blockers : warnings;
      target.push({ ...issue, severity: shouldBlock ? 'blocker' : 'warning' });
    };

    const structuralBlocksEnabled = input.mode === 'report_decision' || input.mode === 'final_export';
    const finalExport = input.mode === 'final_export';
    const verifierTelemetryPresent = input.exactnessStatus === 'passed' || input.exactnessStatus === 'blocked'
      || Boolean(input.citationIssueCount && input.citationIssueCount > 0)
      || Boolean(input.verdicts?.length)
      || Boolean(input.judgmentIssues?.length);

    if (finalExport && !verifierTelemetryPresent) {
      push({ code: 'missing_verifier_telemetry', message: '대상 본문의 검증 텔레메트리(verdict/exactness/judgment)가 없어 최종 내보내기를 검증할 수 없습니다.' }, true);
    }

    if (input.exactnessStatus === 'blocked') {
      push({ code: 'exactness_blocked', message: '수치·계산·원문 확인 게이트가 blocked 상태입니다.' }, structuralBlocksEnabled);
    }

    if ((input.citationIssueCount ?? 0) > 0) {
      push({ code: 'citation_issue', message: `인용/출처 문제가 ${input.citationIssueCount}건 있습니다.` }, structuralBlocksEnabled);
    }

    for (const issue of input.judgmentIssues ?? []) {
      if (issue.severity === 'blocker') {
        push(
          { code: 'judgment_guard_blocker', message: `${issue.code}: ${issue.message}` },
          structuralBlocksEnabled,
        );
        continue;
      }
      push({ code: issue.code, message: `${issue.code}: ${issue.message}` }, false);
    }

    for (const verdict of input.verdicts ?? []) {
      const highImpact = verdict.decisionImpact >= HIGH_IMPACT_THRESHOLD;
      if (verdict.verdict === 'refutes' || verdict.verdict === 'mixed') {
        push(
          {
            code: highImpact ? 'high_impact_refute' : 'semantic_refute',
            message: highImpact ? '핵심 claim이 근거와 모순됩니다.' : '근거와 모순되는 claim이 있습니다.',
            claimId: verdict.claimId,
          },
          input.mode === 'report_decision' || finalExport,
        );
      }
      if (verdict.verdict === 'not_enough_info') {
        push(
          {
            code: highImpact ? 'high_impact_unsupported' : 'semantic_unsupported',
            message: highImpact ? '핵심 claim의 근거가 부족합니다.' : '근거가 부족한 claim이 있습니다.',
            claimId: verdict.claimId,
          },
          finalExport && highImpact,
        );
      }
    }

    return {
      decision: blockers.length > 0 ? 'BLOCKED' : warnings.length > 0 ? 'PASS_WITH_WARNINGS' : 'PASS',
      blockers,
      warnings,
    };
  }
}
