import { describe, expect, it } from 'vitest';
import {
  artifactReviewDecisionHash,
  evaluateArtifactReviewLedger,
  type ArtifactReviewLedgerRow,
} from '../src/artifacts/artifact-human-review.service.js';

const target = {
  workspaceId: '81000000-0000-4000-8000-000000000002',
  projectId: '81000000-0000-4000-8000-000000000003',
  artifactId: '81000000-0000-4000-8000-000000000004',
  artifactVersionId: '81000000-0000-4000-8000-000000000005',
};
const actor = '81000000-0000-4000-8000-000000000001';
const contentHash = 'a'.repeat(64);

function row(
  sequenceNo: number,
  action: 'approve' | 'reject',
  previousHash: string | null,
  over: Partial<ArtifactReviewLedgerRow> = {},
): ArtifactReviewLedgerRow {
  const base = {
    id: `81000000-0000-4000-8000-${String(sequenceNo).padStart(12, '0')}`,
    sequenceNo,
    ...target,
    contentHash,
    action,
    note: action === 'reject' ? '반려 근거' : '',
    decidedByUserId: actor,
    previousHash,
    eventHash: '',
    createdAt: new Date(`2026-07-14T00:00:0${sequenceNo}.000Z`),
    ...over,
    actorKind: over.actorKind ?? 'user',
  } satisfies ArtifactReviewLedgerRow;
  return { ...base, eventHash: artifactReviewDecisionHash(base) };
}

describe('artifact human-review ledger evaluation', () => {
  it('matches the PostgreSQL v2 hash for a migrated legacy actor', () => {
    const postgresRow = {
      id: '92000000-0000-4000-8000-000000000006',
      sequenceNo: 1,
      workspaceId: '92000000-0000-4000-8000-000000000002',
      projectId: '92000000-0000-4000-8000-000000000003',
      artifactId: '92000000-0000-4000-8000-000000000004',
      artifactVersionId: '92000000-0000-4000-8000-000000000005',
      contentHash: 'b'.repeat(64),
      action: 'approve',
      note: 'mismatch',
      actorKind: 'legacy_unknown',
      decidedByUserId: null,
      previousHash: null,
      createdAt: new Date('2026-07-14T06:07:16.229Z'),
    } satisfies Omit<ArtifactReviewLedgerRow, 'eventHash'>;
    expect(artifactReviewDecisionHash(postgresRow)).toBe(
      '2dbb3fda52de550bcc5b6d55c8b12ef7f3e4f839ddb5c9470262a4c9b1b29513',
    );
  });

  it('fails closed instead of falling back when the latest row has a stale identity', () => {
    const first = row(1, 'approve', null);
    const stale = row(2, 'approve', first.eventHash, { contentHash: 'b'.repeat(64) });
    expect(evaluateArtifactReviewLedger(target, contentHash, [first, stale])).toEqual({ valid: false, decision: null });
  });

  it('fails closed when any immutable field breaks the hash chain', () => {
    const first = row(1, 'approve', null);
    expect(evaluateArtifactReviewLedger(target, contentHash, [{ ...first, note: 'tampered' }])).toEqual({ valid: false, decision: null });
  });

  it('keeps reject dominant even if legacy history contains a later approve', () => {
    const rejected = row(1, 'reject', null);
    const laterApprove = row(2, 'approve', rejected.eventHash);
    expect(evaluateArtifactReviewLedger(target, contentHash, [rejected, laterApprove])).toEqual({
      valid: true,
      decision: expect.objectContaining({ action: 'reject', id: rejected.id }),
    });
  });

  it('accepts a migrated legacy-unknown actor followed by a user actor', () => {
    const legacy = row(1, 'approve', null, { actorKind: 'legacy_unknown', decidedByUserId: null });
    const current = row(2, 'approve', legacy.eventHash);
    expect(evaluateArtifactReviewLedger(target, contentHash, [legacy, current])).toEqual({
      valid: true,
      decision: expect.objectContaining({ id: current.id, action: 'approve' }),
    });
  });

  it('fails closed when actor kind and user identity disagree', () => {
    const forged = row(1, 'approve', null, { actorKind: 'legacy_unknown', decidedByUserId: actor });
    expect(evaluateArtifactReviewLedger(target, contentHash, [forged])).toEqual({ valid: false, decision: null });
  });
});
