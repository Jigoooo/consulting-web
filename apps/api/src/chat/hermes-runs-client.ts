import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  ChatApprovalChoice,
  ChatRunActionResponse,
  ChatRunStatusResponse,
  ChatRuntimeCapabilitiesResponse,
  ChatRuntimeModel,
  ChatRuntimeModelsResponse,
  ChatStreamEvent,
  ChatStreamRequest,
  ChatStreamUsage,
} from '@consulting/contracts';
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
  readonly text?: unknown;
  readonly usage?: unknown;
  readonly choices?: unknown;
  readonly command?: unknown;
  readonly message?: unknown;
  readonly reason?: unknown;
  readonly risk?: unknown;
}

interface HermesRunStatusResponse {
  readonly status?: unknown;
  readonly model?: unknown;
  readonly usage?: unknown;
  readonly last_event?: unknown;
}

interface HermesModelsResponse {
  readonly data?: unknown;
}

interface HermesCapabilitiesResponse {
  readonly model?: unknown;
  readonly features?: unknown;
}

interface HermesUsageWire {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly total_tokens?: unknown;
  readonly reasoning_tokens?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

const APPROVAL_CHOICES: ChatApprovalChoice[] = ['once', 'session', 'always', 'deny'];
const HERMES_AGENT_BRAND_RE = /^hermes(?:\s+agent)?$/i;

function stringField(record: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function splitProviderModel(value: string | undefined): { provider: string; modelName: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  const colon = trimmed.indexOf(':');
  const index = slash >= 0 && colon >= 0 ? Math.min(slash, colon) : Math.max(slash, colon);
  if (index <= 0 || index >= trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, index), modelName: trimmed.slice(index + 1) };
}

function isHermesAgentBrand(value: string | undefined): boolean {
  return Boolean(value && HERMES_AGENT_BRAND_RE.test(value.trim()));
}

function normalizeRuntimeModel(item: unknown): ChatRuntimeModel | null {
  if (!isRecord(item)) return null;
  const id = stringField(item, ['id', 'name']);
  if (!id) return null;

  const root = stringField(item, ['root']);
  const rawRoute = stringField(item, ['route', 'model_route']);
  const providerFromField = stringField(item, ['provider', 'provider_id', 'owned_by']);
  const modelFromField = stringField(item, ['model', 'model_name']);
  const idParts = splitProviderModel(id);
  const rootParts = splitProviderModel(root);
  const routeParts = splitProviderModel(rawRoute);
  const idIsBrand = isHermesAgentBrand(id);

  const provider = providerFromField ?? routeParts?.provider ?? (!idIsBrand ? idParts?.provider : undefined) ?? rootParts?.provider ?? 'unknown';
  const modelName = modelFromField ?? routeParts?.modelName ?? (!idIsBrand ? idParts?.modelName : undefined) ?? rootParts?.modelName ?? id;
  const routeCandidate = rawRoute ?? (idIsBrand ? root : id);
  const route = routeCandidate && !isHermesAgentBrand(routeCandidate)
    ? routeCandidate
    : provider !== 'unknown'
      ? `${provider}/${modelName}`
      : modelName;
  const label = provider === 'unknown' ? modelName : `${modelName} · ${provider}`;

  return {
    id,
    route,
    label,
    provider,
    modelName,
    ...(root ? { root } : {}),
    ...(typeof item.parent === 'string' || item.parent === null ? { parent: item.parent } : {}),
  };
}

/**
 * 컨설팅 응답 포맷 규약 — 매 run에 `instructions`(ephemeral_system_prompt)로
 * 주입해 지구가 처음부터 읽기 좋은 마크다운으로 답하게 유도한다. 상수로 고정해
 * 프롬프트 캐시 프리픽스를 깨지 않는다(사용자 요청: ChatGPT처럼 정돈된 답변).
 * 상류 스킬/시스템프롬프트를 덮어쓰지 않고 출력 형식만 보강한다.
 */
const CONSULTING_RESPONSE_FORMAT = [
  '## 응답 형식 지침 (컨설팅 워크스페이스)',
  '아래 형식으로 항상 읽기 좋게 구조화해 답하라. 내용/판단은 기존 지침을 따르되, 표현만 이 규약을 지킨다.',
  '',
  '- **결론 먼저**: 첫 1~2문장에 핵심 답/판단을 제시한 뒤 근거를 전개한다.',
  '- **구조화**: 항목이 3개 이상이면 짧은 헤딩(##)과 불릿(-)으로 나눈다. 긴 서술 문단을 피한다.',
  '- **표 활용**: 비교·수치·항목별 정리는 마크다운 표로 낸다. 표는 좌측 정렬을 기본으로 한다.',
  '- **강조**: 핵심 용어·수치는 **굵게**. 과용하지 않는다.',
  '- **코드/경로/명령**: 인라인은 백틱, 블록은 ``` 펜스로 감싼다. ⚠️ 백틱은 파일경로·명령어·코드 식별자·기술 토큰에만 쓴다. 숫자·기간·일반 명사(예: 5년, 5년 6월, 2668명, 창원시)에는 절대 백틱을 쓰지 않는다(값에 회색 코드 박스가 붙어 가독성을 해친다). 수치·기간 강조는 **굵게**로 한다.',
  '- **간결**: 불필요한 배경 설명·자기소개·군더더기를 넣지 않는다. 밀도 높게.',
  '- **불확실성**: 모르면 모른다고 하고, 추정은 추정이라 표시한다(근거 기반 컨설팅).',
  '- **이모지 금지**: 🔴🟡🟢✅⚠️ 등 색 원·체크·경고 이모지를 문장 앞이나 강조에 쓰지 않는다(가벼워 보인다). 심각도·우선순위는 이모지 대신 **굵은 텍스트 라벨**로 표기한다. 예: "**[중대]** …", "**[주의]** …", "**[참고]** …" 또는 "우선순위: 높음/중간/낮음". 전문 컨설팅 문서 톤을 유지한다.',
].join('\n');

@Injectable()
export class HermesRunsClient {
  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async *streamChat(cmd: ChatStreamRequest, scope?: { workspaceId: string; projectId: string; memoryContext?: string }): AsyncGenerator<ChatStreamEvent> {
    let runId: string | undefined;
    try {
      runId = await this.startRun(cmd, scope);
      const status = await this.getRunStatus(runId).catch(() => null);
      const model = typeof status?.model === 'string' ? status.model : undefined;
      yield { type: 'start', runId, threadId: cmd.threadId, ts: new Date().toISOString(), ...(model ? { model } : {}) };

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
        if (eventType === 'reasoning.available') {
          const text = typeof upstream.text === 'string' ? upstream.text.slice(0, 2_000) : '';
          yield { type: 'reasoning', runId, text };
          continue;
        }
        if (eventType === 'approval.request') {
          yield this.normalizeApprovalEvent(runId, upstream);
          continue;
        }
        if (eventType === 'run.completed') {
          const usage = this.normalizeUsage(upstream.usage);
          yield { type: 'done', runId, ...(usage ? { usage } : {}) };
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

  private async startRun(cmd: ChatStreamRequest, scope?: { workspaceId: string; projectId: string; memoryContext?: string }): Promise<string> {
    // #3 (B1): share Hermes dialogue memory across ALL channels of a project so
    // 지구 remembers context from sibling channels. Session is scoped by
    // workspace+project so other projects/workspaces stay fully isolated
    // ("★듀얼스토어" isolation). Falls back to thread scope when project is
    // unknown. NOTE: the on-screen transcript is still per-thread (chat_messages
    // is threadId-scoped) — only 지구's memory is project-wide.
    const sessionId = scope
      ? this.stableSessionId('project', scope.workspaceId, scope.projectId)
      : this.stableSessionId('thread', cmd.threadId);
    const payload: Record<string, unknown> = {
      input: cmd.message,
      session_id: sessionId,
      // 답변 포맷 규약 + 기존 consulting GraphRAG 참고 기억을 ephemeral_system_prompt로 주입한다.
      instructions: this.instructions(scope?.memoryContext),
    };
    if (cmd.model) payload.model = cmd.model;
    const response = await fetch(this.url('/v1/runs'), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
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

  private async getRunStatus(runId: string): Promise<HermesRunStatusResponse> {
    const response = await fetch(this.url(`/v1/runs/${encodeURIComponent(runId)}`), {
      method: 'GET',
      headers: this.headers({ accept: 'application/json' }),
    });
    if (!response.ok) return {};
    const body: unknown = await response.json();
    if (!isRecord(body)) return {};
    return {
      ...(typeof body.status === 'string' ? { status: body.status } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(isRecord(body.usage) ? { usage: body.usage } : {}),
      ...(typeof body.last_event === 'string' ? { last_event: body.last_event } : {}),
    };
  }

  async listModels(): Promise<ChatRuntimeModelsResponse> {
    const response = await fetch(this.url('/v1/models'), {
      method: 'GET',
      headers: this.headers({ accept: 'application/json' }),
    });
    if (!response.ok) throw new Error(`Hermes models failed (${response.status})`);
    const body = await response.json() as HermesModelsResponse;
    const rawModels = Array.isArray(body.data) ? body.data : [];
    const models: ChatRuntimeModel[] = rawModels.flatMap((item) => {
      const normalized = normalizeRuntimeModel(item);
      return normalized ? [normalized] : [];
    });
    return { ...(models[0]?.route ? { defaultModel: models[0].route } : {}), models };
  }

  async capabilities(): Promise<ChatRuntimeCapabilitiesResponse> {
    const response = await fetch(this.url('/v1/capabilities'), {
      method: 'GET',
      headers: this.headers({ accept: 'application/json' }),
    });
    if (!response.ok) throw new Error(`Hermes capabilities failed (${response.status})`);
    const body = await response.json() as HermesCapabilitiesResponse;
    const features = isRecord(body.features) ? body.features : {};
    return {
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      features: {
        modelRouting: true,
        runStop: features.run_stop === true,
        runApprovalResponse: features.run_approval_response === true,
        approvalEvents: features.approval_events === true,
      },
    };
  }

  async runStatus(runId: string): Promise<ChatRunStatusResponse> {
    return this.normalizeRunStatus(runId, await this.getRunStatus(runId));
  }

  async stopRun(runId: string): Promise<ChatRunActionResponse> {
    const response = await fetch(this.url(`/v1/runs/${encodeURIComponent(runId)}/stop`), {
      method: 'POST',
      headers: this.headers({ accept: 'application/json' }),
    });
    if (!response.ok) throw new Error(`Hermes stop failed (${response.status})`);
    const body: unknown = await response.json();
    const status = isRecord(body) && typeof body.status === 'string' ? body.status : 'stopping';
    return { ok: true, runId, status };
  }

  async respondApproval(runId: string, choice: ChatApprovalChoice, resolveAll?: boolean): Promise<ChatRunActionResponse> {
    const response = await fetch(this.url(`/v1/runs/${encodeURIComponent(runId)}/approval`), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify({ choice, ...(resolveAll ? { resolve_all: true } : {}) }),
    });
    if (!response.ok) throw new Error(`Hermes approval failed (${response.status})`);
    return { ok: true, runId, status: choice === 'deny' ? 'denied' : 'approved' };
  }

  private stableSessionId(kind: 'project' | 'thread', ...parts: string[]): string {
    const hash = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 40);
    // Hermes prompt_cache_key/session key limit is 64 chars; keep a readable prefix + stable hash.
    return `cw-${kind}:${hash}`;
  }

  private instructions(memoryContext: string | undefined): string {
    const trimmed = memoryContext?.trim();
    return trimmed ? `${CONSULTING_RESPONSE_FORMAT}\n\n${trimmed}` : CONSULTING_RESPONSE_FORMAT;
  }

  private normalizeUsage(raw: unknown): ChatStreamUsage | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const usage = raw as HermesUsageWire;
    const out: ChatStreamUsage = {};
    if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;
    if (typeof usage.total_tokens === 'number') out.totalTokens = usage.total_tokens;
    if (typeof usage.reasoning_tokens === 'number') out.reasoningTokens = usage.reasoning_tokens;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private normalizeRunStatus(runId: string, raw: HermesRunStatusResponse): ChatRunStatusResponse {
    const usage = this.normalizeUsage(raw.usage);
    return {
      runId,
      status: typeof raw.status === 'string' ? raw.status : 'unknown',
      ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
      ...(typeof raw.last_event === 'string' ? { lastEvent: raw.last_event } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  private normalizeApprovalEvent(runId: string, upstream: HermesRunSseEvent): ChatStreamEvent {
    const choices = Array.isArray(upstream.choices)
      ? upstream.choices.filter((c): c is ChatApprovalChoice => APPROVAL_CHOICES.includes(c as ChatApprovalChoice))
      : APPROVAL_CHOICES;
    const command = typeof upstream.command === 'string' ? upstream.command.slice(0, 2_000) : undefined;
    const message =
      typeof upstream.message === 'string'
        ? upstream.message.slice(0, 2_000)
        : typeof upstream.reason === 'string'
          ? upstream.reason.slice(0, 2_000)
          : undefined;
    const risk = typeof upstream.risk === 'string' ? upstream.risk.slice(0, 120) : undefined;
    return {
      type: 'approval',
      runId,
      choices: choices.length > 0 ? choices : APPROVAL_CHOICES,
      ...(command ? { command } : {}),
      ...(message ? { message } : {}),
      ...(risk ? { risk } : {}),
    };
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
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
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
      // 모든 필드가 optional(unknown)인 이벤트 형태 — object면 그대로 수용
      return parsed && typeof parsed === 'object' ? parsed : null;
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
