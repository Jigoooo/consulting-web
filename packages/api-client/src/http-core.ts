import { ApiErrorSchema, type ApiError, type ApiErrorCode } from '@consulting/contracts';

/**
 * Thrown when the API returns a non-2xx response. Carries the parsed
 * { code, message } envelope so callers can branch on a stable machine code
 * instead of scraping HTTP status text.
 */
export class ApiClientError extends Error {
  readonly code: ApiErrorCode | 'UNKNOWN';
  readonly status: number;

  constructor(status: number, error: ApiError | { code: 'UNKNOWN'; message: string }) {
    super(error.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = error.code;
  }
}

export interface ApiClientOptions {
  /** Base URL of the consulting-web API, e.g. http://localhost:3000 */
  readonly baseUrl: string;
  /** Access token getter; called per-request so token refresh is transparent. */
  readonly getAccessToken?: () => string | null | undefined;
  /** Injectable fetch (defaults to global fetch) — lets tests stub the transport. */
  readonly fetch?: typeof fetch;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Force-attach (or suppress) the bearer token for this call. */
  readonly auth?: boolean;
  readonly signal?: AbortSignal;
}

export class HttpCore {
  constructor(private readonly options: ApiClientOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/$/, '');
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetch ?? globalThis.fetch;
  }

  headers(extra: Record<string, string> = {}, auth = true): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (auth) {
      const token = this.options.getAccessToken?.();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async request<T>(path: string, opts: RequestOptions, parse: (data: unknown) => T): Promise<T> {
    const method = opts.method ?? 'GET';
    const hasBody = opts.body !== undefined;
    const init: RequestInit = {
      method,
      headers: this.headers(hasBody ? { 'content-type': 'application/json' } : {}, opts.auth ?? true),
    };
    if (hasBody) init.body = JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);

    if (!response.ok) {
      throw await this.toError(response);
    }

    if (response.status === 204) {
      return parse(undefined);
    }
    const data = await response.json().catch(() => undefined);
    return parse(data);
  }

  /** Raw fetch for streaming endpoints; caller owns the response body. */
  async raw(path: string, opts: RequestOptions): Promise<Response> {
    const method = opts.method ?? 'GET';
    const hasBody = opts.body !== undefined;
    const init: RequestInit = {
      method,
      headers: this.headers(
        hasBody ? { 'content-type': 'application/json', accept: 'text/event-stream' } : { accept: 'text/event-stream' },
        opts.auth ?? true,
      ),
    };
    if (hasBody) init.body = JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw await this.toError(response);
    }
    return response;
  }

  private async toError(response: Response): Promise<ApiClientError> {
    const raw = await response.json().catch(() => undefined);
    const parsed = ApiErrorSchema.safeParse(raw);
    if (parsed.success) {
      return new ApiClientError(response.status, parsed.data);
    }
    return new ApiClientError(response.status, {
      code: 'UNKNOWN',
      message: `request failed with status ${response.status}`,
    });
  }
}
