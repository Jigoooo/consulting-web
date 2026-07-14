export interface OptimisticTurnIdentity {
  attemptId: string;
  role: 'user' | 'ai';
  runId?: string;
}

export function reconcileOptimisticTurns<T extends OptimisticTurnIdentity>(
  live: T[],
  persisted: Array<{ runId: string | null }>,
): T[] {
  if (live.length === 0 || persisted.length === 0) return live;
  const persistedRunIds = new Set(
    persisted.flatMap((message) => message.runId ? [message.runId] : []),
  );
  if (persistedRunIds.size === 0) return live;

  const settledAttempts = new Set(
    live.flatMap((turn) => (
      turn.role === 'ai' && turn.runId && persistedRunIds.has(turn.runId)
        ? [turn.attemptId]
        : []
    )),
  );
  if (settledAttempts.size === 0) return live;
  return live.filter((turn) => !settledAttempts.has(turn.attemptId));
}
