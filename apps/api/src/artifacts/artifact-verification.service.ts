import { Inject, Injectable, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import type { ArtifactExportPreflightResponse } from '@consulting/contracts';
import type { ClaimInput, ClaimVerdict, EvidenceInput } from '../consulting/evidence-to-decision.service.js';
import { ClaimVerifierService } from '../consulting/claim-verifier.service.js';
import { ExactnessGateService, type ExactnessGateResult } from '../consulting/exactness-gate.service.js';
import { VerifierGatePolicyService, type VerifierGateResult } from '../consulting/verifier-gate-policy.service.js';
import {
  artifactContentHash,
  artifactTitleHash,
  auditArtifactExportPreflight,
  type ArtifactVersionVerificationSnapshot,
} from './artifact-export-preflight-audit.js';

const MAX_ARTIFACT_CLAIMS = 24;
const MAX_ARTIFACT_CLAIM_CHARS = 2_000;
const MAX_ARTIFACT_TITLE_CHARS = 200;
const MAX_ARTIFACT_CONTENT_CHARS = 200_000;
const MAX_CONCURRENT_ARTIFACT_VERIFICATIONS = 2;
const HIGH_IMPACT_RE = /(증가|감소|부담|정원|인건비|법령|확정|매출|비용|금액|수치|increase|decrease|revenue|cost)/iu;
const MARKDOWN_SEPARATOR_RE = /^\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?$/u;
const HORIZONTAL_RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/u;
const STRUCTURAL_HEADING_RE = /^(?:결론|요약|개요|목차|근거|공식 근거|법령 확인|적용 범위|근거 한계|해석 기준|보고서 표기 원칙)$/u;
const STRUCTURAL_TABLE_CELL_RE = /^(?:항목|값|구분|내용|근거|출처|비고|기준|수치|결과)$/u;
const STRUCTURAL_ARTIFACT_TITLE_RE = /^(?:대화\s*[—-]\s*지구 답변)$/u;

export const ARTIFACT_VERIFICATION_POLICY_VERSION = 'artifact_claim_coverage_v4';

export interface ArtifactVerificationTarget {
  artifactId: string;
  artifactVersionId: string;
  workspaceId: string;
  projectId: string;
  title: string;
  versionNo: number;
  content: string;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
}

export interface ArtifactVerificationRecordInput {
  target: ArtifactVerificationTarget;
  contentHash: string;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  exactness: ExactnessGateResult;
  verdicts: ClaimVerdict[];
  gate: VerifierGateResult;
  verifier: string;
  evidenceCount: number;
  verifiedByUserId: string;
}

export interface ArtifactVerificationLedger {
  latest(target: ArtifactVerificationTarget): Promise<ArtifactVersionVerificationSnapshot | null>;
  loadEvidence(target: ArtifactVerificationTarget): Promise<EvidenceInput[]>;
  record(input: ArtifactVerificationRecordInput): Promise<ArtifactVersionVerificationSnapshot>;
}

export const ARTIFACT_VERIFICATION_LEDGER = Symbol('ARTIFACT_VERIFICATION_LEDGER');

export function artifactVerificationPolicyPrefix(target: Pick<ArtifactVerificationTarget, 'title'>): string {
  return `${ARTIFACT_VERIFICATION_POLICY_VERSION}:${artifactTitleHash(target.title)}`;
}

@Injectable()
export class ArtifactVerificationService {
  private readonly inFlight = new Map<string, Promise<ArtifactExportPreflightResponse>>();

  constructor(
    @Inject(ARTIFACT_VERIFICATION_LEDGER) private readonly ledger: ArtifactVerificationLedger,
    @Inject(ClaimVerifierService) private readonly verifier: ClaimVerifierService,
    @Inject(ExactnessGateService) private readonly exactness: ExactnessGateService,
    @Inject(VerifierGatePolicyService) private readonly gatePolicy: VerifierGatePolicyService,
  ) {}

  async preflightVersion(input: ArtifactVerificationTarget): Promise<ArtifactExportPreflightResponse> {
    assertArtifactVerificationInputSize(input);
    return this.classify(input, await this.ledger.latest(input));
  }

  async verifyVersion(
    input: ArtifactVerificationTarget & { verifiedByUserId: string },
  ): Promise<ArtifactExportPreflightResponse> {
    assertArtifactVerificationInputSize(input);
    const contentHash = artifactContentHash(input.content);
    const key = `${input.artifactVersionId}:${contentHash}:${artifactTitleHash(input.title)}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size >= MAX_CONCURRENT_ARTIFACT_VERIFICATIONS) {
      throw new ServiceUnavailableException({
        code: 'ARTIFACT_VERIFIER_BUSY',
        message: '산출물 검증 요청이 처리 중입니다. 잠시 후 다시 시도하세요.',
      });
    }
    const task = this.verifyVersionOnce(input, contentHash).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async verifyVersionOnce(
    input: ArtifactVerificationTarget & { verifiedByUserId: string },
    contentHash: string,
  ): Promise<ArtifactExportPreflightResponse> {
    const { verifiedByUserId, ...target } = input;
    const evidence = await this.ledger.loadEvidence(target);
    const extraction = artifactClaims(target);
    const claims = extraction.claims;
    const highRiskClaimIds = claims
      .filter((claim) => (claim.decisionImpact ?? 0) >= 0.8)
      .map((claim) => claim.id);
    const exactness = this.exactness.evaluateAnswer({ query: target.title, answer: target.content });
    const verification = await this.verifier.verify({ claims, evidence, highRiskClaimIds });
    const verdicts = completeClaimVerdicts(claims, verification.lattice.verdicts, extraction.coverageVerdicts);
    const gate = this.gatePolicy.evaluate({
      mode: 'final_export',
      exactnessStatus: exactness.status,
      citationIssueCount: 0,
      verdicts,
    });
    const snapshot = await this.ledger.record({
      target,
      contentHash,
      sourceThreadId: target.sourceThreadId,
      sourceMessageId: target.sourceMessageId,
      exactness,
      verdicts,
      gate,
      verifier: `${artifactVerificationPolicyPrefix(target)}:${verification.verifier}`,
      evidenceCount: evidence.length,
      verifiedByUserId,
    });
    return this.classify(target, snapshot);
  }

  private classify(
    input: ArtifactVerificationTarget,
    verification: ArtifactVersionVerificationSnapshot | null,
  ): ArtifactExportPreflightResponse {
    const result = auditArtifactExportPreflight({
      projectId: input.projectId,
      projectName: input.title,
      rows: [{ ...input, verification }],
    });
    const row = result.rows[0]!;
    return {
      canExport: row.canExport,
      reason: row.reason,
      versionNo: row.versionNo,
      gate: row.gate,
      messages: row.messages,
    };
  }
}

function assertArtifactVerificationInputSize(target: Pick<ArtifactVerificationTarget, 'title' | 'content'>): void {
  if (target.title.length <= MAX_ARTIFACT_TITLE_CHARS && target.content.length <= MAX_ARTIFACT_CONTENT_CHARS) return;
  throw new PayloadTooLargeException({
    code: 'ARTIFACT_VERIFICATION_INPUT_TOO_LARGE',
    message: '산출물 제목 또는 본문이 검증 가능한 최대 크기를 초과했습니다.',
  });
}

function artifactClaims(target: ArtifactVerificationTarget): {
  claims: ClaimInput[];
  coverageVerdicts: ClaimVerdict[];
} {
  const prefix = target.artifactVersionId.replace(/-/gu, '').slice(0, 8).toUpperCase();
  const titleSegments = STRUCTURAL_ARTIFACT_TITLE_RE.test(target.title.trim()) ? [] : [target.title.trim()];
  const contentSegments = target.content
    .split(/\n+/u)
    .flatMap(markdownLineSegments);
  const segments = [...new Set([...titleSegments, ...contentSegments]
    .map((part) => part.trim())
    .filter((part) => part.length >= 1))];
  const coverageReasons: string[] = [];
  if (segments.length > MAX_ARTIFACT_CLAIMS) {
    coverageReasons.push(`claim_count=${segments.length}>${MAX_ARTIFACT_CLAIMS}`);
  }
  const claims = segments.slice(0, MAX_ARTIFACT_CLAIMS).map((rawText, index) => {
    if (rawText.length > MAX_ARTIFACT_CLAIM_CHARS) {
      coverageReasons.push(`claim_chars=${rawText.length}>${MAX_ARTIFACT_CLAIM_CHARS}`);
    }
    const text = rawText.slice(0, MAX_ARTIFACT_CLAIM_CHARS);
    return {
      id: `ART-${prefix}-${index + 1}`,
      text,
      decisionImpact: HIGH_IMPACT_RE.test(text) || /\d/u.test(text) ? 0.82 : 0.62,
    };
  });
  const coverageVerdicts = coverageReasons.length > 0
    ? [coverageVerdict(`ART-${prefix}-COVERAGE`, coverageReasons.join('; '))]
    : [];
  return { claims, coverageVerdicts };
}

function markdownLineSegments(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed || /^```/u.test(trimmed) || MARKDOWN_SEPARATOR_RE.test(trimmed) || HORIZONTAL_RULE_RE.test(trimmed)) return [];
  const heading = /^#{1,6}\s*/u.test(trimmed);
  const normalized = trimmed
    .replace(/^#{1,6}\s*/u, '')
    .replace(/^(?:[-*+]|\d+[.)]|>)\s+/u, '')
    .replace(/^\|\s*/u, '')
    .replace(/\s*\|$/u, '')
    .trim();
  if (heading && STRUCTURAL_HEADING_RE.test(normalized)) return [];
  if (normalized.includes('|')) {
    return normalized
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => !STRUCTURAL_TABLE_CELL_RE.test(cell))
      .flatMap(splitProseSegment);
  }
  return splitProseSegment(normalized);
}

function splitProseSegment(value: string): string[] {
  return value.trim().split(/(?<=[.!?。;；])\s*/u);
}

function completeClaimVerdicts(
  claims: ClaimInput[],
  verdicts: ClaimVerdict[],
  coverageVerdicts: ClaimVerdict[],
): ClaimVerdict[] {
  const seen = new Set(verdicts.map((verdict) => verdict.claimId));
  const missing = claims
    .filter((claim) => !seen.has(claim.id))
    .map((claim) => coverageVerdict(claim.id, 'verifier_missing_claim_verdict', claim.text));
  return [...verdicts, ...missing, ...coverageVerdicts];
}

function coverageVerdict(
  claimId: string,
  reason: string,
  claimText = 'artifact claim coverage limit exceeded',
): ClaimVerdict {
  return {
    claimId,
    claimText,
    evidenceId: null,
    verdict: 'not_enough_info',
    confidence: 1,
    matchedTerms: [],
    contradictedTerms: [],
    rationale: `artifact_claim_coverage: ${reason}`,
    decisionImpact: 1,
  };
}