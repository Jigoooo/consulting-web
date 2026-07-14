import { describe, expect, it, vi } from 'vitest';
import { NotificationPushWorker } from '../src/chat/notification-push.worker.js';

const WORKSPACE_ID = '40000000-0000-4000-8000-000000000001';
const REF_ID = '40000000-0000-4000-8000-000000000002';
const SUBSCRIPTION_ID = '40000000-0000-4000-8000-000000000003';
const RECIPIENT_USER_ID = '40000000-0000-4000-8000-000000000004';

function job(eventType = 'NotificationPushRequested') {
  return {
    eventId: '40000000-0000-4000-8000-000000000004',
    eventType,
    workspaceId: WORKSPACE_ID,
    aggregateType: 'notification',
    aggregateId: REF_ID,
    payload: {
      subscriptionId: SUBSCRIPTION_ID,
      recipientUserId: RECIPIENT_USER_ID,
      title: '새 답변',
      body: '검증된 알림',
      url: `/th/${REF_ID}`,
      tag: 'settlement-1',
    },
  };
}

describe('NotificationPushWorker', () => {
  it('delivers a validated durable outbox payload', async () => {
    const push = { sendToSubscription: vi.fn(async () => undefined) };
    const worker = new NotificationPushWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      push as never,
    );

    await worker.processOutboxJob(job());

    expect(push.sendToSubscription).toHaveBeenCalledWith(SUBSCRIPTION_ID, RECIPIENT_USER_ID, {
      title: '새 답변',
      body: '검증된 알림',
      url: `/th/${REF_ID}`,
      tag: 'settlement-1',
    });
  });

  it('fails closed before push for an incompatible event', async () => {
    const push = { sendToSubscription: vi.fn() };
    const worker = new NotificationPushWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      push as never,
    );

    await expect(worker.processOutboxJob(job('WorkspaceCreated'))).rejects.toThrow(/unsupported outbox event/i);
    expect(push.sendToSubscription).not.toHaveBeenCalled();
  });
});
