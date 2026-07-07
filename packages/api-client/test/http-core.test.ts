import { describe, expect, it, vi } from 'vitest';
import { ConsultingApiClient, ApiClientError } from '../src/index.js';

/**
 * Regression: the client must call the platform fetch bound to the global
 * object, never with `this` = HttpCore. Browsers throw "Illegal invocation"
 * otherwise. We assert fetch is invoked with an undefined/global thisArg by
 * using a plain function that captures its own `this`.
 */
describe('HttpCore fetch binding', () => {
  it('requests cursor-paged messages with query params', async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn((url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({
        messages: [],
        hasOlder: false,
        hasNewer: false,
        olderCursor: null,
        newerCursor: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });
    await client.listMessagesPage('00000000-0000-4000-8000-000000000009', {
      limit: 25,
      before: '00000000-0000-4000-8000-000000000008',
      direction: 'older',
    });
    expect(calls[0]).toBe('/api/chat/threads/00000000-0000-4000-8000-000000000009/messages?limit=25&before=00000000-0000-4000-8000-000000000008&direction=older');
  });

  it('requests message search with encoded query params', async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn((url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ results: [], messages: [], files: [], evidence: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });
    await client.searchMessages('00000000-0000-4000-8000-000000000009', { q: '창원 버스', limit: 7 });
    expect(calls[0]).toBe('/api/chat/threads/00000000-0000-4000-8000-000000000009/messages/search?q=%EC%B0%BD%EC%9B%90+%EB%B2%84%EC%8A%A4&limit=7');
  });

  it('invokes fetch without binding it to the client instance', async () => {
    let capturedThis: unknown = 'unset';
    const fakeFetch = vi.fn(function (this: unknown, _url: string | URL | Request, _init?: RequestInit) {
      capturedThis = this;
      return Promise.resolve(
        new Response(JSON.stringify({ userId: '00000000-0000-4000-8000-000000000001', personalWorkspaceId: '00000000-0000-4000-8000-000000000002' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const client = new ConsultingApiClient({
      baseUrl: 'http://example.test',
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const res = await client.signup({ email: 'a@b.com', password: 'supersecret1', displayName: 'A' });
    expect(res.userId).toBe('00000000-0000-4000-8000-000000000001');
    expect(fakeFetch).toHaveBeenCalledOnce();
    // Called as a free function → `this` is undefined (strict) or the module,
    // never the HttpCore/client instance.
    expect(capturedThis).not.toBe(client);
  });

  it('sends the request to baseUrl + path', async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn((url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api/', fetch: fakeFetch as unknown as typeof fetch });
    await client.login({ email: 'a@b.com', password: 'supersecret1' }).catch(() => undefined);
    expect(calls[0]).toBe('/api/auth/login');
  });

  it('calls runtime control endpoints with typed payloads', async () => {
    const calls: Array<{ url: string; body: string | null; method: string | undefined }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : null, method: init?.method });
      if (String(url).endsWith('/chat/runtime/models')) {
        return Promise.resolve(new Response(JSON.stringify({
          defaultModel: 'openai-codex/gpt-5.5',
          models: [{
            id: 'Hermes Agent',
            route: 'openai-codex/gpt-5.5',
            label: 'gpt-5.5 · openai-codex',
            provider: 'openai-codex',
            modelName: 'gpt-5.5',
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, runId: 'run_123', status: 'stopping' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    await client.listRuntimeModels();
    await client.stopRun('run_123', '00000000-0000-4000-8000-000000000009');
    await client.respondRunApproval('run_123', { threadId: '00000000-0000-4000-8000-000000000009', choice: 'once' });

    expect(calls.map((c) => c.url)).toEqual([
      '/api/chat/runtime/models',
      '/api/chat/runtime/runs/run_123/stop',
      '/api/chat/runtime/runs/run_123/approval',
    ]);
    expect(calls[1]?.method).toBe('POST');
    expect(JSON.parse(calls[2]?.body ?? '{}')).toEqual({ threadId: '00000000-0000-4000-8000-000000000009', choice: 'once' });
  });

  it('calls archive list and restore endpoints', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      if (String(url).endsWith('/archive')) {
        return Promise.resolve(new Response(JSON.stringify({
          items: [{
            kind: 'channel',
            id: '11111111-1111-4111-8111-111111111111',
            name: '보관된 채널',
            parentPath: ['프로젝트'],
            archivedAt: '2026-07-06T16:00:00.000Z',
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    const archive = await client.listArchivedScopes('00000000-0000-4000-8000-000000000001');
    await client.restoreArchived('channel', '11111111-1111-4111-8111-111111111111');

    expect(archive.items[0]?.parentPath).toEqual(['프로젝트']);
    expect(calls).toEqual([
      { url: '/api/spaces/workspaces/00000000-0000-4000-8000-000000000001/archive', method: 'GET' },
      { url: '/api/spaces/archive/channel/11111111-1111-4111-8111-111111111111/restore', method: 'POST' },
    ]);
  });

  it('calls context edge endpoints with strict payloads', async () => {
    const calls: Array<{ url: string; body: string | null; method: string | undefined }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : null, method: init?.method });
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ edgeId: '00000000-0000-4000-8000-000000000001' }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ edges: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    await client.createContextEdge({
      fromScopeType: 'topic',
      fromScopeId: '00000000-0000-4000-8000-000000000001',
      toScopeType: 'topic',
      toScopeId: '00000000-0000-4000-8000-000000000002',
      edgeType: 'related_to',
      confidence: 0.9,
    });
    await client.listContextEdges({ scopeType: 'topic', scopeId: '00000000-0000-4000-8000-000000000001', limit: 5 });

    expect(calls[0]).toEqual({
      url: '/api/spaces/context-edges',
      method: 'POST',
      body: JSON.stringify({
        fromScopeType: 'topic',
        fromScopeId: '00000000-0000-4000-8000-000000000001',
        toScopeType: 'topic',
        toScopeId: '00000000-0000-4000-8000-000000000002',
        edgeType: 'related_to',
        confidence: 0.9,
      }),
    });
    expect(calls[1]).toEqual({
      url: '/api/spaces/context-edges?scopeType=topic&scopeId=00000000-0000-4000-8000-000000000001&limit=5',
      method: 'GET',
      body: null,
    });
  });

  it('preserves PARENT_ARCHIVED restore errors as typed ApiClientError codes', async () => {
    const fakeFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'PARENT_ARCHIVED',
      message: '상위 항목을 먼저 복원해야 합니다.',
    }), { status: 409, headers: { 'content-type': 'application/json' } })));
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    const err = await client.restoreArchived('channel', '11111111-1111-4111-8111-111111111111').catch((e) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('PARENT_ARCHIVED');
    expect((err as ApiClientError).status).toBe(409);
  });
});

describe('HttpCore transport failures', () => {
  it('rejects with ApiClientError(TIMEOUT) when the request exceeds timeoutMs', async () => {
    // fetch that never resolves until aborted → simulates a hung backend.
    const fakeFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }
      });
    });
    const client = new ConsultingApiClient({
      baseUrl: '/api',
      fetch: fakeFetch as unknown as typeof fetch,
      timeoutMs: 20,
    });

    const err = await client.login({ email: 'a@b.com', password: 'supersecret1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('TIMEOUT');
  });

  it('rejects with ApiClientError(NETWORK) when fetch rejects with a non-abort error', async () => {
    const fakeFetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    const client = new ConsultingApiClient({
      baseUrl: '/api',
      fetch: fakeFetch as unknown as typeof fetch,
      timeoutMs: 5_000,
    });

    const err = await client.login({ email: 'a@b.com', password: 'supersecret1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('NETWORK');
  });

  it('propagates a caller-initiated abort as a raw AbortError (not TIMEOUT/NETWORK)', async () => {
    const controller = new AbortController();
    const fakeFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }
      });
    });
    const client = new ConsultingApiClient({
      baseUrl: '/api',
      fetch: fakeFetch as unknown as typeof fetch,
      timeoutMs: 5_000,
    });

    // Stream endpoint opts out of timeout and honors the caller signal.
    const gen = client.streamChat({ threadId: '00000000-0000-4000-8000-000000000009', message: 'hi' }, controller.signal);
    const pending = gen.next().catch((e) => e);
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });
});
