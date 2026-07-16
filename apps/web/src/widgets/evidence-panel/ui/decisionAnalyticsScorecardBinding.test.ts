import { describe, expect, it } from 'vitest';
import { decisionAnalyticsRunForScorecard } from './EvidencePanel';

describe('decision analytics scorecard binding', () => {
  it('does not expose a run from another scorecard', () => {
    const run = { scorecardId: 'scorecard-a', id: 'run-a' };
    expect(decisionAnalyticsRunForScorecard(run, 'scorecard-b')).toBeNull();
    expect(decisionAnalyticsRunForScorecard(run, 'scorecard-a')).toEqual(run);
    expect(decisionAnalyticsRunForScorecard(null, 'scorecard-a')).toBeNull();
  });
});
