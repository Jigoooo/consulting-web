import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesRunsClient } from '../src/chat/hermes-runs-client.js';
import type { Env } from '../src/config/env.schema.js';

const env: Env = {
  APP_ENV: 'test',
  APP_PUBLIC_URL: 'http://localhost:3000',
  PORT: 3000,
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(16),
  JWT_REFRESH_SECRET: 'y'.repeat(16),
  HERMES_API_BASE_URL: 'http://hermes.local',
  HERMES_API_KEY: 'test-key',
  CONSULTING_DEFAULT_TEMPLATE_ENABLED: true,
  VOYAGE_MULTIMODAL_ENABLED: false,
  VOYAGE_API_BASE_URL: 'https://api.voyageai.com',
  VOYAGE_MULTIMODAL_MODEL: 'voyage-multimodal-3.5',
  VERIFIER_LLM_ENABLED: false,
  VERIFIER_LLM_TIMEOUT_MS: 30_000,
  ARTIFACT_RED_TEAM_MODE: 'warning',
  ARTIFACT_RED_TEAM_TIMEOUT_MS: 45_000,
  REPORT_WORKFLOW_SHADOW_MODE: 'off',
  VAPID_SUBJECT: 'mailto:admin@localhost',
};
const clientMessageId = '00000000-0000-4000-8000-000000000099';
const inventoryHash = 'a'.repeat(64);

function toolsetInventory(data: Array<{ name: string; enabled: boolean }>) {
  const effectiveToolsets = data.filter((item) => item.enabled).map((item) => item.name.toLowerCase()).sort();
  return {
    object: 'list',
    platform: 'api_server',
    inventory_complete: true,
    inventory_hash: inventoryHash,
    effective_toolsets: effectiveToolsets,
    effective_tools: effectiveToolsets.map((name) => `${name}_fixture_tool`),
    data,
  };
}

describe('HermesRunsClient GraphRAG instructions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds consulting GraphRAG memory context to the run instructions', async () => {
    const requests: Array<{ url: string; body: string | null }> = [];
    let runId: string | undefined;
    const events = [
      'data: {"event":"message.delta","run_id":"run_graph","delta":"답"}',
      '',
      'data: {"event":"run.completed","run_id":"run_graph"}',
      '',
    ].join('\n');

    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === 'string' ? init.body : null;
      requests.push({ url, body });
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }, { name: 'mcp-github', enabled: false }])), { status: 200 });
      }
      if (url.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        runId = (JSON.parse(body ?? '{}') as { client_run_id?: string }).client_run_id;
        return new Response(JSON.stringify({ run_id: runId, status: 'started', tool_inventory_hash: inventoryHash }), { status: 202 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}`)) {
        return new Response(JSON.stringify({ model: 'test-model' }), { status: 200 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}/events`)) {
        return new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    });

    const client = new HermesRunsClient(env);
    const out = [];
    for await (const event of client.streamChat(
      { threadId: 'thread-1', clientMessageId, message: '정원 인건비 조직진단' },
      { workspaceId: 'ws-1', projectId: 'project-1', memoryContext: '## 기존 컨설팅 GraphRAG 참고 기억\nCL-D5-01 정원·인건비' },
    )) {
      out.push(event.type);
    }

    expect(out).toContain('done');
    for await (const _event of client.streamChat(
      { threadId: 'thread-2', clientMessageId: '00000000-0000-4000-8000-000000000098', message: '다른 스레드 질의' },
      { workspaceId: 'ws-1', projectId: 'project-1', memoryContext: '## 다른 exact scope' },
    )) {
      // Drain the second run so both start payloads are observable.
    }

    const starts = requests.filter((r) => r.url.endsWith('/v1/runs'));
    expect(starts).toHaveLength(2);
    expect(starts[0]?.body).toBeTruthy();
    expect(starts[1]?.body).toBeTruthy();
    const body = JSON.parse(starts[0]!.body!) as {
      client_run_id: string;
      instructions: string;
      session_id: string;
      tool_inventory_hash: string;
    };
    const siblingBody = JSON.parse(starts[1]!.body!) as { session_id: string };
    expect(body.client_run_id).toMatch(/^run_[0-9a-f]{32}$/);
    expect(body.tool_inventory_hash).toBe(inventoryHash);
    expect(body.session_id).toMatch(/^cw-thread:[a-f0-9]{40}$/);
    expect(body.session_id.length).toBeLessThanOrEqual(64);
    expect(siblingBody.session_id).toMatch(/^cw-thread:[a-f0-9]{40}$/);
    expect(siblingBody.session_id).not.toBe(body.session_id);
    expect(body.instructions).toContain('## 응답 형식 지침');
    expect(body.instructions).toContain('## 기존 컨설팅 GraphRAG 참고 기억');
    expect(body.instructions).toContain('CL-D5-01');
  });

  it('forwards selected model and normalizes approval/runtime controls', async () => {
    const requests: Array<{ url: string; body: string | null; method: string | undefined }> = [];
    let streamedRunId: string | undefined;
    const events = [
      'data: {"event":"tool.started","run_id":"run_runtime","tool":"terminal","preview":"call 010-1234-5678 api_key=sk-secret"}',
      '',
      'data: {"event":"approval.request","run_id":"run_runtime","choices":["always","once","session","deny"],"command":"echo 010-1234-5678 api_key=sk-secret"}',
      '',
      'data: {"event":"approval.request","run_id":"run_runtime","choices":["session","bogus"],"pattern_key":"file","command":"cat report.txt"}',
      '',
      'data: {"event":"run.completed","run_id":"run_runtime","usage":{"total_tokens":7}}',
      '',
    ].join('\n');

    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === 'string' ? init.body : null;
      requests.push({ url, body, method: init?.method });
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }, { name: 'terminal', enabled: true }])), { status: 200 });
      }
      if (url.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        streamedRunId = (JSON.parse(body ?? '{}') as { client_run_id?: string }).client_run_id;
        return new Response(JSON.stringify({ run_id: streamedRunId, status: 'started', tool_inventory_hash: inventoryHash }), { status: 202 });
      }
      if (streamedRunId && url.endsWith(`/v1/runs/${streamedRunId}`)) {
        return new Response(JSON.stringify({ status: 'running', model: 'gpt-5.5' }), { status: 200 });
      }
      if (streamedRunId && url.endsWith(`/v1/runs/${streamedRunId}/events`)) {
        return new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.endsWith('/v1/runs/run_runtime/approval')) {
        return new Response(JSON.stringify({ object: 'hermes.run.approval_response', run_id: 'run_runtime', resolved: 1 }), { status: 200 });
      }
      if (url.endsWith('/v1/runs/run_runtime/stop')) {
        return new Response(JSON.stringify({ run_id: 'run_runtime', status: 'stopping' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const client = new HermesRunsClient(env);
    const out = [];
    for await (const event of client.streamChat({ threadId: 'thread-1', clientMessageId, message: '실행', model: 'gpt-5.5' })) {
      out.push(event);
    }
    expect(out.find((event) => event.type === 'tool')).toMatchObject({
      type: 'tool',
      preview: 'call [REDACTED_PHONE] api_key=[REDACTED]',
    });
    const approvals = out.filter((event) => event.type === 'approval');
    expect(approvals[0]).toMatchObject({
      type: 'approval',
      command: 'echo [REDACTED_PHONE] api_key=[REDACTED]',
      choices: ['deny'],
    });
    expect(approvals[1]).toMatchObject({
      type: 'approval',
      toolId: 'file',
      choices: ['deny'],
    });
    expect(out.find((e) => e.type === 'done')).toMatchObject({ type: 'done', usage: { totalTokens: 7 } });
    const start = requests.find((r) => r.url.endsWith('/v1/runs'));
    expect(JSON.parse(start!.body!)).toMatchObject({ model: 'gpt-5.5' });

    await expect(client.respondApproval('run_runtime', 'deny')).resolves.toEqual({ ok: true, runId: 'run_runtime', status: 'denied' });
    await expect(client.respondApproval('run_runtime', 'once')).rejects.toThrow(/action-bound upstream approval protocol/);
    await expect(client.respondApproval('run_runtime', 'always')).rejects.toThrow(/durable product approval policy/);
    await expect(client.respondApproval('run_runtime', 'once', true)).rejects.toThrow(/resolveAll requires a durable product approval policy/);
    await expect(client.stopRun('run_runtime')).resolves.toEqual({ ok: true, runId: 'run_runtime', status: 'stopping' });
  });

  it('retries transient Hermes stop failures when an active stream is aborted', async () => {
    const requests: Array<{ url: string; method: string | undefined }> = [];
    let runId: string | undefined;
    let stopAttempts = 0;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, method: init?.method });
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }])), { status: 200 });
      }
      if (url.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        runId = (JSON.parse(String(init?.body ?? '{}')) as { client_run_id?: string }).client_run_id;
        return new Response(JSON.stringify({ run_id: runId, status: 'started', tool_inventory_hash: inventoryHash }), { status: 202 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}`)) {
        return new Response(JSON.stringify({ status: 'running' }), { status: 200 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}/events`)) {
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}/stop`)) {
        stopAttempts += 1;
        if (stopAttempts < 3) return new Response('temporary outage', { status: 503 });
        return new Response(JSON.stringify({ run_id: runId, status: 'stopping' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const abort = new AbortController();
    const stream = new HermesRunsClient(env).streamChat(
      { threadId: 'thread-1', clientMessageId, message: '중단 테스트' },
      undefined,
      abort.signal,
    );
    expect((await stream.next()).value).toMatchObject({ type: 'start', runId });
    abort.abort();
    expect((await stream.next()).done).toBe(true);

    expect(requests.filter((request) => request.url.endsWith(`/v1/runs/${runId}/stop`))).toEqual([
      expect.objectContaining({ method: 'POST' }),
      expect.objectContaining({ method: 'POST' }),
      expect.objectContaining({ method: 'POST' }),
    ]);
  });

  it('stops a client-identified run when abort loses the accepted start response', async () => {
    let acceptedClientRunId: string | undefined;
    let markAccepted: (() => void) | undefined;
    const accepted = new Promise<void>((resolve) => {
      markAccepted = resolve;
    });
    const requests: Array<{ url: string; method: string | undefined }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, method: init?.method });
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }])), { status: 200 });
      }
      if (url.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { client_run_id?: string };
        acceptedClientRunId = body.client_run_id;
        markAccepted?.();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      if (acceptedClientRunId && url.endsWith(`/v1/runs/${acceptedClientRunId}/stop`)) {
        return new Response(JSON.stringify({ run_id: acceptedClientRunId, status: 'stopping' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const abort = new AbortController();
    const stream = new HermesRunsClient(env).streamChat(
      { threadId: 'thread-1', clientMessageId, message: '응답 전 중단 테스트' },
      undefined,
      abort.signal,
    );
    const first = stream.next();
    await accepted;
    abort.abort();

    expect((await first).done).toBe(true);
    expect(acceptedClientRunId).toMatch(/^run_[0-9a-f]{32}$/);
    expect(requests).toContainEqual({
      url: `http://hermes.local/v1/runs/${acceptedClientRunId}/stop`,
      method: 'POST',
    });
  });

  it('retries a just-submitted run cleanup through an initial stop 404 race', async () => {
    let acceptedClientRunId: string | undefined;
    let markAccepted: (() => void) | undefined;
    const accepted = new Promise<void>((resolve) => { markAccepted = resolve; });
    let stopAttempts = 0;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }])), { status: 200 });
      }
      if (url.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        acceptedClientRunId = (JSON.parse(String(init?.body ?? '{}')) as { client_run_id?: string }).client_run_id;
        markAccepted?.();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      if (acceptedClientRunId && url.endsWith(`/v1/runs/${acceptedClientRunId}/stop`)) {
        stopAttempts += 1;
        if (stopAttempts < 3) return new Response('not registered yet', { status: 404 });
        return new Response(JSON.stringify({ run_id: acceptedClientRunId, status: 'stopping' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const abort = new AbortController();
    const stream = new HermesRunsClient(env).streamChat(
      { threadId: 'thread-1', clientMessageId, message: '등록 전 중단 경합' },
      undefined,
      abort.signal,
    );
    const first = stream.next();
    await accepted;
    abort.abort();

    expect((await first).done).toBe(true);
    expect(stopAttempts).toBe(3);
  });

  it('stops an accepted run when the events transport fails without a client abort', async () => {
    let runId: string | undefined;
    let stopAttempts = 0;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }])), { status: 200 });
      }
      if (url.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        runId = (JSON.parse(String(init?.body ?? '{}')) as { client_run_id?: string }).client_run_id;
        return new Response(JSON.stringify({ run_id: runId, status: 'started', tool_inventory_hash: inventoryHash }), { status: 202 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}`)) {
        return new Response(JSON.stringify({ status: 'running' }), { status: 200 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}/events`)) {
        return new Response('temporary outage', { status: 503 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}/stop`)) {
        stopAttempts += 1;
        return new Response(JSON.stringify({ run_id: runId, status: 'stopping' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const events = [];
    for await (const event of new HermesRunsClient(env).streamChat({
      threadId: 'thread-1',
      clientMessageId,
      message: 'events 503 정리',
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'HERMES_PROXY_ERROR' });
    expect(stopAttempts).toBe(1);
  });

  it('fails closed and stops the run when SSE ends without a terminal event', async () => {
    let runId: string | undefined;
    const requests: Array<{ url: string; method: string | undefined }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, method: init?.method });
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }])), { status: 200 });
      }
      if (url.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        runId = (JSON.parse(String(init?.body ?? '{}')) as { client_run_id?: string }).client_run_id;
        return new Response(JSON.stringify({ run_id: runId, status: 'started', tool_inventory_hash: inventoryHash }), { status: 202 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}`)) {
        return new Response(JSON.stringify({ status: 'running' }), { status: 200 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}/events`)) {
        return new Response('data: {"event":"message.delta","delta":"partial"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}/stop`)) {
        return new Response(JSON.stringify({ run_id: runId, status: 'stopping' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const events = [];
    for await (const event of new HermesRunsClient(env).streamChat({ threadId: 'thread-1', clientMessageId, message: 'EOF 테스트' })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'HERMES_STREAM_INCOMPLETE' });
    expect(requests).toContainEqual({
      url: `http://hermes.local/v1/runs/${runId}/stop`,
      method: 'POST',
    });
  });

  it('fails closed before run start when Hermes lacks client run idempotency', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }])), { status: 200 });
      }
      if (url.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({ features: { run_client_idempotency: false } }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    const out = [];
    for await (const event of new HermesRunsClient(env).streamChat({ threadId: 'thread-1', clientMessageId, message: '실행' })) {
      out.push(event);
    }

    expect(out).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'HERMES_PROXY_ERROR',
        message: expect.stringContaining('client run idempotency'),
      }),
    ]);
    expect(requests.some((url) => url.endsWith('/v1/runs'))).toBe(false);
  });

  it('stops and fails closed when Hermes accepts a different tool inventory hash', async () => {
    let runId: string | undefined;
    let stopAttempts = 0;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }])), { status: 200 });
      }
      if (url.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({
          features: { run_client_idempotency: true, run_tool_inventory_binding: true },
        }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { client_run_id?: string };
        runId = payload.client_run_id;
        return new Response(JSON.stringify({
          run_id: runId,
          status: 'started',
          tool_inventory_hash: 'b'.repeat(64),
        }), { status: 202 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}/stop`)) {
        stopAttempts += 1;
        return new Response(JSON.stringify({ run_id: runId, status: 'stopping' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const events = [];
    for await (const event of new HermesRunsClient(env).streamChat({
      threadId: 'thread-1', clientMessageId, message: 'hash mismatch',
    })) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'HERMES_PROXY_ERROR',
        message: expect.stringContaining('tool_inventory_hash'),
      }),
    ]);
    expect(stopAttempts).toBeGreaterThanOrEqual(1);
  });

  it('fails closed before run start when Hermes exposes a non-allowlisted toolset', async () => {
    const requests: Array<{ url: string; body: string | null }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === 'string' ? init.body : null;
      requests.push({ url, body });
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }, { name: 'mcp-github', enabled: true }])), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        return new Response(JSON.stringify({ run_id: 'should_not_start', status: 'started' }), { status: 202 });
      }
      return new Response('not found', { status: 404 });
    });

    const client = new HermesRunsClient(env);
    const out = [];
    for await (const event of client.streamChat({ threadId: 'thread-1', clientMessageId, message: '실행' })) {
      out.push(event);
    }

    expect(out).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'HERMES_PROXY_ERROR',
        message: expect.stringContaining('Hermes tool policy blocked enabled toolsets: mcp_github'),
      }),
    ]);
    expect(requests.some((request) => request.url.endsWith('/v1/runs'))).toBe(false);
  });

  it('fails closed in production when the policy audit store is unavailable', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const events = [];
    for await (const event of new HermesRunsClient({ ...env, APP_ENV: 'production' }).streamChat(
      { threadId: 'thread-1', clientMessageId, message: '실행' },
      { workspaceId: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002' },
    )) events.push(event);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'error', message: expect.stringContaining('audit store is required'),
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forces tool policy enforcement in production even when configuration tries to disable it', async () => {
    const requests: string[] = [];
    const audits = { record: vi.fn(async () => ({ eventHash: 'a'.repeat(64), idempotent: false })) };
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'mcp.github', enabled: true }])), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const events = [];
    for await (const event of new HermesRunsClient({
      ...env,
      APP_ENV: 'production',
      HERMES_TOOL_POLICY_ENFORCED: false,
    }, audits as never).streamChat(
      { threadId: 'thread-1', clientMessageId, message: '실행' },
      { workspaceId: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002' },
    )) events.push(event);

    expect(audits.record).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', enforced: true }));
    expect(events[0]).toEqual(expect.objectContaining({ type: 'error', code: 'HERMES_PROXY_ERROR' }));
    expect(requests.some((url) => url.endsWith('/v1/runs'))).toBe(false);
  });

  it('audits toolset discovery failure as deny before returning an error', async () => {
    const audits = { record: vi.fn(async () => ({ eventHash: 'a'.repeat(64), idempotent: false })) };
    vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 503 }));
    const events = [];
    for await (const event of new HermesRunsClient(env, audits as never).streamChat(
      { threadId: 'thread-1', clientMessageId, message: '실행' },
      { workspaceId: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002' },
    )) events.push(event);
    expect(audits.record).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'deny', blockedToolsets: ['policy_check_unavailable'],
    }));
    expect(events[0]).toEqual(expect.objectContaining({ type: 'error', code: 'HERMES_PROXY_ERROR' }));
  });

  it.each([
    ['missing data', {}],
    ['empty data', { data: [] }],
    ['malformed row', { data: [{ name: 'web', enabled: 'true' }] }],
    ['mixed valid and malformed rows', { data: [{ name: 'web', enabled: true }, { enabled: true }] }],
    ['legacy row-only response', { data: [{ name: 'web', enabled: true }] }],
    ['hidden effective MCP toolset', {
      object: 'list', platform: 'api_server', inventory_complete: true,
      effective_toolsets: ['gbrain', 'web'], effective_tools: ['mcp__gbrain__query', 'web_search'],
      data: [{ name: 'web', enabled: true }],
    }],
    ['duplicate effective tools', {
      object: 'list', platform: 'api_server', inventory_complete: true,
      effective_toolsets: ['web'], effective_tools: ['web_search', 'web_search'],
      data: [{ name: 'web', enabled: true }],
    }],
  ])('fails closed and audits incomplete toolset inventory: %s', async (_label, payload) => {
    const requests: string[] = [];
    const audits = { record: vi.fn(async () => ({ eventHash: 'a'.repeat(64), idempotent: false })) };
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const events = [];
    for await (const event of new HermesRunsClient(env, audits as never).streamChat(
      { threadId: 'thread-1', clientMessageId, message: '실행' },
      { workspaceId: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002' },
    )) events.push(event);

    expect(audits.record).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'deny', blockedToolsets: ['policy_inventory_incomplete'],
    }));
    expect(events[0]).toEqual(expect.objectContaining({ type: 'error', code: 'HERMES_PROXY_ERROR' }));
    expect(requests.some((url) => url.endsWith('/v1/runs'))).toBe(false);
  });

  it('persists a denied policy audit before refusing run submission', async () => {
    const requests: string[] = [];
    const audits = { record: vi.fn(async () => ({ eventHash: 'a'.repeat(64), idempotent: false })) };
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }, { name: 'mcp-github', enabled: true }])), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const client = new HermesRunsClient(env, audits as never);
    const events = [];
    for await (const event of client.streamChat(
      { threadId: 'thread-1', clientMessageId, message: '실행' },
      { workspaceId: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002' },
    )) events.push(event);

    expect(audits.record).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'deny',
      blockedToolsets: ['mcp_github'],
      workspaceId: '00000000-0000-4000-8000-000000000001',
      runId: expect.stringMatching(/^run_/u),
    }));
    expect(events[0]).toEqual(expect.objectContaining({ type: 'error', code: 'HERMES_PROXY_ERROR' }));
    expect(requests.some((url) => url.endsWith('/v1/runs'))).toBe(false);
  });

  it('does not allow high-blast MCP toolsets from config alone', async () => {
    const requests: Array<{ url: string; body: string | null }> = [];
    let runId: string | undefined;
    const events = [
      'data: {"event":"run.completed","run_id":"run_tool_policy"}',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === 'string' ? init.body : null;
      requests.push({ url, body });
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify(toolsetInventory([{ name: 'web', enabled: true }, { name: 'mcp-github', enabled: true }])), { status: 200 });
      }
      if (url.endsWith('/v1/capabilities')) {
        return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        runId = (JSON.parse(body ?? '{}') as { client_run_id?: string }).client_run_id;
        return new Response(JSON.stringify({ run_id: runId, status: 'started', tool_inventory_hash: inventoryHash }), { status: 202 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}`)) {
        return new Response(JSON.stringify({ model: 'test-model' }), { status: 200 });
      }
      if (runId && url.endsWith(`/v1/runs/${runId}/events`)) {
        return new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    });

    const client = new HermesRunsClient({ ...env, HERMES_ALLOWED_TOOLSETS: 'web,mcp-github' });
    const out = [];
    for await (const event of client.streamChat({ threadId: 'thread-1', clientMessageId, message: '실행' })) {
      out.push(event);
    }

    expect(out).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'HERMES_PROXY_ERROR',
        message: expect.stringContaining('mcp_github'),
      }),
    ]);
    expect(requests.some((request) => request.url.endsWith('/v1/runs'))).toBe(false);
  });

  it('normalizes runtime models to provider/model labels instead of the Hermes Agent brand', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [
            { id: 'Hermes Agent', root: 'openai-codex/gpt-5.5', parent: null },
            { id: 'anthropic/claude-sonnet-4', parent: null },
          ],
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const client = new HermesRunsClient(env);
    const res = await client.listModels();

    expect(res.defaultModel).toBe('openai-codex/gpt-5.5');
    expect(res.models[0]).toMatchObject({
      id: 'Hermes Agent',
      route: 'openai-codex/gpt-5.5',
      label: 'gpt-5.5 · openai-codex',
      provider: 'openai-codex',
      modelName: 'gpt-5.5',
      root: 'openai-codex/gpt-5.5',
    });
    expect(res.models[0]?.label).not.toContain('Hermes Agent');
    expect(res.models[1]).toMatchObject({
      route: 'anthropic/claude-sonnet-4',
      label: 'claude-sonnet-4 · anthropic',
      provider: 'anthropic',
      modelName: 'claude-sonnet-4',
    });
  });

  it('falls back to server-side Hermes config routes when the API advertises only hermes-agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-hermes-config-'));
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, [
      'model:',
      '  default: claude-opus-4-8',
      '  provider: anthropic',
      'fallback_providers:',
      '  - provider: openai-codex',
      '    model: gpt-5.5',
      '    base_url: https://chatgpt.com/backend-api/codex',
      '  - provider: anthropic',
      '    model: claude-sonnet-5',
      '',
    ].join('\n'), 'utf8');

    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'hermes-agent', object: 'model', owned_by: 'hermes', root: 'hermes-agent', parent: null }],
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    try {
      const client = new HermesRunsClient({ ...env, HERMES_CONFIG_PATH: configPath });
      const res = await client.listModels();

      expect(res.defaultModel).toBe('anthropic/claude-opus-4-8');
      expect(res.models.map((model) => model.route)).toEqual([
        'anthropic/claude-opus-4-8',
        'openai-codex/gpt-5.5',
        'anthropic/claude-sonnet-5',
      ]);
      expect(res.models.some((model) => model.route === 'hermes-agent')).toBe(false);
      expect(res.models.find((model) => model.route === 'openai-codex/gpt-5.5')).toMatchObject({
        label: 'gpt-5.5 · openai-codex',
        provider: 'openai-codex',
        modelName: 'gpt-5.5',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns configured model routes when the Hermes models endpoint rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-hermes-config-'));
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, [
      'model:',
      '  provider: openai-codex',
      '  default: gpt-5.5',
      '',
    ].join('\n'), 'utf8');

    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/v1/models')) return new Response('unauthorized', { status: 401 });
      return new Response('not found', { status: 404 });
    });

    try {
      const client = new HermesRunsClient({ ...env, HERMES_CONFIG_PATH: configPath });
      const res = await client.listModels();

      expect(res.defaultModel).toBe('openai-codex/gpt-5.5');
      expect(res.models).toHaveLength(1);
      expect(res.models[0]).toMatchObject({
        route: 'openai-codex/gpt-5.5',
        provider: 'openai-codex',
        modelName: 'gpt-5.5',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
