import { describe, expect, it } from 'vitest';
import { reconcileOptimisticTurns } from './liveTurnReconciliation';

const live = [
  { id: 1, attemptId: 'attempt-1', role: 'user' as const, text: '질문' },
  { id: 2, attemptId: 'attempt-1', role: 'ai' as const, text: '답변', runId: 'run-1' },
  { id: 3, attemptId: 'attempt-2', role: 'user' as const, text: '진행 중 질문' },
  { id: 4, attemptId: 'attempt-2', role: 'ai' as const, text: '진행 중', runId: 'run-2' },
];

describe('reconcileOptimisticTurns', () => {
  it('removes an optimistic user/assistant pair once its persisted assistant run is loaded', () => {
    expect(reconcileOptimisticTurns(live, [{ runId: 'run-1' }])).toEqual(live.slice(2));
  });

  it('keeps optimistic pairs whose assistant run is not in the loaded message window', () => {
    expect(reconcileOptimisticTurns(live, [{ runId: 'another-run' }, { runId: null }])).toEqual(live);
  });
});
