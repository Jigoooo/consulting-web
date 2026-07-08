import type { VerifierGateSummary } from '@consulting/contracts';

export type VerifierGateTone = 'good' | 'warn' | 'bad';

export interface VerifierGateViewModel {
  label: string;
  tone: VerifierGateTone;
  detail: string;
  title: string;
}

export function describeVerifierGate(gate: VerifierGateSummary): VerifierGateViewModel {
  const blockerCount = gate.blockers.length;
  const warningCount = gate.warnings.length;
  const parts = [
    blockerCount > 0 ? `차단 ${blockerCount}` : '',
    warningCount > 0 ? `경고 ${warningCount}` : '',
  ].filter(Boolean);
  const titleParts = [
    blockerCount > 0 ? `차단 ${blockerCount}건` : '',
    warningCount > 0 ? `경고 ${warningCount}건` : '',
  ].filter(Boolean);

  if (gate.decision === 'BLOCKED') {
    return {
      label: '릴리즈 차단',
      tone: 'bad',
      detail: parts.join(' · ') || '차단 사유 확인 필요',
      title: titleParts.join(', ') || '릴리즈 차단',
    };
  }

  if (gate.decision === 'PASS_WITH_WARNINGS') {
    return {
      label: '검토 필요',
      tone: 'warn',
      detail: parts.join(' · ') || '경고 확인 필요',
      title: titleParts.join(', ') || '검토 경고 있음',
    };
  }

  return {
    label: '게이트 통과',
    tone: 'good',
    detail: '이슈 없음',
    title: '검증 게이트 통과',
  };
}
