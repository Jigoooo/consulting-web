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

  it('requests workspace tree effective permissions only when opted in', async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn((url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({
        workspaceId: '00000000-0000-4000-8000-000000000001',
        permissions: ['workspace.read'],
        projects: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });
    const tree = await client.workspaceTree('00000000-0000-4000-8000-000000000001', true);
    expect(tree.permissions).toEqual(['workspace.read']);
    expect(calls[0]).toBe('/api/spaces/workspaces/00000000-0000-4000-8000-000000000001/tree?includePermissions=true');
  });

  it('opts into analytics summary while accepting an old strict v1 API response', async () => {
    const calls: string[] = [];
    const v1 = {
      verdictSummary: { supports: 0, refutes: 0, mixed: 0, notEnoughInfo: 0, claimCount: 0 },
      latestVerdicts: [],
      latestScorecard: null,
      documentUnits: { total: 0, byModality: {} },
      reviewQueue: { openCount: 0, top: null },
      postAnswerVerification: {
        checkedMessageCount: 0,
        unsupportedCount: 0,
        refutedCount: 0,
        verificationMetrics: { totalLatencyMs: 0, providerCalls: { nli: 0, llm: 0, heuristic: 0 }, providerLatencies: {} },
        gate: { decision: 'PASS', blockers: [], warnings: [] },
      },
      exactness: { latestRun: null, blockedCount: 0 },
    };
    const fakeFetch = vi.fn((url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify(v1), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });
    const summary = await client.evidenceDecisionSummary('00000000-0000-4000-8000-000000000009');
    expect(calls[0]).toBe('/api/chat/threads/00000000-0000-4000-8000-000000000009/evidence-decision/summary?includeAnalytics=1');
    expect(summary.judgment).toEqual({ latestRun: null, blockedCount: 0 });
    expect(summary.analytics).toEqual({ supported: false, latestRun: null });
  });

  it('posts a bounded decision analytics request and parses its audit response', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const response = {
      run: {
        id: '00000000-0000-4000-8000-000000000001',
        scorecardId: '00000000-0000-4000-8000-000000000002',
        artifactVersionId: null,
        artifactContentHash: null,
        methodVersion: 'decision_analytics_v2',
        inputHash: 'a'.repeat(64),
        actorKind: 'user',
        sensitivity: { baselineWinnerId: 'keep', winnerStability: 0.9, perturbationPct: 0.2, scenarios: 2000, criticalCriteria: [] },
        impact: null,
        createdAt: '2026-07-14T00:00:00.000Z',
      },
    };
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response(JSON.stringify(response), { status: 201, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });
    const result = await client.runDecisionAnalytics('00000000-0000-4000-8000-000000000009', {
      scorecardId: response.run.scorecardId,
    });
    expect(result.run.inputHash).toBe('a'.repeat(64));
    expect(calls[0]?.url).toBe('/api/chat/threads/00000000-0000-4000-8000-000000000009/decision-analytics');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it.each([
    { status: 404, code: 'NOT_FOUND' },
    { status: 400, code: 'VALIDATION' },
    { status: 409, code: 'CONFLICT' },
  ] as const)('preserves decision analytics $code errors in the typed client', async ({ status, code }) => {
    const fakeFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code,
      message: `decision analytics ${code.toLowerCase()}`,
    }), { status, headers: { 'content-type': 'application/json' } })));
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    const error = await client.runDecisionAnalytics(
      '00000000-0000-4000-8000-000000000009',
      { scorecardId: '00000000-0000-4000-8000-000000000002' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe(code);
    expect((error as ApiClientError).status).toBe(status);
  });

  it('reads analytics bound to an immutable artifact version', async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn((url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ supported: true, latestRun: null }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });
    const result = await client.artifactVersionDecisionAnalytics(
      '00000000-0000-4000-8000-000000000009',
      '00000000-0000-4000-8000-000000000008',
    );
    expect(result).toEqual({ supported: true, latestRun: null, lineageStatus: 'unavailable', scorecard: null });
    expect(calls[0]).toBe('/api/chat/threads/00000000-0000-4000-8000-000000000009/decision-analytics/artifact-versions/00000000-0000-4000-8000-000000000008');
  });

  it('normalizes an old API without version analytics to unsupported instead of empty', async () => {
    const fakeFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      statusCode: 404,
      message: 'Cannot GET /chat/threads/t/decision-analytics/artifact-versions/v',
      error: 'Not Found',
    }), { status: 404, headers: { 'content-type': 'application/json' } })));
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });
    await expect(client.artifactVersionDecisionAnalytics(
      '00000000-0000-4000-8000-000000000009',
      '00000000-0000-4000-8000-000000000008',
    )).resolves.toEqual({ supported: false, latestRun: null, lineageStatus: 'unavailable', scorecard: null });
  });

  it('preserves a canonical missing artifact error instead of treating it as an old API', async () => {
    const fakeFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'NOT_FOUND', message: 'Cannot GET artifact version',
    }), { status: 404, headers: { 'content-type': 'application/json' } })));
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });
    const error = await client.artifactVersionDecisionAnalytics(
      '00000000-0000-4000-8000-000000000009',
      '00000000-0000-4000-8000-000000000008',
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('NOT_FOUND');
    expect((error as ApiClientError).status).toBe(404);
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
    await client.respondRunApproval('run_123', {
      threadId: '00000000-0000-4000-8000-000000000009',
      approvalId: '00000000-0000-4000-8000-000000000010',
      choice: 'once',
    });

    expect(calls.map((c) => c.url)).toEqual([
      '/api/chat/runtime/models',
      '/api/chat/runtime/runs/run_123/stop',
      '/api/chat/runtime/runs/run_123/approval',
    ]);
    expect(calls[1]?.method).toBe('POST');
    expect(JSON.parse(calls[2]?.body ?? '{}')).toEqual({
      threadId: '00000000-0000-4000-8000-000000000009',
      approvalId: '00000000-0000-4000-8000-000000000010',
      choice: 'once',
    });
  });

  it('calls archive list and restore endpoints', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      if (String(url).includes('/archive?includePermissions=true')) {
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
      { url: '/api/spaces/workspaces/00000000-0000-4000-8000-000000000001/archive?includePermissions=true', method: 'GET' },
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

  it('requests the review queue with an explicit kind filter', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    await client.reviewQueue('thread-1', 'refuted_claim');

    expect(calls[0]).toEqual({
      url: '/api/chat/threads/thread-1/review-queue?kind=refuted_claim',
      method: 'GET',
    });
  });

  it('posts review queue item decisions through the thread-scoped adapter', async () => {
    const calls: Array<{ url: string; body: string | null; method: string | undefined }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : null, method: init?.method });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    await client.decideReviewQueueItem('thread-1', 'review/item 1', { action: 'ignore' });

    expect(calls[0]).toEqual({
      url: '/api/chat/threads/thread-1/review-queue/review%2Fitem%201/decision',
      method: 'POST',
      body: JSON.stringify({ action: 'ignore' }),
    });
  });

  it('calls scope profile endpoints with strict typed payloads', async () => {
    const calls: Array<{ url: string; body: string | null; method: string | undefined }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : null, method: init?.method });
      return Promise.resolve(new Response(JSON.stringify({
        profile: {
          scopeType: String(url).includes('/topics/') ? 'topic' : 'channel',
          scopeId: '00000000-0000-4000-8000-000000000001',
          purpose: '자료 수집',
          role: 'source_intake',
          style: '간결',
          rules: '출처 없는 단정 금지',
          source: init?.method === 'PATCH' ? 'manual' : 'template',
          updatedAt: '2026-07-07T00:00:00.000Z',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    await client.getChannelProfile('00000000-0000-4000-8000-000000000001');
    await client.updateTopicProfile('00000000-0000-4000-8000-000000000002', { purpose: '검산', rules: '숫자는 재계산' });

    expect(calls).toEqual([
      { url: '/api/spaces/channels/00000000-0000-4000-8000-000000000001/profile', method: 'GET', body: null },
      { url: '/api/spaces/topics/00000000-0000-4000-8000-000000000002/profile', method: 'PATCH', body: JSON.stringify({ purpose: '검산', rules: '숫자는 재계산' }) },
    ]);
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

  it('preserves verifier gate details for artifact preflight UI', async () => {
    const fakeFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'VERIFIER_GATE_BLOCKED',
      message: '검증 게이트가 이 산출물의 내보내기를 차단했습니다.',
      gate: {
        decision: 'BLOCKED',
        blockers: [{ code: 'semantic_refute', severity: 'blocker', message: '핵심 주장이 근거와 반대입니다.' }],
        warnings: [],
      },
    }), { status: 409, headers: { 'content-type': 'application/json' } })));
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    const err = await client.exportArtifact('11111111-1111-4111-8111-111111111111', 'pdf').catch((e) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('VERIFIER_GATE_BLOCKED');
    expect((err as ApiClientError).details).toMatchObject({
      gate: {
        blockers: [{ message: '핵심 주장이 근거와 반대입니다.' }],
      },
    });
  });

  it('calls artifact export preflight before rendering with strict contract parsing', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return Promise.resolve(new Response(JSON.stringify({
        canExport: false,
        reason: 'VERIFIER_GATE_BLOCKED',
        versionNo: 2,
        gate: {
          decision: 'BLOCKED',
          blockers: [{ code: 'semantic_refute', severity: 'blocker', message: '핵심 주장이 근거와 반대입니다.' }],
          warnings: [],
        },
        messages: ['핵심 주장이 근거와 반대입니다.'],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    const preflight = await client.exportArtifactPreflight('11111111-1111-4111-8111-111111111111', 'pdf', 2);

    expect(calls[0]).toEqual({
      url: '/api/artifacts/11111111-1111-4111-8111-111111111111/export-preflight?format=pdf&includeReview=1&version=2',
      method: 'GET',
    });
    expect(preflight.canExport).toBe(false);
    expect(preflight.reason).toBe('VERIFIER_GATE_BLOCKED');
  });

  it('opts into artifact detail v2 while normalizing an old strict v1 response', async () => {
    const calls: string[] = [];
    const v1 = {
      id: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      title: 'legacy artifact',
      headVersion: 1,
      versions: [{
        id: '33333333-3333-4333-8333-333333333333',
        versionNo: 1,
        content: 'legacy',
        note: '',
        authorUserId: null,
        authorName: null,
        sourceThreadId: null,
        sourceMessageId: null,
        createdAt: '2026-07-14T00:00:00.000Z',
      }],
    };
    const fakeFetch = vi.fn((url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify(v1), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    const detail = await client.artifactDetail(v1.id);
    expect(calls[0]).toBe(`/api/artifacts/${v1.id}?includeStructure=1`);
    expect(detail.versions[0]).toEqual(expect.objectContaining({ governingMessage: null, soWhat: null }));
  });

  it('fails closed without sending a mutation when the old API has no v2 capability', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).endsWith('/artifact-contract')) {
        return Promise.resolve(new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', versionNo: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    await expect(client.createArtifact({
      projectId: '22222222-2222-4222-8222-222222222222',
      title: 'rolling',
      content: 'body',
      note: '',
      structure: { governingMessage: 'governing message', soWhat: 'decision consequence' },
    })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ url: '/api/artifact-contract', body: null });
    await expect(client.supportsArtifactContractV2()).resolves.toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('sends structure through the v2 opt-in query when capability is present', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      const payload = String(url).endsWith('/artifact-contract')
        ? { version: 2 }
        : { id: '11111111-1111-4111-8111-111111111111', versionNo: 1 };
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });
    await client.createArtifact({
      projectId: '22222222-2222-4222-8222-222222222222',
      title: 'rolling',
      content: 'body',
      note: '',
      structure: { governingMessage: 'governing message', soWhat: 'decision consequence' },
    });
    expect(calls[1]?.url).toBe('/api/artifacts?includeStructure=1');
    expect(calls[1]?.body).toEqual(expect.objectContaining({ structure: expect.any(Object) }));
  });

  it('requests the next 500-item artifact review cohort by offset', async () => {
    const calls: string[] = [];
    const projectId = '22222222-2222-4222-8222-222222222222';
    const fakeFetch = vi.fn((url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({
        projectId,
        projectName: 'large project',
        cohort: { totalCandidates: 750, offset: 500, returned: 250, nextOffset: null, summaryScope: 'returned_page' },
        summary: { total: 250, critical: 0, high: 0, medium: 250, clear: 0, needsHumanReview: 250, pending: 250, approved: 0, rejected: 0, blocked: 0, invalid: 0 },
        worklist: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    const plan = await client.artifactReviewPlan(projectId, 500);
    expect(calls[0]).toBe(`/api/artifacts/projects/${projectId}/review-plan?offset=500`);
    expect(plan.cohort).toEqual(expect.objectContaining({ offset: 500, returned: 250, nextOffset: null }));
  });

  it('requests a bounded artifact list page by project and offset', async () => {
    const calls: string[] = [];
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const projectId = '22222222-2222-4222-8222-222222222222';
    const fakeFetch = vi.fn((url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ artifacts: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    const client = new ConsultingApiClient({ baseUrl: '/api', fetch: fakeFetch as unknown as typeof fetch });

    await client.listArtifacts(workspaceId, projectId, 500);
    expect(calls[0]).toBe(`/api/artifacts/workspaces/${workspaceId}?projectId=${projectId}&offset=500`);
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
    const gen = client.streamChat({ threadId: '00000000-0000-4000-8000-000000000009', message: 'hi', clientMessageId: '00000000-0000-4000-8000-000000000010' }, controller.signal);
    const pending = gen.next().catch((e) => e);
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });
});
