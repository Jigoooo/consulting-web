import { describe, expect, it, vi } from 'vitest';
import { createChatSendAttempt, isCurrentChatSendExecution, retryChatSendAttempt } from './chat-send-attempt.js';

describe('chat send attempt identity', () => {
  it('preserves the full request identity across a transport retry', () => {
    const createId = vi.fn(() => '30000000-0000-4000-8000-000000000010');
    const initial = createChatSendAttempt({
      threadId: '30000000-0000-4000-8000-000000000020',
      message: '첨부를 분석해줘',
      model: 'gpt-5.6',
      attachmentIds: ['30000000-0000-4000-8000-000000000011'],
    }, createId);

    const retry = retryChatSendAttempt(initial, initial.threadId);

    expect(retry).not.toBeNull();
    if (!retry) throw new Error('expected same-thread retry');
    expect(retry).toEqual(initial);
    expect(retry).not.toBe(initial);
    expect(retry.attachmentIds).not.toBe(initial.attachmentIds);
    expect(createId).toHaveBeenCalledOnce();
    expect(retryChatSendAttempt(initial, '30000000-0000-4000-8000-000000000021')).toBeNull();
  });

  it('allocates a new id for a new logical question', () => {
    const ids = [
      '30000000-0000-4000-8000-000000000012',
      '30000000-0000-4000-8000-000000000013',
    ];
    const createId = vi.fn(() => ids.shift()!);

    const first = createChatSendAttempt({
      threadId: '30000000-0000-4000-8000-000000000022',
      message: '첫 질문',
      attachmentIds: [],
    }, createId);
    const second = createChatSendAttempt({
      threadId: '30000000-0000-4000-8000-000000000022',
      message: '새 질문',
      attachmentIds: [],
    }, createId);

    expect(second.clientMessageId).not.toBe(first.clientMessageId);
    expect(createId).toHaveBeenCalledTimes(2);
  });

  it('fences stale async completion by both thread and execution generation', () => {
    const execution = {
      threadId: '30000000-0000-4000-8000-000000000030',
      generation: 4,
    };

    expect(isCurrentChatSendExecution(execution, execution.threadId, 4)).toBe(true);
    expect(isCurrentChatSendExecution(execution, '30000000-0000-4000-8000-000000000031', 4)).toBe(false);
    expect(isCurrentChatSendExecution(execution, execution.threadId, 5)).toBe(false);
  });
});
