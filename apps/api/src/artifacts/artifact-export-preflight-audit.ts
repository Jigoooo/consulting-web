import { VerifierGatePolicyService, type VerifierGateResult } from '../consulting/verifier-gate-policy.service.js';
import type { ClaimVerdict, ClaimVerdictKind } from '../consulting/evidence-to-decision.service.js';
import type { ExactnessRunStatus } from '../consulting/exactness-gate.service.js';

export interface ArtifactExportPreflightAuditVerdictRow {
  claimId: string;
  claimText: string;
  verdict: ClaimVerdictKind;
  confidence: number | string | null;
  rationale: string;
}

export interface ArtifactExportPreflightAuditInputRow {
  artifactId: string;
  title: string;
  versionNo: number;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  sourceValid: boolean | null;
  exactnessStatus: ExactnessRunStatus | null;
  verdicts: ArtifactExportPreflightAuditVerdictRow[];
}

export interface ArtifactExportPreflightAuditInput {
  projectId: string;
  projectName: string;
  rows: ArtifactExportPreflightAuditInputRow[];
}

export interface ArtifactExportPreflightAuditRowResult {
  artifactId: string;
  title: string;
  versionNo: number;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  canExport: boolean;
  reason: 'OK' | 'NO_SOURCE_MESSAGE' | 'INVALID_SOURCE_MESSAGE' | 'VERIFIER_GATE_BLOCKED';
  gate: VerifierGateResult | null;
  messages: string[];
}

export interface ArtifactExportPreflightAuditResult {
  readOnly: true;
  status: 'ok' | 'blocked';
  projectId: string;
  projectName: string;
  summary: { total: number; exportable: number; blocked: number; noSourceMessage: number; invalidSourceMessage: number };
  rows: ArtifactExportPreflightAuditRowResult[];
}

const gatePolicy = new VerifierGatePolicyService();

export function auditArtifactExportPreflight(input: ArtifactExportPreflightAuditInput): ArtifactExportPreflightAuditResult {
  const rows = input.rows.map(auditRow);
  const blocked = rows.filter((row) => !row.canExport).length;
  const noSourceMessage = rows.filter((row) => row.reason === 'NO_SOURCE_MESSAGE').length;
  const invalidSourceMessage = rows.filter((row) => row.reason === 'INVALID_SOURCE_MESSAGE').length;
  return {
    readOnly: true,
    status: blocked > 0 ? 'blocked' : 'ok',
    projectId: input.projectId,
    projectName: input.projectName,
    summary: {
      total: rows.length,
      exportable: rows.length - blocked,
      blocked,
      noSourceMessage,
      invalidSourceMessage,
    },
    rows,
  };
}

function auditRow(row: ArtifactExportPreflightAuditInputRow): ArtifactExportPreflightAuditRowResult {
  if (!row.sourceMessageId) {
    return {
      artifactId: row.artifactId,
      title: row.title,
      versionNo: row.versionNo,
      sourceThreadId: row.sourceThreadId,
      sourceMessageId: row.sourceMessageId,
      canExport: true,
      reason: 'NO_SOURCE_MESSAGE',
      gate: null,
      messages: ['이 버전은 원본 답변(sourceMessageId)과 연결되지 않아 문장별 검증 게이트를 확인할 수 없습니다.'],
    };
  }

  if (row.sourceValid === false) {
    return {
      artifactId: row.artifactId,
      title: row.title,
      versionNo: row.versionNo,
      sourceThreadId: row.sourceThreadId,
      sourceMessageId: row.sourceMessageId,
      canExport: false,
      reason: 'INVALID_SOURCE_MESSAGE',
      gate: null,
      messages: ['산출물 원본 답변(sourceMessageId)이 현재 프로젝트의 활성 thread/topic/channel에 속하지 않습니다.'],
    };
  }

  const exactnessStatus = normalizeExactness(row.exactnessStatus);
  const gate = gatePolicy.evaluate({
    mode: 'final_export',
    ...(exactnessStatus ? { exactnessStatus } : {}),
    citationIssueCount: 0,
    verdicts: row.verdicts.map(verdictForGate),
  });
  const messages = [...gate.blockers, ...gate.warnings].map((issue) => issue.message);
  const blocked = gate.decision === 'BLOCKED';
  return {
    artifactId: row.artifactId,
    title: row.title,
    versionNo: row.versionNo,
    sourceThreadId: row.sourceThreadId,
    sourceMessageId: row.sourceMessageId,
    canExport: !blocked,
    reason: blocked ? 'VERIFIER_GATE_BLOCKED' : 'OK',
    gate,
    messages: blocked && messages.length === 0 ? ['검증 게이트가 이 산출물의 내보내기를 차단했습니다.'] : messages,
  };
}

function verdictForGate(row: ArtifactExportPreflightAuditVerdictRow): ClaimVerdict {
  const verdict: ClaimVerdictKind = row.verdict === 'refutes' || row.verdict === 'mixed' || row.verdict === 'not_enough_info'
    ? row.verdict
    : 'supports';
  return {
    claimId: row.claimId,
    claimText: row.claimText,
    evidenceId: null,
    verdict,
    confidence: clamp01(Number(row.confidence ?? 0)),
    matchedTerms: [],
    contradictedTerms: [],
    rationale: row.rationale,
    decisionImpact: verdict === 'refutes' || verdict === 'mixed' ? 0.82 : verdict === 'not_enough_info' ? 0.62 : 0.5,
  };
}

function normalizeExactness(value: ExactnessRunStatus | null): ExactnessRunStatus | undefined {
  if (value === 'blocked' || value === 'passed' || value === 'skipped') return value;
  return undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
