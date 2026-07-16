import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ChatStreamController } from '../src/chat/chat-stream.controller.js';

const USER_ID = '30000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = '30000000-0000-4000-8000-000000000002';
const PROJECT_ID = '30000000-0000-4000-8000-000000000003';
const THREAD_ID = '30000000-0000-4000-8000-000000000004';
const CLIENT_MESSAGE_ID = '30000000-0000-4000-8000-000000000006';

class FakeResponse extends EventEmitter {
  writableEnded = false;
  status = vi.fn(() => this);
  setHeader = vi.fn(() => this);
  write = vi.fn((_value?: unknown) => true);
  end = vi.fn(() => {
    this.writableEnded = true;
    return this;
  });
}

describe('ChatStreamController durable settlement', () => {
  it('claims idempotency before GraphRAG work and replays an existing turn without Hermes', async () => {
    const response = new FakeResponse();
    const memoryContext = { build: vi.fn(async () => { throw new Error('duplicate retrieval must not run'); }) };
    const hermes = { streamChat: vi.fn() };
    const settlements = {
      beginCapture: vi.fn(async () => ({
        state: 'existing' as const,
        settlement: {
          id: '30000000-0000-4000-8000-000000000007',
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          userMessageId: '30000000-0000-4000-8000-000000000008',
          assistantMessageId: '30000000-0000-4000-8000-000000000009',
          requestedByUserId: USER_ID,
          userPrompt: '질문',
          userText: '질문',
          assistantText: '기존 답변\nMEDIA:/home/jigoo/hermes-work/report.pdf',
          runId: 'run_existing',
          finishState: 'complete',
          toolUses: [],
          status: 'completed',
        },
      })),
    };
    const controller = new (ChatStreamController as any)(
      { canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) },
      hermes,
      {},
      {},
      {},
      {},
      memoryContext,
      {},
      settlements,
    ) as ChatStreamController;

    await controller.stream(
      { threadId: THREAD_ID, message: '질문', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    );

    expect(settlements.beginCapture).toHaveBeenCalledOnce();
    expect(memoryContext.build).not.toHaveBeenCalled();
    expect(hermes.streamChat).not.toHaveBeenCalled();
    const writes = response.write.mock.calls.flat().map(String).join('');
    expect(writes).toContain('기존 답변');
    expect(writes).toContain('📎 report.pdf');
    expect(writes).not.toContain('/home/jigoo');
    expect(writes).toContain('event: done');
  });

  it('settles GraphRAG preparation failures and emits a structured SSE error', async () => {
    const response = new FakeResponse();
    const hermes = { streamChat: vi.fn() };
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({
        state: 'started' as const,
        leaseToken: 'capture-lease',
        userMessageId: snapshot.userMessageId,
      })),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => undefined),
    };
    const controller = new (ChatStreamController as any)(
      { canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) },
      hermes,
      {},
      {},
      {},
      {},
      { build: vi.fn(async () => { throw new Error('GraphRAG unavailable'); }) },
      {},
      settlements,
    ) as ChatStreamController;

    await controller.stream(
      { threadId: THREAD_ID, message: '질문', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    );

    expect(hermes.streamChat).not.toHaveBeenCalled();
    expect(settlements.finalizeCapture).toHaveBeenCalledWith(
      expect.objectContaining({ finishState: 'error', assistantText: '' }),
      'capture-lease',
    );
    const writes = response.write.mock.calls.flat().map(String).join('');
    expect(writes).toContain('event: error');
    expect(writes).toContain('CHAT_STREAM_FAILED');
  });

  it('prepares GraphRAG and Hermes concurrently before starting the run', async () => {
    const response = new FakeResponse();
    let resolveMemory: ((value: {
      context: string;
      scope: null;
      retrieval: null;
      shadowEligible: false;
      ineligibleReason: 'builder_error';
    }) => void) | undefined;
    let resolvePreflight: ((value: { runId: string; toolInventoryHash: string }) => void) | undefined;
    const memoryContext = {
      buildBundle: vi.fn(() => new Promise((resolve) => { resolveMemory = resolve; })),
    };
    const hermes = {
      prepareChatRun: vi.fn(() => new Promise((resolve) => { resolvePreflight = resolve; })),
      streamChat: vi.fn(async function* (
        _cmd: unknown,
        _scope: unknown,
        _signal: AbortSignal,
        prepared: { runId: string; toolInventoryHash: string },
      ) {
        yield { type: 'start', runId: prepared.runId, threadId: THREAD_ID, ts: new Date().toISOString() };
        yield { type: 'done', runId: prepared.runId };
      }),
    };
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({
        state: 'started' as const,
        leaseToken: 'capture-lease',
        userMessageId: snapshot.userMessageId,
      })),
      checkpointCapture: vi.fn(async () => undefined),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => undefined),
    };
    const controller = new (ChatStreamController as any)(
      { canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) },
      hermes,
      {},
      {},
      {},
      {},
      memoryContext,
      { createRuntimeApproval: vi.fn() },
      settlements,
    ) as ChatStreamController;

    const running = controller.stream(
      { threadId: THREAD_ID, message: '병렬 준비', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    );
    await vi.waitFor(() => {
      expect(memoryContext.buildBundle).toHaveBeenCalledOnce();
      expect(hermes.prepareChatRun).toHaveBeenCalledOnce();
    });

    resolveMemory?.({
      context: 'memory',
      scope: null,
      retrieval: null,
      shadowEligible: false,
      ineligibleReason: 'builder_error',
    });
    resolvePreflight?.({ runId: 'run_prepared', toolInventoryHash: 'a'.repeat(64) });
    await running;

    expect(hermes.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ message: '병렬 준비' }),
      expect.objectContaining({ memoryContext: 'memory' }),
      expect.any(AbortSignal),
      { runId: 'run_prepared', toolInventoryHash: 'a'.repeat(64) },
    );
  });

  it('aborts and reaps the sibling preparation branch before settling a failed preflight', async () => {
    const response = new FakeResponse();
    let preflightSignal: AbortSignal | undefined;
    const memoryContext = {
      buildBundle: vi.fn(() => new Promise(() => undefined)),
    };
    const hermes = {
      prepareChatRun: vi.fn((_workspaceId: string, signal: AbortSignal) => {
        preflightSignal = signal;
        return Promise.reject(new Error('preflight unavailable'));
      }),
      streamChat: vi.fn(),
    };
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({
        state: 'started' as const,
        leaseToken: 'capture-lease',
        userMessageId: snapshot.userMessageId,
      })),
      checkpointCapture: vi.fn(async () => undefined),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => undefined),
    };
    const controller = new (ChatStreamController as any)(
      { canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) },
      hermes,
      {},
      {},
      {},
      {},
      memoryContext,
      { createRuntimeApproval: vi.fn() },
      settlements,
    ) as ChatStreamController;

    let finished = false;
    const running = controller.stream(
      { threadId: THREAD_ID, message: '실패 수명주기', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    ).then(() => { finished = true; });
    await vi.waitFor(() => expect(hermes.prepareChatRun).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(preflightSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 1_000 });
    await running;

    expect(hermes.streamChat).not.toHaveBeenCalled();
    expect(settlements.finalizeCapture).toHaveBeenCalledOnce();
  });

  it('does not resume approval SSE delivery after a client disconnect', async () => {
    const response = new FakeResponse();
    const approvals = {
      createRuntimeApproval: vi.fn(() => new Promise(() => undefined)),
    };
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({
        state: 'started' as const,
        leaseToken: 'capture-lease',
        userMessageId: snapshot.userMessageId,
      })),
      checkpointCapture: vi.fn(async () => undefined),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => undefined),
    };
    const controller = new (ChatStreamController as any)(
      { canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) },
      {
        streamChat: vi.fn(async function* () {
          yield { type: 'start', runId: 'run_disconnect_approval', threadId: THREAD_ID, ts: new Date().toISOString() };
          yield {
            type: 'approval',
            runId: 'run_disconnect_approval',
            message: '승인이 필요합니다.',
            choices: ['once', 'deny'],
          };
          yield { type: 'done', runId: 'run_disconnect_approval' };
        }),
      },
      {},
      {},
      {},
      {},
      { buildBundle: vi.fn(async () => ({ context: '', scope: null, retrieval: null, shadowEligible: false, ineligibleReason: 'builder_error' })) },
      approvals,
      settlements,
    ) as ChatStreamController;

    const running = controller.stream(
      { threadId: THREAD_ID, message: '승인 중 종료', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    );
    await vi.waitFor(() => expect(approvals.createRuntimeApproval).toHaveBeenCalledOnce());
    const writesBeforeClose = response.write.mock.calls.length;
    response.emit('close');
    await expect(running).resolves.toBeUndefined();

    expect(response.write.mock.calls.length).toBe(writesBeforeClose);
    expect(settlements.finalizeCapture).toHaveBeenCalledWith(
      expect.objectContaining({ finishState: 'cancelled' }),
      'capture-lease',
    );
  });

  it('writes SSE before a slow durable checkpoint completes', async () => {
    const response = new FakeResponse();
    let resolveCheckpoint: (() => void) | undefined;
    let checkpointCalls = 0;
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({
        state: 'started' as const,
        leaseToken: 'capture-lease',
        userMessageId: snapshot.userMessageId,
      })),
      checkpointCapture: vi.fn(() => {
        checkpointCalls += 1;
        if (checkpointCalls > 1) return Promise.resolve();
        return new Promise<void>((resolve) => { resolveCheckpoint = resolve; });
      }),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => undefined),
    };
    const controller = new (ChatStreamController as any)(
      { canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) },
      {
        streamChat: vi.fn(async function* () {
          yield { type: 'start', runId: 'run_sse_first', threadId: THREAD_ID, ts: new Date().toISOString() };
          yield { type: 'delta', runId: 'run_sse_first', text: '즉시 보이는 답변' };
          yield { type: 'done', runId: 'run_sse_first' };
        }),
      },
      {},
      {},
      {},
      {},
      { buildBundle: vi.fn(async () => ({ context: '', scope: null, retrieval: null, shadowEligible: false, ineligibleReason: 'builder_error' })) },
      { createRuntimeApproval: vi.fn() },
      settlements,
    ) as ChatStreamController;

    const running = controller.stream(
      { threadId: THREAD_ID, message: 'SSE 우선', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    );
    await vi.waitFor(() => expect(settlements.checkpointCapture).toHaveBeenCalledOnce());
    try {
      const writes = response.write.mock.calls.flat().map(String).join('');
      expect(writes).toContain('event: start');
      expect(writes).toContain('즉시 보이는 답변');
    } finally {
      resolveCheckpoint?.();
      await running;
    }
  });

  it('coalesces a short delta burst into one checkpoint write', async () => {
    const response = new FakeResponse();
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({
        state: 'started' as const,
        leaseToken: 'capture-lease',
        userMessageId: snapshot.userMessageId,
      })),
      checkpointCapture: vi.fn(async () => undefined),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => undefined),
    };
    const controller = new (ChatStreamController as any)(
      { canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) },
      {
        streamChat: vi.fn(async function* () {
          yield { type: 'start', runId: 'run_burst', threadId: THREAD_ID, ts: new Date().toISOString() };
          for (let index = 0; index < 10; index += 1) {
            yield { type: 'delta', runId: 'run_burst', text: `조각-${index}` };
          }
          yield { type: 'done', runId: 'run_burst' };
        }),
      },
      {},
      {},
      {},
      {},
      { buildBundle: vi.fn(async () => ({ context: '', scope: null, retrieval: null, shadowEligible: false, ineligibleReason: 'builder_error' })) },
      { createRuntimeApproval: vi.fn() },
      settlements,
    ) as ChatStreamController;
    const runtimeLog = vi.fn();
    (controller as any).logger.log = runtimeLog;

    await controller.stream(
      { threadId: THREAD_ID, message: 'delta burst', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    );

    expect(settlements.checkpointCapture).toHaveBeenCalledOnce();
    expect(settlements.finalizeCapture).toHaveBeenCalledOnce();
    expect(response.write.mock.calls.flat().map(String).join('')).toContain('조각-9');
    expect(runtimeLog).toHaveBeenCalledOnce();
    const metrics = JSON.parse(String(runtimeLog.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(metrics).toMatchObject({
      event: 'chat_stream_runtime',
      checkpointScheduled: 11,
      checkpointWrites: 1,
      checkpointFailed: false,
      finishState: 'complete',
      clientAborted: false,
      streamFailed: false,
      settlementFailed: false,
    });
    expect(metrics.sseEvents).toBe(3);
    expect(metrics.firstSseMs).toEqual(expect.any(Number));
    expect(metrics.totalMs).toEqual(expect.any(Number));
    for (const key of ['totalMs', 'preparationMs', 'memoryMs', 'preflightMs', 'firstSseMs']) {
      expect(Number(metrics[key])).toBeGreaterThanOrEqual(0);
    }
  });

  it('requests one atomic settlement after streaming and does not run downstream side effects inline', async () => {
    const usecase = {
      canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })),
    };
    const response = new FakeResponse();
    const order: string[] = [];
    response.write.mockImplementation((value: unknown) => {
      if (String(value).includes('"type":"delta"')) order.push('write:delta');
      return true;
    });
    const hermes = {
      streamChat: vi.fn(async function* () {
        yield { type: 'start', runId: 'run_settle_controller', threadId: THREAD_ID, ts: new Date().toISOString() };
        yield { type: 'delta', runId: 'run_settle_controller', text: '정착된 답변\nMEDIA:/home/ji' };
        yield { type: 'delta', runId: 'run_settle_controller', text: 'goo/hermes-work/report.pdf\n끝' };
        yield { type: 'done', runId: 'run_settle_controller' };
      }),
    };
    const messages = {};
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({ state: 'started' as const, leaseToken: 'capture-lease', userMessageId: snapshot.userMessageId })),
      checkpointCapture: vi.fn(async (snapshot: { assistantText: string }) => {
        order.push(`checkpoint:${snapshot.assistantText}`);
      }),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => undefined),
    };
    const evidence = { saveRunEvidence: vi.fn() };
    const decisions = { recordCompletedAnswer: vi.fn() };
    const memoryContext = { build: vi.fn(async () => '') };
    const approvals = { createRuntimeApproval: vi.fn() };
    const controller = new (ChatStreamController as any)(
      usecase,
      hermes,
      messages,
      evidence,
      {},
      decisions,
      memoryContext,
      approvals,
      settlements,
    ) as ChatStreamController;
    Object.assign(controller as any, {
      evidence,
      evidenceDecision: decisions,
      memoryContext,
      approvals,
    });

    await controller.stream(
      { threadId: THREAD_ID, message: '질문', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    );

    expect(settlements.beginCapture).toHaveBeenCalledTimes(1);
    const initialCapture = settlements.beginCapture.mock.calls[0]![0];
    expect(initialCapture).toEqual(expect.objectContaining({ clientMessageId: CLIENT_MESSAGE_ID }));
    expect(settlements.finalizeCapture).toHaveBeenCalledTimes(1);
    expect(settlements.finalizeCapture).toHaveBeenCalledWith(expect.objectContaining({
      userMessageId: initialCapture.userMessageId,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      requestedByUserId: USER_ID,
      userPrompt: '질문',
      userText: '질문',
      assistantText: '정착된 답변\n📎 report.pdf — 원래 대화 환경에 저장된 파일이라 웹에서 바로 열 수 없습니다. 이 채널에 다시 첨부해 주세요.\n끝',
      runId: 'run_settle_controller',
      finishState: 'complete',
    }), 'capture-lease');
    expect(order.indexOf('write:delta')).toBeGreaterThanOrEqual(0);
    expect(order.findIndex((item) => item.startsWith('checkpoint:정착된 답변')))
      .toBeGreaterThan(order.indexOf('write:delta'));
    const writes = response.write.mock.calls.flat().map(String).join('');
    expect(writes).toContain('📎 report.pdf');
    expect(writes).toContain('끝');
    expect(writes).not.toContain('/home/jigoo');
    expect(evidence.saveRunEvidence).not.toHaveBeenCalled();
    expect(decisions.recordCompletedAnswer).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalledOnce();
  });

  it('keeps a completed upstream answer complete when the transport closes before final persistence', async () => {
    const response = new FakeResponse();
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({ state: 'started' as const, leaseToken: 'capture-lease', userMessageId: snapshot.userMessageId })),
      checkpointCapture: vi.fn(async () => undefined),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => undefined),
    };
    const hermes = {
      streamChat: vi.fn(async function* () {
        yield { type: 'start', runId: 'run_done_close', threadId: THREAD_ID, ts: new Date().toISOString() };
        yield { type: 'delta', runId: 'run_done_close', text: '완성 답변' };
        yield { type: 'done', runId: 'run_done_close' };
        response.emit('close');
      }),
    };
    const controller = new (ChatStreamController as any)(
      { canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) },
      hermes,
      {},
      {},
      {},
      {},
      { build: vi.fn(async () => '') },
      { createRuntimeApproval: vi.fn() },
      settlements,
    ) as ChatStreamController;

    await controller.stream(
      { threadId: THREAD_ID, message: '질문', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    );

    expect(settlements.finalizeCapture).toHaveBeenCalledOnce();
    expect(settlements.finalizeCapture).toHaveBeenCalledWith(expect.objectContaining({
      assistantText: '완성 답변',
      runId: 'run_done_close',
      finishState: 'complete',
    }), 'capture-lease');
  });

  it('aborts upstream and durably settles the partial answer as cancelled on client disconnect', async () => {
    const usecase = {
      canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })),
    };
    const response = new FakeResponse();
    let upstreamSignal: AbortSignal | undefined;
    const hermes = {
      streamChat: vi.fn(async function* (_command: unknown, _scope: unknown, signal?: AbortSignal) {
        upstreamSignal = signal;
        yield { type: 'start', runId: 'run_cancelled', threadId: THREAD_ID, ts: new Date().toISOString() };
        yield { type: 'delta', runId: 'run_cancelled', text: '부분 답변' };
        response.emit('close');
        if (!signal?.aborted) yield { type: 'done', runId: 'run_cancelled' };
      }),
    };
    const messages = {};
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({ state: 'started' as const, leaseToken: 'capture-lease', userMessageId: snapshot.userMessageId })),
      checkpointCapture: vi.fn(async () => undefined),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => undefined),
    };
    const controller = new (ChatStreamController as any)(
      usecase,
      hermes,
      messages,
      { saveRunEvidence: vi.fn() },
      {},
      { recordCompletedAnswer: vi.fn() },
      { build: vi.fn(async () => '') },
      { createRuntimeApproval: vi.fn() },
      settlements,
    ) as ChatStreamController;

    await controller.stream(
      { threadId: THREAD_ID, message: '질문', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    );

    expect(upstreamSignal?.aborted).toBe(true);
    expect(settlements.finalizeCapture).toHaveBeenCalledTimes(1);
    expect(settlements.finalizeCapture).toHaveBeenCalledWith(expect.objectContaining({
      assistantText: '부분 답변',
      runId: 'run_cancelled',
      finishState: 'cancelled',
    }), 'capture-lease');
    expect(response.end).not.toHaveBeenCalled();
  });

  it('emits durable done when terminal finalization supersedes a failed checkpoint', async () => {
    const response = new FakeResponse();
    let signalCheckpointStarted: (() => void) | undefined;
    const checkpointStarted = new Promise<void>((resolve) => { signalCheckpointStarted = resolve; });
    let upstreamSignal: AbortSignal | undefined;
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({
        state: 'started' as const,
        leaseToken: 'capture-lease',
        userMessageId: snapshot.userMessageId,
      })),
      checkpointCapture: vi.fn(async () => {
        signalCheckpointStarted?.();
        throw new Error('checkpoint unavailable');
      }),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => undefined),
    };
    const controller = new (ChatStreamController as any)(
      { canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) },
      {
        streamChat: vi.fn(async function* (_command: unknown, _scope: unknown, signal?: AbortSignal) {
          upstreamSignal = signal;
          yield { type: 'start', runId: 'run_checkpoint_done', threadId: THREAD_ID, ts: new Date().toISOString() };
          yield { type: 'delta', runId: 'run_checkpoint_done', text: '완료'.repeat(700) };
          await checkpointStarted;
          await new Promise((resolve) => setTimeout(resolve, 0));
          yield { type: 'done', runId: 'run_checkpoint_done' };
        }),
      },
      {},
      {},
      {},
      {},
      { buildBundle: vi.fn(async () => ({ context: '', scope: null, retrieval: null, shadowEligible: false, ineligibleReason: 'builder_error' })) },
      { createRuntimeApproval: vi.fn() },
      settlements,
    ) as ChatStreamController;
    const runtimeLog = vi.fn();
    (controller as any).logger.log = runtimeLog;

    await controller.stream(
      { threadId: THREAD_ID, message: 'checkpoint 경합', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    );

    expect(upstreamSignal?.aborted).toBe(true);
    expect(settlements.finalizeCapture).toHaveBeenCalledWith(
      expect.objectContaining({ finishState: 'complete', runId: 'run_checkpoint_done' }),
      'capture-lease',
    );
    const writes = response.write.mock.calls.flat().map(String).join('');
    expect(writes).toContain('event: done');
    expect(writes).not.toContain('CHAT_STREAM_FAILED');
    const metrics = JSON.parse(String(runtimeLog.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(metrics).toMatchObject({
      checkpointFailed: true,
      finishState: 'complete',
      streamFailed: false,
      settlementFailed: false,
    });
  });

  it('never emits a successful done event when durable settlement fails', async () => {
    const response = new FakeResponse();
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({ state: 'started' as const, leaseToken: 'capture-lease', userMessageId: snapshot.userMessageId })),
      checkpointCapture: vi.fn(async () => undefined),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    };
    const controller = new (ChatStreamController as any)(
      { canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) },
      {
        streamChat: vi.fn(async function* () {
          yield { type: 'start', runId: 'run_settlement_failure', threadId: THREAD_ID, ts: new Date().toISOString() };
          yield { type: 'delta', runId: 'run_settlement_failure', text: '보이면 안 되는 완료' };
          yield { type: 'done', runId: 'run_settlement_failure' };
        }),
      },
      {},
      { saveRunEvidence: vi.fn() },
      {},
      { recordCompletedAnswer: vi.fn() },
      { build: vi.fn(async () => '') },
      { createRuntimeApproval: vi.fn() },
      settlements,
    ) as ChatStreamController;

    await expect(controller.stream(
      { threadId: THREAD_ID, message: '질문', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    )).rejects.toThrow('database unavailable');

    const writes = response.write.mock.calls.flat().map(String);
    expect(writes).not.toContain('event: done\n');
    expect(writes).toContain('event: error\n');
    expect(writes.some((value) => value.includes('CHAT_SETTLEMENT_FAILED'))).toBe(true);
    expect(response.end).toHaveBeenCalledOnce();
  });

  it('settles and reports an upstream EOF without a terminal event as an error', async () => {
    const response = new FakeResponse();
    const settlements = {
      beginCapture: vi.fn(async (snapshot: { userMessageId: string }) => ({ state: 'started' as const, leaseToken: 'capture-lease', userMessageId: snapshot.userMessageId })),
      checkpointCapture: vi.fn(async () => undefined),
      heartbeatCapture: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => undefined),
    };
    const controller = new (ChatStreamController as any)(
      { canSendThread: vi.fn(async () => ({ status: 'ok', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) },
      {
        streamChat: vi.fn(async function* () {
          yield { type: 'start', runId: 'run_eof', threadId: THREAD_ID, ts: new Date().toISOString() };
          yield { type: 'delta', runId: 'run_eof', text: '끝나지 않은 답변' };
        }),
      },
      {},
      {},
      {},
      {},
      { build: vi.fn(async () => '') },
      { createRuntimeApproval: vi.fn() },
      settlements,
    ) as ChatStreamController;

    await controller.stream(
      { threadId: THREAD_ID, message: '질문', clientMessageId: CLIENT_MESSAGE_ID },
      { authUserId: USER_ID } as never,
      response as never,
    );

    expect(settlements.finalizeCapture).toHaveBeenCalledWith(expect.objectContaining({
      assistantText: '끝나지 않은 답변',
      runId: 'run_eof',
      finishState: 'error',
    }), 'capture-lease');
    const writes = response.write.mock.calls.flat().map(String).join('');
    expect(writes).toContain('event: error');
    expect(writes).toContain('CHAT_STREAM_FAILED');
    expect(writes).not.toContain('event: done');
  });
});
