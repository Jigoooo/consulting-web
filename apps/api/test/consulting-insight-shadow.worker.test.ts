import { describe, expect, it, vi } from 'vitest';
import { ConsultingInsightShadowWorkerService } from '../src/consulting/consulting-insight-shadow.worker.service.js';

describe('ConsultingInsightShadowWorkerService', () => {
  it('uses the tool-free strict profile and persisted evidence refs only', async () => {
    const completeReplay = vi.fn(async () => true);
    const store = {
      claimReplay: async () => ({
        state: 'claimed', leaseToken: 'lease', shadow: {}, query: '왜? owner@example.com',
        hits: [{ id: 'hit-1', rank: 1, hitKind: 'file', sourceTopicSlug: 'topic', sourceRelation: 'current', textPreview: '근거 010-1234-5678', linked: [] }],
      }),
      completeReplay,
      failReplay: vi.fn(async () => true),
    };
    const runStrictJsonTask = vi.fn(async (_input: Record<string, unknown>) => ({
      reviewerRunId: 'run', latencyMs: 1,
      rawJson: JSON.stringify({ candidates: [{ evidence_codes: ['retrieval_hit:hit-1'], claims: [] }] }),
    }));
    const worker = new ConsultingInsightShadowWorkerService(store as never, { runStrictJsonTask } as never);

    await expect(worker.process('shadow-1')).resolves.toBe('completed');
    expect(runStrictJsonTask).toHaveBeenCalledWith(expect.objectContaining({ profile: 'artifact-red-team', timeoutMs: 120_000 }));
    const prompt = runStrictJsonTask.mock.calls[0]?.[0].prompt as string;
    expect(prompt).not.toContain('owner@example.com');
    expect(prompt).not.toContain('010-1234-5678');
    expect(completeReplay).toHaveBeenCalledOnce();
  });

  it('rejects generated evidence refs outside the persisted snapshot allowlist', async () => {
    const failReplay = vi.fn(async () => true);
    const store = {
      claimReplay: async () => ({
        state: 'claimed', leaseToken: 'lease', shadow: {}, query: '왜?',
        hits: [{ id: 'hit-1', rank: 1, hitKind: 'file', sourceTopicSlug: 'topic', sourceRelation: 'current', textPreview: '근거', linked: [] }],
      }),
      completeReplay: vi.fn(async () => true),
      failReplay,
    };
    const verifier = {
      runStrictJsonTask: async () => ({ reviewerRunId: 'run', latencyMs: 1, rawJson: '{"candidates":[{"source_refs":["retrieval_hit:attacker"]}]}' }),
    };
    const worker = new ConsultingInsightShadowWorkerService(store as never, verifier as never);

    await expect(worker.process('shadow-1')).rejects.toThrow(/allowlist/iu);
    expect(failReplay).toHaveBeenCalledWith('shadow-1', 'lease', expect.stringMatching(/allowlist/iu));
  });
});
