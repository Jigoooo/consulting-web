import { createHash } from 'node:crypto';
import type { VerifierGateResult } from '../consulting/verifier-gate-policy.service.js';

export interface ArtifactVersionVerificationSnapshot {
  artifactId: string;
  artifactVersionId: string;
  workspaceId: string;
  projectId: string;
  contentHash: string;
  gate: VerifierGateResult;
}

export interface ArtifactExportPreflightAuditInputRow {
  artifactId: string;
  artifactVersionId: string;
  workspaceId: string;
  projectId: string;
  title: string;
  versionNo: number;
  content: string;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  verification: ArtifactVersionVerificationSnapshot | null;
}

export interface ArtifactExportPreflightAuditInput {
  projectId: string;
  projectName: string;
  rows: ArtifactExportPreflightAuditInputRow[];
}

export interface ArtifactExportPreflightAuditRowResult {
  artifactId: string;
  artifactVersionId: string;
  title: string;
  versionNo: number;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  canExport: boolean;
  reason: 'OK' | 'ARTIFACT_VERIFICATION_REQUIRED' | 'VERIFIER_GATE_BLOCKED';
  gate: VerifierGateResult | null;
  messages: string[];
}

export interface ArtifactExportPreflightAuditResult {
  readOnly: true;
  status: 'ok' | 'blocked';
  projectId: string;
  projectName: string;
  summary: { total: number; exportable: number; blocked: number; verificationRequired: number };
  rows: ArtifactExportPreflightAuditRowResult[];
}

export function artifactContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function artifactTitleHash(title: string): string {
  return createHash('sha256').update(title, 'utf8').digest('hex');
}

export function auditArtifactExportPreflight(input: ArtifactExportPreflightAuditInput): ArtifactExportPreflightAuditResult {
  const rows = input.rows.map(auditRow);
  const blocked = rows.filter((row) => !row.canExport).length;
  const verificationRequired = rows.filter((row) => row.reason === 'ARTIFACT_VERIFICATION_REQUIRED').length;
  return {
    readOnly: true,
    status: blocked > 0 ? 'blocked' : 'ok',
    projectId: input.projectId,
    projectName: input.projectName,
    summary: {
      total: rows.length,
      exportable: rows.length - blocked,
      blocked,
      verificationRequired,
    },
    rows,
  };
}

function auditRow(row: ArtifactExportPreflightAuditInputRow): ArtifactExportPreflightAuditRowResult {
  const base = {
    artifactId: row.artifactId,
    artifactVersionId: row.artifactVersionId,
    title: row.title,
    versionNo: row.versionNo,
    sourceThreadId: row.sourceThreadId,
    sourceMessageId: row.sourceMessageId,
  };
  if (!verificationMatches(row, row.verification)) {
    return {
      ...base,
      canExport: false,
      reason: 'ARTIFACT_VERIFICATION_REQUIRED',
      gate: null,
      messages: ['현재 산출물 버전의 정확한 본문에 대한 검증 결과가 없습니다. 본문 검증을 실행한 뒤 다시 시도하세요.'],
    };
  }

  const gate = row.verification.gate;
  const messages = [...gate.blockers, ...gate.warnings].map((issue) => issue.message);
  const cleanPass = gate.decision === 'PASS' && gate.blockers.length === 0 && gate.warnings.length === 0;
  if (!cleanPass) {
    return {
      ...base,
      canExport: false,
      reason: 'VERIFIER_GATE_BLOCKED',
      gate,
      messages: messages.length > 0 ? messages : ['검증 게이트가 이 산출물의 내보내기를 차단했습니다.'],
    };
  }
  return {
    ...base,
    canExport: true,
    reason: 'OK',
    gate,
    messages,
  };
}

function verificationMatches(
  row: ArtifactExportPreflightAuditInputRow,
  verification: ArtifactVersionVerificationSnapshot | null,
): verification is ArtifactVersionVerificationSnapshot {
  return Boolean(
    verification
      && verification.artifactId === row.artifactId
      && verification.artifactVersionId === row.artifactVersionId
      && verification.workspaceId === row.workspaceId
      && verification.projectId === row.projectId
      && verification.contentHash === artifactContentHash(row.content),
  );
}