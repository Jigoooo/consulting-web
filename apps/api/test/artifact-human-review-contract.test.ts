import { describe, expect, it } from 'vitest';
import { ArtifactReviewDecisionSchema } from '@consulting/contracts';

describe('artifact review decision audit contract', () => {
  it('exposes the immutable sequence and hash-chain provenance', () => {
    expect(ArtifactReviewDecisionSchema.safeParse({
      id: '85000000-0000-4000-8000-000000000001',
      sequenceNo: 7,
      action: 'approve',
      note: '',
      actorKind: 'user',
      decidedByUserId: '85000000-0000-4000-8000-000000000002',
      contentHash: 'a'.repeat(64),
      previousHash: 'b'.repeat(64),
      eventHash: 'c'.repeat(64),
      decidedAt: '2026-07-14T00:00:00.000Z',
    }).success).toBe(true);
  });

  it('accepts only identity pairs that match the actor kind', () => {
    const base = {
      id: '85000000-0000-4000-8000-000000000001',
      sequenceNo: 1,
      action: 'approve' as const,
      note: '',
      contentHash: 'a'.repeat(64),
      previousHash: null,
      eventHash: 'c'.repeat(64),
      decidedAt: '2026-07-14T00:00:00.000Z',
    };
    expect(ArtifactReviewDecisionSchema.safeParse({
      ...base, actorKind: 'legacy_unknown', decidedByUserId: null,
    }).success).toBe(true);
    expect(ArtifactReviewDecisionSchema.safeParse({
      ...base, actorKind: 'legacy_unknown', decidedByUserId: '85000000-0000-4000-8000-000000000002',
    }).success).toBe(false);
    expect(ArtifactReviewDecisionSchema.safeParse({
      ...base, actorKind: 'user', decidedByUserId: null,
    }).success).toBe(false);
  });
});
