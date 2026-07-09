import { ApiErrorSchema, type ApiError, type ApiErrorCode } from '@consulting/contracts';

/**
 * Client-local error codes layered on top of the wire ApiErrorCode. TIMEOUT and
 * NETWORK never come from the server — they describe transport-level failures the
 * browser observes locally, so they stay OUT of the contracts wire schema.
 */
export type ClientErrorCode = ApiErrorCode | 'UNKNOWN' | 'TIMEOUT' | 'NETWORK';

/**
 * Thrown when the API returns a non-2xx response, or when the request fails at
 * the transport layer (timeout / network). Carries a stable machine code so
 * callers branch on { code } instead of scraping HTTP status text.
 */
export class ApiClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, error: ApiError | { code: ClientErrorCode; message: string }, details?: unknown) {
    super(error.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = error.code;
    this.details = details;
  }
}

export interface ApiClientOptions {
  /** Base URL of the consulting-web API, e.g. http://localhost:3000 */
  readonly baseUrl: string;
  /** Access token getter; called per-request so token refresh is transparent. */
  readonly getAccessToken?: () => string | null | undefined;
  /**
   * Refresh hook (N-3). Called ONCE when a request gets 401 with a token
   * attached. Return true if a new access token is now available via
   * getAccessToken (the request is retried once), false to give up.
   */
  readonly onUnauthorized?: () => Promise<boolean>;
  /** Injectable fetch (defaults to global fetch) — lets tests stub the transport. */
  readonly fetch?: typeof fetch;
  /**
   * Default request timeout in ms. A pending request that exceeds this rejects
   * with ApiClientError(code:'TIMEOUT') — the structural guarantee that a hung
   * backend can NEVER produce an infinite spinner. Defaults to 15000.
   * Streaming calls opt out with RequestOptions.timeoutMs = false.
   */
  readonly timeoutMs?: number;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Force-attach (or suppress) the bearer token for this call. */
  readonly auth?: boolean;
  readonly signal?: AbortSignal;
  /** Per-call timeout override in ms, or false to disable (streaming). */
  readonly timeoutMs?: number | false;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpCore {
  constructor(private readonly options: ApiClientOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/$/, '');
  }

  private get fetchImpl(): typeof fetch {
    // Always return a function detached from `this`. Calling
    // `this.fetchImpl(...)` would otherwise invoke fetch with `this` = HttpCore,
    // which browsers reject with "Illegal invocation" (platform fetch must run
    // in the window/worker context). Injected fetches (tests) are wrapped too so
    // they never receive the client as their thisArg.
    const injected = this.options.fetch;
    if (injected) return (input, init) => injected(input, init);
    return globalThis.fetch.bind(globalThis);
  }

  headers(extra: Record<string, string> = {}, auth = true): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (auth) {
      const token = this.options.getAccessToken?.();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * Run a single fetch with a timeout+abort envelope. Composes the caller's
   * AbortSignal (if any) with an internal timeout controller so that:
   *  - caller abort  → AbortError (surfaced as-is by callers that pass a signal)
   *  - timeout fires → ApiClientError(TIMEOUT)
   *  - network fail  → ApiClientError(NETWORK)
   */
  private async fetchOnce(url: string, init: RequestInit, callerSignal: AbortSignal | undefined, timeoutMs: number | false): Promise<Response> {
    // No timeout requested (streaming): pass the caller signal straight through.
    if (timeoutMs === false) {
      const finalInit = callerSignal ? { ...init, signal: callerSignal } : init;
      try {
        return await this.fetchImpl(url, finalInit);
      } catch (err) {
        // Caller-initiated abort (e.g. composer cancel) must propagate raw.
        if (callerSignal?.aborted) throw err;
        if (err instanceof ApiClientError) throw err;
        throw new ApiClientError(0, { code: 'NETWORK', message: '네트워크에 연결할 수 없습니다.' });
      }
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (timedOut) {
        throw new ApiClientError(0, { code: 'TIMEOUT', message: '서버 응답이 없습니다.' });
      }
      // Caller-initiated abort → propagate the raw AbortError so cancel flows work.
      if (callerSignal?.aborted) throw err;
      if (err instanceof ApiClientError) throw err;
      // Anything else at the transport layer is a network failure.
      throw new ApiClientError(0, { code: 'NETWORK', message: '네트워크에 연결할 수 없습니다.' });
    } finally {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  /** One 401→refresh→retry pass shared by request() and raw(). */
  private async fetchWithRefresh(
    path: string,
    buildInit: () => RequestInit,
    authed: boolean,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number | false,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    let response = await this.fetchOnce(url, buildInit(), callerSignal, timeoutMs);
    if (response.status === 401 && authed && this.options.onUnauthorized) {
      const refreshed = await this.options.onUnauthorized();
      if (refreshed) {
        // Rebuild init so the new access token is picked up.
        response = await this.fetchOnce(url, buildInit(), callerSignal, timeoutMs);
      }
    }
    return response;
  }

  private resolveTimeout(opts: RequestOptions): number | false {
    if (opts.timeoutMs === false) return false;
    if (typeof opts.timeoutMs === 'number') return opts.timeoutMs;
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T>(path: string, opts: RequestOptions, parse: (data: unknown) => T): Promise<T> {
    const method = opts.method ?? 'GET';
    const hasBody = opts.body !== undefined;
    const authed = opts.auth ?? true;
    const buildInit = (): RequestInit => {
      const init: RequestInit = {
        method,
        headers: this.headers(hasBody ? { 'content-type': 'application/json' } : {}, authed),
      };
      if (hasBody) init.body = JSON.stringify(opts.body);
      return init;
    };
    const response = await this.fetchWithRefresh(path, buildInit, authed, opts.signal, this.resolveTimeout(opts));

    if (!response.ok) {
      throw await this.toError(response);
    }

    if (response.status === 204) {
      return parse(undefined);
    }
    const data: unknown = await response.json().catch((): undefined => undefined);
    return parse(data);
  }

  /** Raw fetch for streaming endpoints; caller owns the response body. */
  async raw(path: string, opts: RequestOptions): Promise<Response> {
    const method = opts.method ?? 'GET';
    const hasBody = opts.body !== undefined;
    const authed = opts.auth ?? true;
    const buildInit = (): RequestInit => {
      const init: RequestInit = {
        method,
        headers: this.headers(
          hasBody ? { 'content-type': 'application/json', accept: 'text/event-stream' } : { accept: 'text/event-stream' },
          authed,
        ),
      };
      if (hasBody) init.body = JSON.stringify(opts.body);
      return init;
    };
    const response = await this.fetchWithRefresh(path, buildInit, authed, opts.signal, this.resolveTimeout(opts));
    if (!response.ok) {
      throw await this.toError(response);
    }
    return response;
  }

  private async toError(response: Response): Promise<ApiClientError> {
    const raw: unknown = await response.json().catch((): undefined => undefined);
    const parsed = ApiErrorSchema.safeParse(raw);
    if (parsed.success) {
      return new ApiClientError(response.status, parsed.data, raw);
    }
    if (raw && typeof raw === 'object') {
      const loose = ApiErrorSchema.safeParse({
        code: (raw as { code?: unknown }).code,
        message: (raw as { message?: unknown }).message,
      });
      if (loose.success) {
        return new ApiClientError(response.status, loose.data, raw);
      }
    }
    return new ApiClientError(response.status, {
      code: 'UNKNOWN',
      message: `request failed with status ${response.status}`,
    });
  }
}
