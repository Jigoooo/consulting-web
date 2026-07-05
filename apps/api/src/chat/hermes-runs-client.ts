import { Inject, Injectable } from '@nestjs/common';
import type { ChatStreamEvent, ChatStreamRequest } from '@consulting/contracts';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';

interface HermesRunStartResponse {
  readonly run_id?: unknown;
  readonly status?: unknown;
}

interface HermesRunSseEvent {
  readonly event?: unknown;
  readonly run_id?: unknown;
  readonly delta?: unknown;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly tool?: unknown;
  readonly preview?: unknown;
}

@Injectable()
export class HermesRunsClient {
  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async *streamChat(cmd: ChatStreamRequest): AsyncGenerator<ChatStreamEvent> {
    let runId: string | undefined;
    try {
      runId = await this.startRun(cmd);
      yield { type: 'start', runId, threadId: cmd.threadId, ts: new Date().toISOString() };

      for await (const upstream of this.readRunEvents(runId)) {
        const eventType = typeof upstream.event === 'string' ? upstream.event : '';
        if (eventType === 'message.delta') {
          const text = typeof upstream.delta === 'string' ? upstream.delta : '';
          if (text) yield { type: 'delta', runId, text };
          continue;
        }
        if (eventType === 'tool.started' || eventType === 'tool.completed') {
          const tool = typeof upstream.tool === 'string' ? upstream.tool : '';
          if (tool) {
            const preview = typeof upstream.preview === 'string' ? upstream.preview.slice(0, 500) : undefined;
            yield {
              type: 'tool',
              runId,
              phase: eventType === 'tool.started' ? 'started' : 'completed',
              tool,
              ...(preview ? { preview } : {}),
            };
          }
          continue;
        }
        if (eventType === 'run.completed') {
          yield { type: 'done', runId };
          return;
        }
        if (eventType === 'run.failed') {
          yield {
            type: 'error',
            runId,
            code: 'HERMES_RUN_FAILED',
            message: this.safeErrorMessage(upstream.error, 'Hermes run failed'),
          };
          return;
        }
        if (eventType === 'run.cancelled') {
          yield { type: 'error', runId, code: 'HERMES_RUN_CANCELLED', message: 'Hermes run was cancelled' };
          return;
        }
      }

      yield { type: 'done', runId };
    } catch (error) {
      yield {
        type: 'error',
        ...(runId ? { runId } : {}),
        code: 'HERMES_PROXY_ERROR',
        message: this.safeErrorMessage(error, 'Hermes proxy failed'),
      };
    }
  }

  private async startRun(cmd: ChatStreamRequest): Promise<string> {
    const response = await fetch(this.url('/v1/runs'), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        input: cmd.message,
        session_id: `consulting-thread:${cmd.threadId}`,
      }),
    });
    if (!response.ok) {
      throw new Error(`Hermes run start failed (${response.status})`);
    }
    const body = await response.json() as HermesRunStartResponse;
    if (typeof body.run_id !== 'string' || body.run_id.length === 0) {
      throw new Error('Hermes run start returned invalid run_id');
    }
    return body.run_id;
  }

  private async *readRunEvents(runId: string): AsyncGenerator<HermesRunSseEvent> {
    const response = await fetch(this.url(`/v1/runs/${encodeURIComponent(runId)}/events`), {
      method: 'GET',
      headers: this.headers({ accept: 'text/event-stream' }),
    });
    if (!response.ok) {
      throw new Error(`Hermes run events failed (${response.status})`);
    }
    if (!response.body) {
      throw new Error('Hermes run events response body is empty');
    }

    let buffer = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = this.parseSseFrame(frame);
          if (parsed) yield parsed;
          boundary = buffer.indexOf('\n\n');
        }
      }
      buffer += decoder.decode();
      const parsed = this.parseSseFrame(buffer);
      if (parsed) yield parsed;
    } finally {
      reader.releaseLock();
    }
  }

  private parseSseFrame(frame: string): HermesRunSseEvent | null {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
    if (dataLines.length === 0) return null;
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as HermesRunSseEvent : null;
    } catch {
      return null;
    }
  }

  private url(path: string): string {
    return `${this.env.HERMES_API_BASE_URL.replace(/\/$/, '')}${path}`;
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      ...extra,
      authorization: `Bearer ${this.env.HERMES_API_KEY}`,
    };
  }

  private safeErrorMessage(error: unknown, fallback: string): string {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
    return raw
      .split(this.env.HERMES_API_KEY).join('[redacted]')
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
      .slice(0, 500);
  }
}
