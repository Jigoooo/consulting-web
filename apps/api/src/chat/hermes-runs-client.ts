import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import { redactPii } from '../security/pii-redaction.js';
import { redactSensitiveText } from '../security/redact-sensitive-text.js';
import { buildToolPolicyAudit, evaluateToolPolicy, type ToolPolicyResult } from '../security/tool-policy.js';
import { ToolPolicyAuditStore } from '../security/tool-policy-audit.store.js';

interface HermesRunStartResponse {
  readonly run_id?: unknown;
  readonly status?: unknown;
  readonly tool_inventory_hash?: unknown;
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
  readonly tool_id?: unknown;
  readonly pattern_key?: unknown;
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

interface HermesToolsetsResponse {
  readonly object?: unknown;
  readonly platform?: unknown;
  readonly inventory_complete?: unknown;
  readonly inventory_hash?: unknown;
  readonly effective_toolsets?: unknown;
  readonly effective_tools?: unknown;
  readonly data?: unknown;
}

interface HermesToolsetStatus {
  readonly name: string;
  readonly enabled: boolean;
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

function normalizeUniqueStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    return null;
  }
  const normalized = value.map((item) => String(item).trim().toLowerCase());
  return new Set(normalized).size === normalized.length ? normalized.sort() : null;
}


const HERMES_STOP_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;

class HermesRunStartError extends Error {
  constructor(message: string, readonly mayHaveStarted: boolean) {
    super(message);
    this.name = 'HermesRunStartError';
  }
}

const HERMES_AGENT_BRAND_RE = /^hermes(?:[\s_-]+agent)?$/i;
const DEFAULT_ALLOWED_HERMES_TOOLSETS = [
  // Explicit allowlist for the current consulting-web API-server chat path.
  // Dynamic/high-blast-radius toolsets (MCP, messaging, Discord/admin,
  // Home Assistant, TTS, X search) stay denied; config allowlisting alone is
  // insufficient and a dedicated per-action approval path is required.
  'web',
  'search',
  'terminal',
  'file',
  'browser',
  'vision',
  'image_gen',
  'skills',
  'memory',
  'session_search',
  'cronjob',
  'code_execution',
  'delegation',
  'todo',
  'safe',
] as const;

function parseCommaList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

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

function stripYamlScalar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutComment = value.split('#')[0]?.trim() ?? '';
  if (!withoutComment) return undefined;
  if ((withoutComment.startsWith('"') && withoutComment.endsWith('"')) || (withoutComment.startsWith("'") && withoutComment.endsWith("'"))) {
    return withoutComment.slice(1, -1).trim() || undefined;
  }
  return withoutComment;
}

function configuredRoute(provider: string | undefined, model: string | undefined): ChatRuntimeModel | null {
  const modelValue = stripYamlScalar(model);
  if (!modelValue || isHermesAgentBrand(modelValue)) return null;
  const modelParts = splitProviderModel(modelValue);
  const providerValue = stripYamlScalar(provider) ?? modelParts?.provider ?? 'unknown';
  const modelName = modelParts?.modelName ?? modelValue;
  const route = providerValue !== 'unknown' && !modelParts ? `${providerValue}/${modelName}` : modelValue;
  return {
    id: `config:${route}`,
    route,
    label: providerValue === 'unknown' ? modelName : `${modelName} · ${providerValue}`,
    provider: providerValue,
    modelName,
    root: route,
  };
}

function parseHermesConfigModels(configText: string): ChatRuntimeModel[] {
  const lines = configText.split(/\r?\n/);
  const fallbackModels: ChatRuntimeModel[] = [];
  let inModel = false;
  let inFallback = false;
  let modelProvider: string | undefined;
  let modelName: string | undefined;
  let fallbackItem: { provider?: string; model?: string } | null = null;

  const flushFallback = () => {
    const model = configuredRoute(fallbackItem?.provider, fallbackItem?.model);
    if (model) fallbackModels.push(model);
    fallbackItem = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    if (/^\S/.test(line)) {
      if (inFallback) flushFallback();
      inModel = /^model:\s*(?:#.*)?$/.test(line);
      inFallback = /^fallback_providers:\s*(?:#.*)?$/.test(line);
      continue;
    }

    if (inModel) {
      const match = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match?.[1] === 'provider') modelProvider = match[2];
      if (match?.[1] === 'default' || match?.[1] === 'model') modelName = match[2];
      continue;
    }

    if (inFallback) {
      const itemStart = line.match(/^\s{2}-\s*([A-Za-z0-9_-]+):\s*(.*)$/);
      if (itemStart) {
        flushFallback();
        const value = itemStart[2] ?? '';
        fallbackItem = {};
        if (itemStart[1] === 'provider') fallbackItem.provider = value;
        if (itemStart[1] === 'model') fallbackItem.model = value;
        continue;
      }
      const field = line.match(/^\s{4}([A-Za-z0-9_-]+):\s*(.*)$/);
      if (field && fallbackItem) {
        const value = field[2] ?? '';
        if (field[1] === 'provider') fallbackItem.provider = value;
        if (field[1] === 'model') fallbackItem.model = value;
      }
    }
  }
  if (inFallback) flushFallback();

  const primary = configuredRoute(modelProvider, modelName);
  const models = primary ? [primary, ...fallbackModels] : fallbackModels;
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.route)) return false;
    seen.add(model.route);
    return true;
  });
}

function isGenericHermesModel(model: ChatRuntimeModel): boolean {
  return isHermesAgentBrand(model.id) || isHermesAgentBrand(model.route) || isHermesAgentBrand(model.root);
}

function mergeModelRoutes(configured: ChatRuntimeModel[], upstream: ChatRuntimeModel[]): ChatRuntimeModel[] {
  const candidates = configured.length > 0 ? [...configured, ...upstream.filter((model) => !isGenericHermesModel(model))] : upstream;
  const seen = new Set<string>();
  return candidates.filter((model) => {
    if (seen.has(model.route)) return false;
    seen.add(model.route);
    return true;
  });
}

function normalizeToolsetStatus(item: unknown): HermesToolsetStatus | null {
  if (!isRecord(item)) return null;
  const name = stringField(item, ['name', 'id']);
  if (!name || typeof item.enabled !== 'boolean') return null;
  return { name: name.toLowerCase(), enabled: item.enabled };
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
  private readonly logger = new Logger(HermesRunsClient.name);

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Optional() private readonly toolPolicyAudits?: ToolPolicyAuditStore,
  ) {}

  async *streamChat(
    cmd: ChatStreamRequest,
    scope?: { workspaceId: string; projectId: string; memoryContext?: string },
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    let runId: string | undefined;
    let runSubmissionAttempted = false;
    let terminalObserved = false;
    let cleanupAttempted = false;
    try {
      runId = `run_${randomUUID().replaceAll('-', '')}`;
      const toolInventoryHash = await this.enforceHermesToolPolicy(scope?.workspaceId, runId, signal);
      await this.enforceHermesRunClientIdentity(signal);
      runSubmissionAttempted = true;
      try {
        await this.startRun(cmd, scope, runId, toolInventoryHash, signal);
      } catch (error) {
        if (error instanceof HermesRunStartError && !error.mayHaveStarted) {
          runSubmissionAttempted = false;
        }
        throw error;
      }
      const status = await this.getRunStatus(runId, signal).catch(() => null);
      const model = typeof status?.model === 'string' ? status.model : undefined;
      yield { type: 'start', runId, threadId: cmd.threadId, ts: new Date().toISOString(), ...(model ? { model } : {}) };

      for await (const upstream of this.readRunEvents(runId, signal)) {
        const eventType = typeof upstream.event === 'string' ? upstream.event : '';
        if (eventType === 'message.delta') {
          const text = typeof upstream.delta === 'string' ? upstream.delta : '';
          if (text) yield { type: 'delta', runId, text };
          continue;
        }
        if (eventType === 'tool.started' || eventType === 'tool.completed') {
          const tool = typeof upstream.tool === 'string' ? upstream.tool : '';
          if (tool) {
            const preview = typeof upstream.preview === 'string'
              ? redactPii(redactSensitiveText(upstream.preview)).slice(0, 500)
              : undefined;
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
          const text = typeof upstream.text === 'string'
            ? redactPii(redactSensitiveText(upstream.text)).slice(0, 2_000)
            : '';
          yield { type: 'reasoning', runId, text };
          continue;
        }
        if (eventType === 'approval.request') {
          yield this.normalizeApprovalEvent(runId, upstream);
          continue;
        }
        if (eventType === 'run.completed') {
          terminalObserved = true;
          const usage = this.normalizeUsage(upstream.usage);
          yield { type: 'done', runId, ...(usage ? { usage } : {}) };
          return;
        }
        if (eventType === 'run.failed') {
          terminalObserved = true;
          yield {
            type: 'error',
            runId,
            code: 'HERMES_RUN_FAILED',
            message: this.safeErrorMessage(upstream.error, 'Hermes run failed'),
          };
          return;
        }
        if (eventType === 'run.cancelled') {
          terminalObserved = true;
          yield { type: 'error', runId, code: 'HERMES_RUN_CANCELLED', message: 'Hermes run was cancelled' };
          return;
        }
      }

      if (signal?.aborted) return;
      const terminalStatus = await this.getRunStatus(runId).catch(() => null);
      if (terminalStatus?.status === 'completed') {
        terminalObserved = true;
        const usage = this.normalizeUsage(terminalStatus.usage);
        yield { type: 'done', runId, ...(usage ? { usage } : {}) };
        return;
      }
      if (terminalStatus?.status === 'failed') {
        terminalObserved = true;
        yield { type: 'error', runId, code: 'HERMES_RUN_FAILED', message: 'Hermes run failed' };
        return;
      }
      if (terminalStatus?.status === 'cancelled') {
        terminalObserved = true;
        yield { type: 'error', runId, code: 'HERMES_RUN_CANCELLED', message: 'Hermes run was cancelled' };
        return;
      }
      cleanupAttempted = true;
      await this.stopSubmittedRun(runId).catch((error: unknown) => {
        this.logger.warn(`Hermes run stop after incomplete stream failed: ${this.safeErrorMessage(error, 'stop failed')}`);
      });
      yield {
        type: 'error',
        runId,
        code: 'HERMES_STREAM_INCOMPLETE',
        message: 'Hermes event stream ended without a terminal run state',
      };
    } catch (error) {
      if (signal?.aborted) return;
      yield {
        type: 'error',
        ...(runId ? { runId } : {}),
        code: 'HERMES_PROXY_ERROR',
        message: this.safeErrorMessage(error, 'Hermes proxy failed'),
      };
    } finally {
      if (runSubmissionAttempted && runId && !terminalObserved && !cleanupAttempted) {
        await this.stopSubmittedRun(runId).catch((error: unknown) => {
          this.logger.warn(`Hermes run cleanup before terminal state failed: ${this.safeErrorMessage(error, 'stop failed')}`);
        });
      }
    }
  }

  private async startRun(
    cmd: ChatStreamRequest,
    scope?: { workspaceId: string; projectId: string; memoryContext?: string },
    clientRunId?: string,
    toolInventoryHash?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // Scope isolation: Hermes dialogue state follows the exact web thread.
    // Sharing a project-scoped session leaks sibling channel/topic conversations even
    // when GraphRAG retrieval itself is exact-scope. Cross-scope evidence is handled
    // separately through an explicit, provenance-bearing retrieval allow-list.
    const sessionId = scope
      ? this.stableSessionId('thread', scope.workspaceId, scope.projectId, cmd.threadId)
      : this.stableSessionId('thread', cmd.threadId);
    const payload: Record<string, unknown> = {
      input: cmd.message,
      session_id: sessionId,
      ...(clientRunId ? { client_run_id: clientRunId } : {}),
      ...(toolInventoryHash ? { tool_inventory_hash: toolInventoryHash } : {}),
      // 답변 포맷 규약 + 기존 consulting GraphRAG 참고 기억을 ephemeral_system_prompt로 주입한다.
      instructions: this.instructions(scope?.memoryContext),
    };
    if (cmd.model) payload.model = cmd.model;
    let response: Response;
    try {
      response = await fetch(this.url('/v1/runs'), {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new HermesRunStartError(this.safeErrorMessage(error, 'Hermes run start transport failed'), true);
    }
    if (!response.ok) {
      throw new HermesRunStartError(`Hermes run start failed (${response.status})`, response.status >= 500);
    }
    let body: HermesRunStartResponse;
    try {
      body = await response.json() as HermesRunStartResponse;
    } catch (error) {
      throw new HermesRunStartError(this.safeErrorMessage(error, 'Hermes run start returned invalid JSON'), true);
    }
    if (typeof body.run_id !== 'string' || body.run_id.length === 0) {
      throw new HermesRunStartError('Hermes run start returned invalid run_id', true);
    }
    if (clientRunId && body.run_id !== clientRunId) {
      await this.stopRun(body.run_id).catch(() => undefined);
      throw new HermesRunStartError('Hermes run start did not honor client_run_id', true);
    }
    if (toolInventoryHash && body.tool_inventory_hash !== toolInventoryHash) {
      await this.stopRun(body.run_id).catch(() => undefined);
      throw new HermesRunStartError('Hermes run start did not honor tool_inventory_hash', true);
    }
    return body.run_id;
  }

  private async enforceHermesToolPolicy(workspaceId: string | undefined, runId: string, signal?: AbortSignal): Promise<string> {
    const baseAllowlist = parseCommaList(this.env.HERMES_ALLOWED_TOOLSETS);
    if (baseAllowlist.length === 0) baseAllowlist.push(...DEFAULT_ALLOWED_HERMES_TOOLSETS);
    if (this.env.APP_ENV === 'production' && !this.toolPolicyAudits) {
      throw new Error('Hermes tool policy audit store is required in production');
    }

    let response: Response;
    try {
      response = await fetch(this.url('/v1/toolsets'), {
        method: 'GET',
        headers: this.headers({ accept: 'application/json' }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      await this.recordToolPolicyAudit(workspaceId, runId, evaluateToolPolicy({
        enabledToolsets: ['__policy_check_unavailable__'], baseAllowlist, enforced: true,
      }), []);
      throw error;
    }
    if (!response.ok) {
      await this.recordToolPolicyAudit(workspaceId, runId, evaluateToolPolicy({
        enabledToolsets: ['__policy_check_unavailable__'], baseAllowlist, enforced: true,
      }), []);
      throw new Error(`Hermes tool policy check failed (${response.status})`);
    }

    let body: HermesToolsetsResponse;
    try {
      body = await response.json() as HermesToolsetsResponse;
    } catch (error) {
      const incomplete = evaluateToolPolicy({
        enabledToolsets: ['__policy_inventory_incomplete__'], baseAllowlist, enforced: true,
      });
      await this.recordToolPolicyAudit(workspaceId, runId, incomplete, ['__policy_inventory_incomplete__']);
      throw error;
    }
    const rawStatuses = Array.isArray(body.data) ? body.data : [];
    const statuses = rawStatuses
      .flatMap((item) => {
        const status = normalizeToolsetStatus(item);
        return status ? [status] : [];
      });
    const statusNames = statuses.map((status) => status.name);
    const effectiveToolsets = normalizeUniqueStringArray(body.effective_toolsets);
    const effectiveTools = normalizeUniqueStringArray(body.effective_tools);
    const inventoryHash = typeof body.inventory_hash === 'string' && /^[0-9a-f]{64}$/.test(body.inventory_hash)
      ? body.inventory_hash
      : null;
    const enabled = statuses.filter((toolset) => toolset.enabled).map((toolset) => toolset.name).sort();
    const inventoryComplete = body.object === 'list'
      && body.platform === 'api_server'
      && body.inventory_complete === true
      && rawStatuses.length > 0
      && statuses.length === rawStatuses.length
      && new Set(statusNames).size === statusNames.length
      && effectiveToolsets !== null
      && effectiveToolsets.length > 0
      && effectiveTools !== null
      && effectiveTools.length > 0
      && inventoryHash !== null
      && JSON.stringify(effectiveToolsets) === JSON.stringify(enabled);
    if (!inventoryComplete) {
      const incomplete = evaluateToolPolicy({
        enabledToolsets: ['__policy_inventory_incomplete__'], baseAllowlist, enforced: true,
      });
      await this.recordToolPolicyAudit(workspaceId, runId, incomplete, ['__policy_inventory_incomplete__']);
      throw new Error('Hermes tool policy inventory is incomplete');
    }
    const result = evaluateToolPolicy({
      enabledToolsets: enabled,
      baseAllowlist,
      enforced: this.env.APP_ENV === 'production' || this.env.HERMES_TOOL_POLICY_ENFORCED !== false,
    });

    await this.recordToolPolicyAudit(workspaceId, runId, result, enabled);
    if (result.decision === 'deny') {
      throw new Error(`Hermes tool policy blocked enabled toolsets: ${result.blockedToolsets.join(', ')}`);
    }
    return inventoryHash;
  }

  private async recordToolPolicyAudit(
    workspaceId: string | undefined,
    runId: string,
    result: ToolPolicyResult,
    enabled: string[],
  ): Promise<void> {
    if (!this.toolPolicyAudits) return;
    if (!workspaceId) throw new Error('Hermes tool policy audit requires workspace scope');
    const audit = buildToolPolicyAudit(
      { workspaceId, runId, decidedAtIso: new Date().toISOString() },
      result,
      enabled,
      (payload) => createHash('sha256').update(payload).digest('hex'),
    );
    await this.toolPolicyAudits.record(audit);
  }

  private async enforceHermesRunClientIdentity(signal?: AbortSignal): Promise<void> {
    const response = await fetch(this.url('/v1/capabilities'), {
      method: 'GET',
      headers: this.headers({ accept: 'application/json' }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Hermes capabilities failed (${response.status})`);
    }
    const body = await response.json() as HermesCapabilitiesResponse;
    const features = isRecord(body.features) ? body.features : {};
    if (features.run_client_idempotency !== true || features.run_tool_inventory_binding !== true) {
      throw new Error('Hermes client run idempotency and tool inventory binding capabilities are required');
    }
  }

  private async getRunStatus(runId: string, signal?: AbortSignal): Promise<HermesRunStatusResponse> {
    const response = await fetch(this.url(`/v1/runs/${encodeURIComponent(runId)}`), {
      method: 'GET',
      headers: this.headers({ accept: 'application/json' }),
      ...(signal ? { signal } : {}),
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
    const configuredModels = await this.configuredModels();
    let upstreamModels: ChatRuntimeModel[] = [];
    try {
      const response = await fetch(this.url('/v1/models'), {
        method: 'GET',
        headers: this.headers({ accept: 'application/json' }),
      });
      if (response.ok) {
        const body = await response.json() as HermesModelsResponse;
        const rawModels = Array.isArray(body.data) ? body.data : [];
        upstreamModels = rawModels.flatMap((item) => {
          const normalized = normalizeRuntimeModel(item);
          return normalized ? [normalized] : [];
        });
      }
    } catch {
      // Model listing is optional UI metadata. Chat streaming can still run
      // with no explicit model, and configured routes remain usable even when
      // the Hermes gateway rejects /v1/models (e.g. key rotation mismatch).
    }
    const merged = mergeModelRoutes(configuredModels, upstreamModels);
    return { ...(merged[0]?.route ? { defaultModel: merged[0].route } : {}), models: merged };
  }

  private async configuredModels(): Promise<ChatRuntimeModel[]> {
    const configPath = this.env.HERMES_CONFIG_PATH?.trim();
    if (!configPath) return [];
    try {
      return parseHermesConfigModels(await readFile(configPath, 'utf8'));
    } catch {
      return [];
    }
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
    return await this.stopRunWithRetry(runId, false);
  }

  private async stopSubmittedRun(runId: string): Promise<ChatRunActionResponse> {
    return await this.stopRunWithRetry(runId, true);
  }

  private async stopRunWithRetry(runId: string, retryNotFound: boolean): Promise<ChatRunActionResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= HERMES_STOP_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await fetch(this.url(`/v1/runs/${encodeURIComponent(runId)}/stop`), {
          method: 'POST',
          headers: this.headers({ accept: 'application/json' }),
        });
        if (response.ok) {
          const body: unknown = await response.json().catch(() => ({}));
          const status = isRecord(body) && typeof body.status === 'string' ? body.status : 'stopping';
          return { ok: true, runId, status };
        }
        lastError = new Error(`Hermes stop failed (${response.status})`);
        const retryable = response.status >= 500 || (retryNotFound && response.status === 404);
        if (!retryable) throw lastError;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const statusMatch = message.match(/\((\d{3})\)$/);
        const status = statusMatch ? Number(statusMatch[1]) : null;
        if (status !== null && status < 500 && !(retryNotFound && status === 404)) throw error;
      }
      const retryDelay = HERMES_STOP_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) break;
      await delay(retryDelay);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async respondApproval(runId: string, choice: ChatApprovalChoice, resolveAll?: boolean): Promise<ChatRunActionResponse> {
    if (choice === 'always') {
      throw new Error('Hermes approval choice "always" requires a durable product approval policy');
    }
    if (resolveAll) {
      throw new Error('Hermes approval resolveAll requires a durable product approval policy');
    }
    if (choice !== 'deny') {
      throw new Error('Hermes positive approval requires an action-bound upstream approval protocol');
    }
    const response = await fetch(this.url(`/v1/runs/${encodeURIComponent(runId)}/approval`), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify({ choice, ...(resolveAll ? { resolve_all: true } : {}) }),
    });
    if (!response.ok) throw new Error(`Hermes approval failed (${response.status})`);
    return { ok: true, runId, status: choice === 'deny' ? 'denied' : 'approved' };
  }

  private stableSessionId(kind: 'thread', ...parts: string[]): string {
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
    const toolId = [upstream.tool_id, upstream.tool, upstream.pattern_key]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      ?.trim().slice(0, 120);
    const risk = typeof upstream.risk === 'string' ? upstream.risk.slice(0, 120) : undefined;
    const choices: ChatApprovalChoice[] = ['deny'];
    const publicText = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined;
      return redactPii(redactSensitiveText(value)).slice(0, 2_000) || undefined;
    };
    const command = publicText(upstream.command);
    const message = publicText(upstream.message) ?? publicText(upstream.reason);
    return {
      type: 'approval',
      runId,
      choices: choices.length > 0 ? choices : ['deny'],
      ...(toolId ? { toolId } : {}),
      ...(command ? { command } : {}),
      ...(message ? { message } : {}),
      ...(risk ? { risk } : {}),
    };
  }

  private async *readRunEvents(runId: string, signal?: AbortSignal): AsyncGenerator<HermesRunSseEvent> {
    const response = await fetch(this.url(`/v1/runs/${encodeURIComponent(runId)}/events`), {
      method: 'GET',
      headers: this.headers({ accept: 'text/event-stream' }),
      ...(signal ? { signal } : {}),
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
    return redactPii(redactSensitiveText(
      raw
        .split(this.env.HERMES_API_KEY).join('[redacted]')
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]'),
    )).slice(0, 500);
  }
}
