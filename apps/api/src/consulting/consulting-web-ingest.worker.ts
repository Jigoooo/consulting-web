import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit, Inject } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { QUEUE_NAMES } from '../queues/queue.tokens.js';
import { redactLogText } from '../security/redact-sensitive-text.js';
import {
  CONSULTING_WEB_TURN_COMPLETED_EVENT,
  type ConsultingAssistantMemoryCandidate,
  type ConsultingMemoryAllowedSegment,
  type ConsultingMemoryBlockedSegment,
  type ConsultingVerifiedContradiction,
  type ConsultingWebTurnIngestPayload,
} from './consulting-web-ingest.service.js';

const PYTHON = process.env.CONSULTING_PYTHON ?? 'python3';
const DEFAULT_WEB_INGEST = existsSync('/app/scripts/ingest_web_dialogue.py')
  ? '/app/scripts/ingest_web_dialogue.py'
  : '/home/jigoo/.hermes/workspace/consulting-web/apps/api/scripts/ingest_web_dialogue.py';
const WEB_INGEST = process.env.CONSULTING_WEB_INGEST_SCRIPT ?? DEFAULT_WEB_INGEST;

interface OutboxJobData {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  workspaceId: string;
  payload: unknown;
}

export type ConsultingWebIngestRunner = (payload: ConsultingWebTurnIngestPayload) => Promise<void>;
export const CONSULTING_WEB_INGEST_RUNNER = Symbol('CONSULTING_WEB_INGEST_RUNNER');

function redisConnectionFromUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeMemoryText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function parseAllowedSegment(value: unknown): ConsultingMemoryAllowedSegment | null {
  if (!isRecord(value)) return null;
  const id = asNonEmptyString(value.id);
  const kind = asNonEmptyString(value.kind);
  const text = asNonEmptyString(value.text);
  const reason = asNonEmptyString(value.reason) ?? 'allowed_by_memory_write_guard';
  if (!id || !text || !['user', 'document', 'tool'].includes(kind ?? '')) return null;
  return { id, kind: kind as ConsultingMemoryAllowedSegment['kind'], text, reason };
}

function parseAssistantCandidate(value: unknown): ConsultingAssistantMemoryCandidate | null {
  if (!isRecord(value)) return null;
  const id = asNonEmptyString(value.id);
  const text = asNonEmptyString(value.text);
  const sourceMessageId = asNonEmptyString(value.sourceMessageId);
  const reason = asNonEmptyString(value.reason) ?? 'assistant_output_requires_review';
  if (!id || !text || !sourceMessageId) return null;
  return { id, text, sourceMessageId, status: 'quarantined', reason };
}

function parseBlockedSegment(value: unknown): ConsultingMemoryBlockedSegment | null {
  if (!isRecord(value)) return null;
  const id = asNonEmptyString(value.id);
  const kind = asNonEmptyString(value.kind);
  const text = asNonEmptyString(value.text);
  const reason = asNonEmptyString(value.reason) ?? 'blocked_by_memory_write_guard';
  if (!id || !text || !['assistant', 'system', 'unknown'].includes(kind ?? '')) return null;
  return { id, kind: kind as ConsultingMemoryBlockedSegment['kind'], text, reason };
}

function parseVerifiedContradiction(value: unknown): ConsultingVerifiedContradiction | null {
  if (!isRecord(value)) return null;
  const verdictRef = asNonEmptyString(value.verdictRef);
  const claimId = asNonEmptyString(value.claimId);
  const claimText = asNonEmptyString(value.claimText);
  const verdict = asNonEmptyString(value.verdict);
  const confidence = asNumber(value.confidence);
  const rationale = asNonEmptyString(value.rationale);
  const evidenceItemId = asNonEmptyString(value.evidenceItemId);
  const evidenceRef = asNonEmptyString(value.evidenceRef);
  const evidenceText = asNonEmptyString(value.evidenceText);
  if (
    !verdictRef || !claimId || !claimText || !['refutes', 'mixed'].includes(verdict ?? '')
    || confidence === null || confidence < 0 || confidence > 1
    || !rationale || !evidenceItemId || !evidenceRef || !evidenceText
  ) return null;
  return {
    verdictRef,
    claimId,
    claimText,
    verdict: verdict as ConsultingVerifiedContradiction['verdict'],
    confidence,
    rationale,
    evidenceItemId,
    evidenceRef,
    evidenceText,
  };
}

export function parseConsultingWebTurnPayload(value: unknown): ConsultingWebTurnIngestPayload {
  if (!isRecord(value)) throw new Error('invalid consulting web ingest payload: not an object');
  const assistantMessageId = asNonEmptyString(value.assistantMessageId);
  const userText = asNonEmptyString(value.userText);
  const legacyAssistantText = asNonEmptyString(value.assistantText);
  if (!assistantMessageId) throw new Error('invalid consulting web ingest payload: missing assistantMessageId');

  let allowedSegments: ConsultingMemoryAllowedSegment[];
  if (value.allowedSegments !== undefined) {
    if (!Array.isArray(value.allowedSegments)) {
      throw new Error('invalid consulting web ingest payload: malformed allowed segment list');
    }
    const parsed = value.allowedSegments.map(parseAllowedSegment);
    if (parsed.some((item) => item === null)) {
      throw new Error('invalid consulting web ingest payload: malformed allowed segment');
    }
    allowedSegments = parsed as ConsultingMemoryAllowedSegment[];
  } else {
    allowedSegments = userText
      ? [{ id: `legacy-user:${assistantMessageId}`, kind: 'user', text: userText, reason: 'legacy_user_text_allowed' }]
      : [];
  }

  let assistantCandidate: ConsultingAssistantMemoryCandidate | null;
  if (value.assistantCandidate !== undefined) {
    assistantCandidate = parseAssistantCandidate(value.assistantCandidate);
    if (!assistantCandidate) {
      throw new Error('invalid consulting web ingest payload: malformed assistant candidate');
    }
  } else {
    assistantCandidate = legacyAssistantText
      ? {
          id: `legacy-assistant:${assistantMessageId}`,
          text: legacyAssistantText,
          sourceMessageId: assistantMessageId,
          status: 'quarantined',
          reason: 'legacy_assistant_text_quarantined',
        }
      : null;
  }

  let blockedSegments: ConsultingMemoryBlockedSegment[];
  if (value.blockedSegments !== undefined) {
    if (!Array.isArray(value.blockedSegments)) {
      throw new Error('invalid consulting web ingest payload: malformed blocked segment list');
    }
    const parsed = value.blockedSegments.map(parseBlockedSegment);
    if (parsed.some((item) => item === null)) {
      throw new Error('invalid consulting web ingest payload: malformed blocked segment');
    }
    blockedSegments = parsed as ConsultingMemoryBlockedSegment[];
  } else {
    blockedSegments = assistantCandidate
      ? [{ id: assistantCandidate.id, kind: 'assistant', text: assistantCandidate.text, reason: assistantCandidate.reason }]
      : [];
  }

  if (value.verifiedContradictions !== undefined && !Array.isArray(value.verifiedContradictions)) {
    throw new Error('invalid consulting web ingest payload: malformed verified contradiction list');
  }
  const parsedContradictions = Array.isArray(value.verifiedContradictions)
    ? value.verifiedContradictions.map(parseVerifiedContradiction)
    : [];
  if (parsedContradictions.some((item) => item === null)) {
    throw new Error('invalid consulting web ingest payload: malformed verified contradiction');
  }
  const verifiedContradictions = parsedContradictions as ConsultingVerifiedContradiction[];
  for (const item of verifiedContradictions) {
    if (item.verdictRef !== `assistant:${assistantMessageId}:${item.claimId}`) {
      throw new Error('invalid consulting web ingest payload: verified contradiction provenance mismatch');
    }
  }
  if (assistantCandidate?.sourceMessageId !== assistantMessageId) {
    throw new Error('invalid consulting web ingest payload: assistant provenance mismatch');
  }
  if (assistantCandidate && allowedSegments.some((segment) => (
    normalizeMemoryText(segment.text) === normalizeMemoryText(assistantCandidate.text)
  ))) {
    throw new Error('invalid consulting web ingest payload: assistant text is present in allowed segments');
  }
  if (assistantCandidate && !blockedSegments.some((segment) => (
    segment.kind === 'assistant'
    && segment.id === assistantCandidate.id
    && segment.text === assistantCandidate.text
  ))) {
    throw new Error('invalid consulting web ingest payload: assistant candidate is not quarantined');
  }

  const payload = {
    consultingTopicSlug: asNonEmptyString(value.consultingTopicSlug),
    consultingTopicId: value.consultingTopicId === null || value.consultingTopicId === undefined
      ? null
      : asNumber(value.consultingTopicId),
    sessionId: asNonEmptyString(value.sessionId),
    workspaceId: asNonEmptyString(value.workspaceId),
    projectId: asNonEmptyString(value.projectId),
    channelId: asNonEmptyString(value.channelId),
    topicId: asNonEmptyString(value.topicId),
    threadId: asNonEmptyString(value.threadId),
    scopePath: asNonEmptyString(value.scopePath),
    userText,
    allowedSegments,
    assistantCandidate,
    blockedSegments,
    policyDecisionId: asNonEmptyString(value.policyDecisionId) ?? `memory-write-guard:v1:${assistantMessageId}`,
    traceId: asNonEmptyString(value.traceId) ?? asNonEmptyString(value.runId) ?? `assistant-message:${assistantMessageId}`,
    runId: value.runId === null ? null : asNonEmptyString(value.runId),
    assistantMessageId,
    timestamp: asNumber(value.timestamp),
    verifiedContradictions,
  };
  for (const [key, item] of Object.entries(payload)) {
    if (
      (item === null || (Array.isArray(item) && item.length === 0))
      && key !== 'runId'
      && key !== 'consultingTopicId'
      && key !== 'verifiedContradictions'
    ) {
      throw new Error(`invalid consulting web ingest payload: missing ${key}`);
    }
  }
  return payload as ConsultingWebTurnIngestPayload;
}

export async function defaultConsultingWebIngestRunner(payload: ConsultingWebTurnIngestPayload): Promise<void> {
  await runPythonJson(PYTHON, [WEB_INGEST], payload, 60_000);
}

export function runPythonJson(command: string, args: string[], payload: unknown, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        ...process.env,
        CONSULTING_BRAIN_WRITE_BACKEND: process.env.CONSULTING_BRAIN_WRITE_BACKEND ?? 'pg',
        CONSULTING_BRAIN_BACKEND: process.env.CONSULTING_BRAIN_BACKEND ?? 'pg',
      },
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('consulting-web ingest timed out'));
    }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 2_000) stderr = stderr.slice(-2_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr || `consulting-web ingest failed (${code ?? 'signal'})`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

@Injectable()
export class ConsultingWebIngestWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsultingWebIngestWorker.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(CONSULTING_WEB_INGEST_RUNNER)
    private readonly runner: ConsultingWebIngestRunner = defaultConsultingWebIngestRunner,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      QUEUE_NAMES.consultingWebIngest,
      async (job) => {
        await this.processOutboxJob(job.data as OutboxJobData);
      },
      {
        connection: redisConnectionFromUrl(this.env.REDIS_URL),
        concurrency: 1,
      },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.warn(redactLogText(`consulting web ingest job ${job?.id} failed: ${err.message}`));
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  async processOutboxJob(job: OutboxJobData): Promise<void> {
    if (job.eventType !== CONSULTING_WEB_TURN_COMPLETED_EVENT) {
      throw new Error(`unsupported outbox event for consulting web ingest worker: ${job.eventType}`);
    }
    const payload = parseConsultingWebTurnPayload(job.payload);
    if (
      job.aggregateType !== 'thread'
      || job.aggregateId !== payload.threadId
      || job.workspaceId !== payload.workspaceId
    ) {
      throw new Error('invalid consulting web ingest outbox envelope');
    }
    await this.runner(payload);
  }
}
