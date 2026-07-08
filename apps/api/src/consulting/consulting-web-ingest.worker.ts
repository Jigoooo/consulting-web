import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit, Inject } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { QUEUE_NAMES } from '../queues/queue.tokens.js';
import {
  CONSULTING_WEB_TURN_COMPLETED_EVENT,
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

export function parseConsultingWebTurnPayload(value: unknown): ConsultingWebTurnIngestPayload {
  if (!isRecord(value)) throw new Error('invalid consulting web ingest payload: not an object');
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
    userText: asNonEmptyString(value.userText),
    assistantText: asNonEmptyString(value.assistantText),
    runId: value.runId === null ? null : asNonEmptyString(value.runId),
    assistantMessageId: asNonEmptyString(value.assistantMessageId),
    timestamp: asNumber(value.timestamp),
  };
  for (const [key, item] of Object.entries(payload)) {
    if (item === null && key !== 'runId' && key !== 'consultingTopicId') {
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
      QUEUE_NAMES.outboxRelay,
      async (job) => {
        await this.processOutboxJob(job.data as OutboxJobData);
      },
      {
        connection: redisConnectionFromUrl(this.env.REDIS_URL),
        concurrency: 1,
      },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.warn(`consulting web ingest job ${job?.id} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  async processOutboxJob(job: OutboxJobData): Promise<void> {
    if (job.eventType !== CONSULTING_WEB_TURN_COMPLETED_EVENT) return;
    const payload = parseConsultingWebTurnPayload(job.payload);
    await this.runner(payload);
  }
}
