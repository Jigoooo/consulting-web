import { ChatStreamEventSchema, type ChatStreamEvent } from '@consulting/contracts';

/**
 * Parse a raw SSE text buffer into strict ChatStreamEvent objects.
 * Frames are separated by a blank line; only `data:` lines carry JSON.
 * Non-JSON / comment frames (`: keepalive`) are skipped.
 */
export function parseChatSseText(text: string): ChatStreamEvent[] {
  const events: ChatStreamEvent[] = [];
  for (const frame of text.split('\n\n')) {
    const event = parseFrame(frame);
    if (event) events.push(event);
  }
  return events;
}

function parseFrame(frame: string): ChatStreamEvent | null {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  if (dataLines.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
  const parsed = ChatStreamEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Consume a streaming Response body and yield strict ChatStreamEvents as they
 * arrive. Buffers across chunk boundaries so a frame split mid-network still
 * parses. Works in browsers and Node (response.body is a WHATWG ReadableStream).
 */
export async function* readChatSseStream(response: Response): AsyncGenerator<ChatStreamEvent> {
  if (!response.body) {
    throw new Error('response has no readable body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
