export interface EvalScopePresentation {
  kind: 'workspace' | 'thread' | 'none';
  title: string;
  description: string;
  showLedger: boolean;
}

export function describeEvalScope(filters: { traceFilter?: string; threadFilter?: string }): EvalScopePresentation {
  if (filters.traceFilter?.trim()) {
    return {
      kind: 'none',
      title: '연결된 평가 원장 없음',
      description: '현재 데이터 모델에는 이 trace와 직접 연결된 평가 기록이 없습니다.',
      showLedger: false,
    };
  }
  if (filters.threadFilter?.trim()) {
    return {
      kind: 'thread',
      title: '대화 범위 평가 원장',
      description: '아래 평가는 선택한 trace와 직접 연결되지 않은 이 대화의 전체 기록입니다.',
      showLedger: true,
    };
  }
  return {
    kind: 'workspace',
    title: '워크스페이스 전체 평가 원장',
    description: '아래 평가는 선택한 trace와 직접 연결되지 않은 워크스페이스 전체 기록입니다.',
    showLedger: true,
  };
}
