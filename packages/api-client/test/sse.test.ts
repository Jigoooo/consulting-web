import { describe, expect, it } from 'vitest';
import { parseChatSseText, readChatSseStream } from '../src/sse.js';
import { ApiClientError } from '../src/http-core.js';

const uuid = '00000000-0000-4000-8000-000000000001';

function sseFrame(event: unknown): string {
  const e = event as { type: string };
  return `event: ${e.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

describe('parseChatSseText', () => {
  it('parses a start/delta/done sequence into strict events', () => {
    const text =
      sseFrame({ type: 'start', runId: 'run_abc', threadId: uuid, ts: '2026-07-05T00:00:00.000Z' }) +
      sseFrame({ type: 'delta', runId: 'run_abc', text: 'hello' }) +
      sseFrame({ type: 'done', runId: 'run_abc' });
    const events = parseChatSseText(text);
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'done']);
    expect((events[1] as { text: string }).text).toBe('hello');
  });

  it('skips comment/keepalive frames and malformed json', () => {
    const text =
      ': keepalive\n\n' +
      'data: not-json\n\n' +
      sseFrame({ type: 'done', runId: 'run_abc' });
    const events = parseChatSseText(text);
    expect(events.map((e) => e.type)).toEqual(['done']);
  });

  it('drops frames that violate the event contract', () => {
    const text = 'data: {"type":"delta","runId":"run_abc","text":123}\n\n';
    expect(parseChatSseText(text)).toEqual([]);
  });
});

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('readChatSseStream', () => {
  it('reassembles events split across chunk boundaries', async () => {
    const full =
      sseFrame({ type: 'start', runId: 'run_abc', threadId: uuid, ts: '2026-07-05T00:00:00.000Z' }) +
      sseFrame({ type: 'delta', runId: 'run_abc', text: 'partial' }) +
      sseFrame({ type: 'done', runId: 'run_abc' });
    // Split mid-frame to prove buffering works.
    const mid = Math.floor(full.length / 2);
    const response = streamResponse([full.slice(0, mid), full.slice(mid)]);

    const seen: string[] = [];
    for await (const event of readChatSseStream(response)) {
      seen.push(event.type);
    }
    expect(seen).toEqual(['start', 'delta', 'done']);
  });
});

describe('ApiClientError', () => {
  it('exposes the machine code and status', () => {
    const err = new ApiClientError(403, { code: 'FORBIDDEN', message: 'denied' });
    expect(err.code).toBe('FORBIDDEN');
    expect(err.status).toBe(403);
    expect(err.message).toBe('denied');
  });
});
