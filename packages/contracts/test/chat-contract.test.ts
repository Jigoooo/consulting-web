import { describe, expect, it } from 'vitest';
import {
  ChatStreamEventSchema,
  ChatStreamRequestSchema,
  ChatStreamSseFrameSchema,
  ChatRuntimeModelsResponseSchema,
  ChatRuntimeCapabilitiesResponseSchema,
  ChatApprovalResponseRequestSchema,
  ListMessagesPageResponseSchema,
  SearchMessagesResponseSchema,
} from '../src/index.js';

const uuid = '00000000-0000-4000-8000-000000000001';

describe('chat stream contracts', () => {
  it('accepts strict chat stream requests', () => {
    const clean = { threadId: uuid, message: '안녕하세요', clientMessageId: uuid, model: 'gpt-5.5', attachmentIds: [uuid] };
    expect(ChatStreamRequestSchema.parse(clean)).toEqual(clean);
    expect(ChatStreamRequestSchema.parse({ threadId: uuid, message: '', attachmentIds: [uuid] })).toEqual({ threadId: uuid, message: '', attachmentIds: [uuid] });
    expect(() => ChatStreamRequestSchema.parse({ ...clean, extra: true })).toThrow();
    expect(() => ChatStreamRequestSchema.parse({ threadId: uuid, message: '' })).toThrow();
  });

  it('accepts strict SSE event frames only', () => {
    const start = { type: 'start', runId: 'run_hermes_123', threadId: uuid, ts: '2026-07-05T00:00:00.000Z' };
    const delta = { type: 'delta', runId: 'run_hermes_123', text: 'hello' };
    const done = { type: 'done', runId: 'run_hermes_123' };
    expect(ChatStreamEventSchema.parse(start)).toEqual(start);
    expect(ChatStreamEventSchema.parse(delta)).toEqual(delta);
    expect(ChatStreamEventSchema.parse(done)).toEqual(done);
    expect(() => ChatStreamEventSchema.parse({ ...delta, hermesApiKey: 123 })).toThrow();
    expect(ChatStreamSseFrameSchema.parse({ event: 'delta', data: delta })).toEqual({ event: 'delta', data: delta });
  });

  it('accepts approval and runtime control contracts', () => {
    const approval = { type: 'approval', runId: 'run_hermes_123', choices: ['once', 'deny'], command: 'echo ok' };
    expect(ChatStreamEventSchema.parse(approval)).toEqual(approval);
    expect(ChatStreamSseFrameSchema.parse({ event: 'approval', data: approval })).toEqual({ event: 'approval', data: approval });
    expect(ChatApprovalResponseRequestSchema.parse({ threadId: uuid, choice: 'once' })).toEqual({ threadId: uuid, choice: 'once' });
    expect(() => ChatApprovalResponseRequestSchema.parse({ threadId: uuid, choice: 'yes' })).toThrow();
  });

  it('accepts runtime model and capability payloads', () => {
    const models = {
      defaultModel: 'openai-codex:gpt-5.5',
      models: [{
        id: 'hermes-default',
        route: 'openai-codex:gpt-5.5',
        label: 'gpt-5.5 · openai-codex',
        provider: 'openai-codex',
        modelName: 'gpt-5.5',
        root: 'openai-codex/gpt-5.5',
        current: true,
      }],
    };
    expect(ChatRuntimeModelsResponseSchema.parse(models)).toEqual(models);
    const caps = { model: 'gpt-5.5', features: { modelRouting: true, runStop: true, runApprovalResponse: true, approvalEvents: true } };
    expect(ChatRuntimeCapabilitiesResponseSchema.parse(caps)).toEqual(caps);
  });

  it('accepts persisted chat messages with bound file attachments', () => {
    const message = {
      id: uuid,
      role: 'user',
      content: '첨부만 확인해주세요',
      authorUserId: uuid,
      authorName: '사용자',
      runId: null,
      finishState: 'complete',
      createdAt: '2026-07-05T00:00:00.000Z',
      attachments: [{
        id: uuid,
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        extraction: { status: 'processing', extractor: null, textChars: 0, qualityScore: 0, warnings: [] },
        uploaderUserId: uuid,
        createdAt: '2026-07-05T00:00:00.000Z',
      }],
    };
    const page = { messages: [message], hasOlder: false, hasNewer: false, olderCursor: uuid, newerCursor: uuid };
    expect(ListMessagesPageResponseSchema.parse(page)).toEqual(page);
  });

  it('accepts typed thread search results across messages, files, and evidence', () => {
    const payload = {
      results: [{ id: uuid, role: 'assistant', snippet: '창원 인구 근거', createdAt: '2026-07-05T00:00:00.000Z', matchKind: 'text' }],
      messages: [{ id: uuid, role: 'assistant', snippet: '창원 인구 근거', createdAt: '2026-07-05T00:00:00.000Z', matchKind: 'text' }],
      files: [{
        id: uuid,
        fileName: 'population.pdf',
        mimeType: 'application/pdf',
        snippet: '창원 인구 원문',
        messageId: uuid,
        status: 'indexed',
        createdAt: '2026-07-05T00:00:00.000Z',
      }],
      evidence: [{
        id: uuid,
        sourceType: 'web',
        ref: 'kosis',
        snippet: '창원 인구 통계',
        url: 'https://example.com',
        messageId: uuid,
        runId: 'run_1',
        createdAt: '2026-07-05T00:00:00.000Z',
      }],
    };
    expect(SearchMessagesResponseSchema.parse(payload)).toEqual(payload);
  });
});
