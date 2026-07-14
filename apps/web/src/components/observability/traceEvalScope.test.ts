import { describe, expect, it } from 'vitest';
import { describeEvalScope } from './traceEvalScope';

describe('Trace Viewer eval scope policy', () => {
  it('labels workspace-wide eval rows as not causally linked to the selected trace', () => {
    expect(describeEvalScope({})).toEqual({
      kind: 'workspace',
      title: '워크스페이스 전체 평가 원장',
      description: '아래 평가는 선택한 trace와 직접 연결되지 않은 워크스페이스 전체 기록입니다.',
      showLedger: true,
    });
  });

  it('labels thread-wide eval rows as not causally linked to the selected trace', () => {
    expect(describeEvalScope({ threadFilter: '33333333-3333-4333-8333-333333333333' })).toEqual({
      kind: 'thread',
      title: '대화 범위 평가 원장',
      description: '아래 평가는 선택한 trace와 직접 연결되지 않은 이 대화의 전체 기록입니다.',
      showLedger: true,
    });
  });

  it('fails closed when a trace filter has no causally linked eval relation', () => {
    expect(describeEvalScope({ traceFilter: 'trace-123' })).toEqual({
      kind: 'none',
      title: '연결된 평가 원장 없음',
      description: '현재 데이터 모델에는 이 trace와 직접 연결된 평가 기록이 없습니다.',
      showLedger: false,
    });
  });
});
