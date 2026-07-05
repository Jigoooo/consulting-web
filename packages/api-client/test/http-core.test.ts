import { describe, expect, it, vi } from 'vitest';
import { ConsultingApiClient, ApiClientError } from '../src/index.js';

/**
 * Regression: the client must call the platform fetch bound to the global
 * object, never with `this` = HttpCore. Browsers throw "Illegal invocation"
 * otherwise. We assert fetch is invoked with an undefined/global thisArg by
 * using a plain function that captures its own `this`.
 */
describe('HttpCore fetch binding', () => {
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
