import { describe, expect, it } from 'vitest';
import {
  ChatStreamEventSchema,
  ChatStreamRequestSchema,
  ChatStreamSseFrameSchema,
} from '../src/index.js';

const uuid = '00000000-0000-0000-0000-000000000001';

describe('chat stream contracts', () => {
  it('accepts strict chat stream requests', () => {
    const clean = { threadId: uuid, message: '안녕하세요', clientMessageId: uuid };
    expect(ChatStreamRequestSchema.parse(clean)).toEqual(clean);
    expect(() => ChatStreamRequestSchema.parse({ ...clean, extra: true })).toThrow();
    expect(() => ChatStreamRequestSchema.parse({ threadId: uuid, message: '' })).toThrow();
  });

  it('accepts strict SSE event frames only', () => {
    const start = { type: 'start', runId: uuid, threadId: uuid, ts: '2026-07-05T00:00:00.000Z' };
    const delta = { type: 'delta', runId: uuid, text: 'hello' };
    const done = { type: 'done', runId: uuid };
    expect(ChatStreamEventSchema.parse(start)).toEqual(start);
    expect(ChatStreamEventSchema.parse(delta)).toEqual(delta);
    expect(ChatStreamEventSchema.parse(done)).toEqual(done);
    expect(() => ChatStreamEventSchema.parse({ ...delta, hermesApiKey: 'secret' })).toThrow();
    expect(ChatStreamSseFrameSchema.parse({ event: 'delta', data: delta })).toEqual({ event: 'delta', data: delta });
  });
});
