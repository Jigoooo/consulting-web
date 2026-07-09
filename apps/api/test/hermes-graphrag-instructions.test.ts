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
  VAPID_SUBJECT: 'mailto:admin@localhost',
};

describe('HermesRunsClient GraphRAG instructions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds consulting GraphRAG memory context to the run instructions', async () => {
    const requests: Array<{ url: string; body: string | null }> = [];
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
        return new Response(JSON.stringify({ data: [{ name: 'web', enabled: true }, { name: 'mcp-github', enabled: false }] }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        return new Response(JSON.stringify({ run_id: 'run_graph', status: 'started' }), { status: 202 });
      }
      if (url.endsWith('/v1/runs/run_graph')) {
        return new Response(JSON.stringify({ model: 'test-model' }), { status: 200 });
      }
      if (url.endsWith('/v1/runs/run_graph/events')) {
        return new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    });

    const client = new HermesRunsClient(env);
    const out = [];
    for await (const event of client.streamChat(
      { threadId: 'thread-1', message: '정원 인건비 조직진단' },
      { workspaceId: 'ws-1', projectId: 'project-1', memoryContext: '## 기존 컨설팅 GraphRAG 참고 기억\nCL-D5-01 정원·인건비' },
    )) {
      out.push(event.type);
    }

    expect(out).toContain('done');
    const start = requests.find((r) => r.url.endsWith('/v1/runs'));
    expect(start?.body).toBeTruthy();
    const body = JSON.parse(start!.body!) as { instructions: string; session_id: string };
    expect(body.session_id).toMatch(/^cw-project:[a-f0-9]{40}$/);
    expect(body.session_id.length).toBeLessThanOrEqual(64);
    expect(body.instructions).toContain('## 응답 형식 지침');
    expect(body.instructions).toContain('## 기존 컨설팅 GraphRAG 참고 기억');
    expect(body.instructions).toContain('CL-D5-01');
  });

  it('forwards selected model and normalizes approval/runtime controls', async () => {
    const requests: Array<{ url: string; body: string | null; method: string | undefined }> = [];
    const events = [
      'data: {"event":"approval.request","run_id":"run_runtime","choices":["always","once","session","deny"],"command":"echo ok"}',
      '',
      'data: {"event":"run.completed","run_id":"run_runtime","usage":{"total_tokens":7}}',
      '',
    ].join('\n');

    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === 'string' ? init.body : null;
      requests.push({ url, body, method: init?.method });
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify({ data: [{ name: 'web', enabled: true }, { name: 'terminal', enabled: true }] }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        return new Response(JSON.stringify({ run_id: 'run_runtime', status: 'started' }), { status: 202 });
      }
      if (url.endsWith('/v1/runs/run_runtime')) {
        return new Response(JSON.stringify({ status: 'running', model: 'gpt-5.5' }), { status: 200 });
      }
      if (url.endsWith('/v1/runs/run_runtime/events')) {
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
    for await (const event of client.streamChat({ threadId: 'thread-1', message: '실행', model: 'gpt-5.5' })) {
      out.push(event);
    }
    expect(out.find((e) => e.type === 'approval')).toMatchObject({ type: 'approval', command: 'echo ok', choices: ['once', 'session', 'deny'] });
    expect(out.find((e) => e.type === 'done')).toMatchObject({ type: 'done', usage: { totalTokens: 7 } });
    const start = requests.find((r) => r.url.endsWith('/v1/runs'));
    expect(JSON.parse(start!.body!)).toMatchObject({ model: 'gpt-5.5' });

    await expect(client.respondApproval('run_runtime', 'once')).resolves.toEqual({ ok: true, runId: 'run_runtime', status: 'approved' });
    await expect(client.respondApproval('run_runtime', 'always')).rejects.toThrow(/durable product approval policy/);
    await expect(client.respondApproval('run_runtime', 'once', true)).rejects.toThrow(/resolveAll requires a durable product approval policy/);
    await expect(client.stopRun('run_runtime')).resolves.toEqual({ ok: true, runId: 'run_runtime', status: 'stopping' });
  });

  it('fails closed before run start when Hermes exposes a non-allowlisted toolset', async () => {
    const requests: Array<{ url: string; body: string | null }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === 'string' ? init.body : null;
      requests.push({ url, body });
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify({ data: [{ name: 'web', enabled: true }, { name: 'mcp-github', enabled: true }] }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        return new Response(JSON.stringify({ run_id: 'should_not_start', status: 'started' }), { status: 202 });
      }
      return new Response('not found', { status: 404 });
    });

    const client = new HermesRunsClient(env);
    const out = [];
    for await (const event of client.streamChat({ threadId: 'thread-1', message: '실행' })) {
      out.push(event);
    }

    expect(out).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'HERMES_PROXY_ERROR',
        message: expect.stringContaining('Hermes tool policy blocked enabled toolsets: mcp-github'),
      }),
    ]);
    expect(requests.some((request) => request.url.endsWith('/v1/runs'))).toBe(false);
  });

  it('allows explicitly allowlisted MCP/toolsets before run start', async () => {
    const requests: Array<{ url: string; body: string | null }> = [];
    const events = [
      'data: {"event":"run.completed","run_id":"run_tool_policy"}',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === 'string' ? init.body : null;
      requests.push({ url, body });
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify({ data: [{ name: 'web', enabled: true }, { name: 'mcp-github', enabled: true }] }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) {
        return new Response(JSON.stringify({ run_id: 'run_tool_policy', status: 'started' }), { status: 202 });
      }
      if (url.endsWith('/v1/runs/run_tool_policy')) {
        return new Response(JSON.stringify({ model: 'test-model' }), { status: 200 });
      }
      if (url.endsWith('/v1/runs/run_tool_policy/events')) {
        return new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    });

    const client = new HermesRunsClient({ ...env, HERMES_ALLOWED_TOOLSETS: 'web,mcp-github' });
    const out = [];
    for await (const event of client.streamChat({ threadId: 'thread-1', message: '실행' })) {
      out.push(event.type);
    }

    expect(out).toContain('done');
    expect(requests.some((request) => request.url.endsWith('/v1/runs'))).toBe(true);
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
