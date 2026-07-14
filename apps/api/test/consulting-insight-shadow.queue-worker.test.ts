import { describe, expect, it, vi } from 'vitest';
import { CONSULTING_INSIGHT_SHADOW_REQUESTED_EVENT } from '../src/queues/outbox-routing.js';
import { ConsultingInsightShadowWorker } from '../src/consulting/consulting-insight-shadow.worker.js';

describe('ConsultingInsightShadowWorker queue envelope', () => {
  it('passes exact envelope provenance into the replay service', async () => {
    const process = vi.fn(async () => 'completed' as const);
    const worker = new ConsultingInsightShadowWorker({
      CONSULTING_INSIGHT_WEB_SHADOW_MODE: 'off', REDIS_URL: 'redis://127.0.0.1:6379',
    } as never, { process } as never);
    const payload = {
      shadowTurnId: '11111111-1111-4111-8111-111111111111',
      settlementId: '22222222-2222-4222-8222-222222222222',
      retrievalRunId: '33333333-3333-4333-8333-333333333333',
      assistantMessageId: '44444444-4444-4444-8444-444444444444',
    };
    await worker.processOutboxJob({
      eventType: CONSULTING_INSIGHT_SHADOW_REQUESTED_EVENT,
      workspaceId: '55555555-5555-4555-8555-555555555555',
      aggregateType: 'thread',
      aggregateId: '66666666-6666-4666-8666-666666666666',
      payload,
    });
    expect(process).toHaveBeenCalledWith(payload.shadowTurnId, {
      workspaceId: '55555555-5555-4555-8555-555555555555',
      threadId: '66666666-6666-4666-8666-666666666666',
      settlementId: payload.settlementId,
      retrievalRunId: payload.retrievalRunId,
      assistantMessageId: payload.assistantMessageId,
    });
  });

  it('rejects foreign event types before processing', async () => {
    const process = vi.fn();
    const worker = new ConsultingInsightShadowWorker({
      CONSULTING_INSIGHT_WEB_SHADOW_MODE: 'off', REDIS_URL: 'redis://127.0.0.1:6379',
    } as never, { process } as never);
    await expect(worker.processOutboxJob({
      eventType: 'ForeignEvent', workspaceId: 'ws', aggregateType: 'thread', aggregateId: 'thread', payload: {},
    })).rejects.toThrow(/unsupported/iu);
    expect(process).not.toHaveBeenCalled();
  });
});
