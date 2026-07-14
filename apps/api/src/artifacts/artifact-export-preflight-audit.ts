import { createHash } from 'node:crypto';
import type { ArtifactRedTeamPreflight } from '@consulting/contracts';
import type { VerifierGateResult } from '../consulting/verifier-gate-policy.service.js';

export interface ArtifactVersionVerificationSnapshot {
  artifactId: string;
  artifactVersionId: string;
  workspaceId: string;
  projectId: string;
  contentHash: string;
  gate: VerifierGateResult;
}

export type ArtifactRedTeamMode = 'off' | 'shadow' | 'warning';
export type ArtifactRedTeamPersona = '감사원' | '의회' | '노조';

export interface ArtifactRedTeamSnapshot {
  artifactId: string;
  artifactVersionId: string;
  workspaceId: string;
  projectId: string;
  contentHash: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  verdict: 'PASS' | 'PASS_WITH_WARNINGS' | 'BLOCKED' | null;
  policyVersion: string;
  reviewedAt: string | null;
  attacks: Array<{
    persona: ArtifactRedTeamPersona;
    severity: 'warning' | 'blocker';
    category: string;
    message: string;
  }>;
  defenses: Array<{
    attackIndex: number;
    response: string;
    disposition: 'sustained' | 'mitigated' | 'unresolved';
  }>;
}

export interface ArtifactExportPreflightAuditInputRow {
  artifactId: string;
  artifactVersionId: string;
  workspaceId: string;
  projectId: string;
  title: string;
  versionNo: number;
  content: string;
  governingMessage: string | null;
  soWhat: string | null;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  verification: ArtifactVersionVerificationSnapshot | null;
  redTeam?: ArtifactRedTeamSnapshot | null;
}

export interface ArtifactExportPreflightAuditInput {
  projectId: string;
  projectName: string;
  redTeamMode?: ArtifactRedTeamMode;
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
  reason: 'OK' | 'ARTIFACT_STRUCTURE_REQUIRED' | 'ARTIFACT_VERIFICATION_REQUIRED' | 'VERIFIER_GATE_BLOCKED';
  gate: VerifierGateResult | null;
  messages: string[];
  redTeam: ArtifactRedTeamPreflight;
}

export interface ArtifactExportPreflightAuditResult {
  readOnly: true;
  status: 'ok' | 'blocked';
  projectId: string;
  projectName: string;
  summary: { total: number; exportable: number; blocked: number; verificationRequired: number };
  rows: ArtifactExportPreflightAuditRowResult[];
}

export function artifactContentHash(
  content: string,
  governingMessage: string | null = null,
  soWhat: string | null = null,
): string {
  const payload = governingMessage === null && soWhat === null
    ? content
    : JSON.stringify(['artifact-version-structure-v1', content, governingMessage, soWhat]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function artifactTitleHash(title: string): string {
  return createHash('sha256').update(title, 'utf8').digest('hex');
}

export function auditArtifactExportPreflight(input: ArtifactExportPreflightAuditInput): ArtifactExportPreflightAuditResult {
  const rows = input.rows.map((row) => auditRow(row, input.redTeamMode ?? 'shadow'));
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

function auditRow(row: ArtifactExportPreflightAuditInputRow, redTeamMode: ArtifactRedTeamMode): ArtifactExportPreflightAuditRowResult {
  const redTeam = artifactRedTeamPreflight(row, row.redTeam ?? null, redTeamMode);
  const base = {
    artifactId: row.artifactId,
    artifactVersionId: row.artifactVersionId,
    title: row.title,
    versionNo: row.versionNo,
    sourceThreadId: row.sourceThreadId,
    sourceMessageId: row.sourceMessageId,
    redTeam,
  };
  const structureMessages = artifactStructureMessages(row);
  if (structureMessages.length > 0) {
    return {
      ...base,
      canExport: false,
      reason: 'ARTIFACT_STRUCTURE_REQUIRED',
      gate: null,
      messages: structureMessages,
    };
  }
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
  const messages = [...gate.blockers, ...gate.warnings].map((issue) => issue.message).slice(0, 20);
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
    messages: redTeamMode === 'warning' ? redTeamWarningMessages(redTeam) : messages,
  };
}

function redTeamWarningMessages(redTeam: ArtifactRedTeamPreflight): string[] {
  if (redTeam.status === 'missing') {
    return ['현재 산출물 버전에 대한 적대 검토가 아직 없습니다. 내보내기는 허용되지만 검토를 권장합니다.'];
  }
  if (redTeam.status === 'pending' || redTeam.status === 'processing') {
    return ['현재 산출물 버전의 적대 검토가 진행 중입니다. 내보내기는 허용되며 완료 후 결과를 다시 확인할 수 있습니다.'];
  }
  if (redTeam.status === 'stale') {
    return ['산출물 본문이 변경되어 이전 적대 검토가 무효화되었습니다. 현재 버전의 재검토를 권장합니다.'];
  }
  if (redTeam.status === 'failed') {
    return ['현재 산출물 버전의 적대 검토를 완료하지 못했습니다. 내보내기는 허용되지만 재검토를 권장합니다.'];
  }
  if (redTeam.status === 'disabled' || redTeam.verdict === 'PASS') return [];
  const attacks = redTeam.attacks
    .slice(0, 20)
    .map((attack) => `${attack.persona}: ${attack.message}`);
  return attacks.length > 0
    ? attacks
    : ['현재 산출물 버전의 적대 검토에서 보완 필요 판정이 나왔습니다.'];
}

function artifactRedTeamPreflight(
  row: ArtifactExportPreflightAuditInputRow,
  review: ArtifactRedTeamSnapshot | null,
  mode: ArtifactRedTeamMode,
): ArtifactRedTeamPreflight {
  if (mode === 'off') return emptyRedTeamPreflight(mode, 'disabled');
  if (!redTeamScopeMatches(row, review)) return emptyRedTeamPreflight(mode, 'missing');
  const currentHash = artifactContentHash(row.content, row.governingMessage, row.soWhat);
  if (review.contentHash !== currentHash) {
    return { ...emptyRedTeamPreflight(mode, 'stale'), contentHash: review.contentHash, policyVersion: review.policyVersion };
  }
  return {
    mode,
    status: review.status,
    verdict: review.verdict,
    contentHash: review.contentHash,
    policyVersion: review.policyVersion,
    attacks: review.attacks,
    defenses: review.defenses,
    reviewedAt: review.reviewedAt,
  };
}

function emptyRedTeamPreflight(
  mode: ArtifactRedTeamMode,
  status: 'disabled' | 'missing' | 'stale',
): ArtifactRedTeamPreflight {
  return { mode, status, verdict: null, contentHash: null, policyVersion: null, attacks: [], defenses: [], reviewedAt: null };
}

function redTeamScopeMatches(
  row: ArtifactExportPreflightAuditInputRow,
  review: ArtifactRedTeamSnapshot | null,
): review is ArtifactRedTeamSnapshot {
  return Boolean(
    review
      && review.artifactId === row.artifactId
      && review.artifactVersionId === row.artifactVersionId
      && review.workspaceId === row.workspaceId
      && review.projectId === row.projectId
  );
}

export function artifactStructureMessages(
  row: Pick<ArtifactExportPreflightAuditInputRow, 'governingMessage' | 'soWhat'>,
): string[] {
  const messages: string[] = [];
  if (!row.governingMessage?.trim()) messages.push('산출물의 핵심 결론(governing message)을 입력하세요.');
  if (!row.soWhat?.trim()) messages.push('이 결론이 의사결정에 주는 의미(so what)를 입력하세요.');
  return messages;
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
      && verification.contentHash === artifactContentHash(row.content, row.governingMessage, row.soWhat),
  );
}