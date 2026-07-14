import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { z } from 'zod';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import type { ClaimVerdict } from '../consulting/evidence-to-decision.service.js';
import { redactLogText } from '../security/redact-sensitive-text.js';
import { ARTIFACT_RED_TEAM_REVIEW_REQUESTED_EVENT } from '../queues/outbox-routing.js';
import { QUEUE_NAMES } from '../queues/queue.tokens.js';
import { ArtifactVerificationDbLedger } from './artifact-verification-db-ledger.js';
import { ArtifactRedTeamJobStore } from './artifact-red-team-job.store.js';
import {
  ARTIFACT_RED_TEAM_AGENT,
  ARTIFACT_RED_TEAM_PERSONAS,
  parseArtifactRedTeamOutput,
  type ArtifactRedTeamAgent,
} from './artifact-red-team.service.js';

const MAX_ATTEMPTS = 3;
const HEARTBEAT_MS = 15_000;

const PayloadSchema = z.object({
  jobId: z.string().uuid(),
  artifactId: z.string().uuid(),
  artifactVersionId: z.string().uuid(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const StoredVerdictSchema = z.object({
  claimId: z.string().min(1),
  claimText: z.string().min(1),
  evidenceId: z.string().nullable(),
  counterEvidenceId: z.string().nullable().optional(),
  verdict: z.enum(['supports', 'refutes', 'mixed', 'not_enough_info']),
  confidence: z.number().min(0).max(1),
  matchedTerms: z.array(z.string()),
  contradictedTerms: z.array(z.string()),
  rationale: z.string(),
  decisionImpact: z.number(),
}).passthrough();
const StoredVerdictsSchema = z.array(StoredVerdictSchema).max(40);

interface ArtifactRedTeamOutboxJob {
  eventId: string;
  eventType: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}

function redisConnectionFromUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

@Injectable()
export class ArtifactRedTeamWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ArtifactRedTeamWorker.name);
  private worker: Worker | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly jobs: ArtifactRedTeamJobStore,
    private readonly verification: ArtifactVerificationDbLedger,
    @Inject(ARTIFACT_RED_TEAM_AGENT) private readonly agent: ArtifactRedTeamAgent,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.ARTIFACT_RED_TEAM_MODE === 'off') return;
    await this.recoverStalled();
    this.recoveryTimer = setInterval(() => void this.recoverStalled(), 30_000);
    this.recoveryTimer.unref();
    this.worker = new Worker(
      QUEUE_NAMES.artifactRedTeam,
      async (job) => this.processOutboxJob(job.data as ArtifactRedTeamOutboxJob),
      { connection: redisConnectionFromUrl(this.env.REDIS_URL), concurrency: 2 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    await this.worker?.close();
    this.worker = null;
  }

  async processOutboxJob(envelope: ArtifactRedTeamOutboxJob): Promise<void> {
    if (envelope.eventType !== ARTIFACT_RED_TEAM_REVIEW_REQUESTED_EVENT) {
      throw new Error(`unsupported outbox event type: ${envelope.eventType}`);
    }
    if (envelope.aggregateType !== 'artifact-version') throw new Error('artifact red-team aggregate must be artifact-version');
    const payload = PayloadSchema.parse(envelope.payload);
    const existing = await this.jobs.findById(payload.jobId);
    if (!existing) return;
    if (
      existing.workspaceId !== envelope.workspaceId
      || existing.artifactId !== payload.artifactId
      || existing.artifactVersionId !== payload.artifactVersionId
      || existing.artifactVersionId !== envelope.aggregateId
      || existing.contentHash !== payload.contentHash
    ) {
      throw new Error('artifact red-team provenance envelope mismatch');
    }
    const claim = await this.jobs.claim(payload.jobId);
    if (claim.state === 'missing' || claim.state === 'terminal') return;
    if (claim.state === 'busy') throw new Error('artifact red-team lease busy');
    const { leaseToken, job } = claim;
    const heartbeat = setInterval(() => {
      void this.jobs.heartbeat(job.id, leaseToken).then((held) => {
        if (!held) this.logger.warn(`artifact red-team lease lost for ${job.id}`);
      }).catch((error: unknown) => {
        this.logger.warn(`artifact red-team heartbeat failed: ${redactLogText(error instanceof Error ? error.message : String(error))}`);
      });
    }, HEARTBEAT_MS);
    heartbeat.unref();
    try {
      const context = await this.jobs.loadReviewContext(job);
      const storedVerdicts = await this.verification.loadCurrentPassVerdicts(context.target, job.contentHash);
      if (storedVerdicts === null) {
        throw new Error('artifact red-team job has no current exact PASS verification');
      }
      const verdicts = normalizeVerdicts(storedVerdicts);
      const evidence = await this.verification.loadEvidence(context.target);
      const instructionLikePayload = containsInstructionLikePayload([
        context.target.title,
        context.target.content,
        context.target.governingMessage ?? '',
        context.target.soWhat ?? '',
        ...evidence.map((item) => item.text),
      ]);
      if (instructionLikePayload) {
        const attacks = ARTIFACT_RED_TEAM_PERSONAS.map((persona) => ({
          persona,
          severity: 'blocker' as const,
          category: 'prompt_injection',
          message: '검토 입력에서 reviewer 지시를 바꾸거나 도구 사용을 유도하는 문구가 탐지되었습니다.',
        }));
        await this.jobs.complete(job.id, leaseToken, {
          reviewerRunId: `deterministic-prompt-injection-v1:${job.id}`,
          verdict: 'BLOCKED',
          attacks,
          defenses: attacks.map((_attack, attackIndex) => ({
            attackIndex,
            response: '해당 입력을 reviewer에게 전달하지 않고 격리했습니다.',
            disposition: 'unresolved' as const,
          })),
        });
        return;
      }
      const result = await this.agent.review({
        target: context.target,
        contentHash: job.contentHash,
        evidence,
        verdicts,
        reviewedByUserId: job.requestedByUserId,
        personas: ARTIFACT_RED_TEAM_PERSONAS,
        timeoutMs: this.env.ARTIFACT_RED_TEAM_TIMEOUT_MS,
      });
      const parsed = parseArtifactRedTeamOutput(result.rawJson);
      await this.jobs.complete(job.id, leaseToken, {
        reviewerRunId: result.reviewerRunId,
        verdict: parsed.verdict,
        attacks: parsed.attacks,
        defenses: parsed.defenses,
      });
    } catch (error) {
      const disposition = await this.jobs.fail(job.id, leaseToken, error, MAX_ATTEMPTS);
      if (!disposition.terminal) throw error;
      this.logger.error(`artifact red-team job terminally failed: ${redactLogText(error instanceof Error ? error.message : String(error))}`);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async recoverStalled(): Promise<void> {
    try {
      const recovered = await this.jobs.recoverStalled();
      if (recovered > 0) this.logger.warn(`recovered ${recovered} stalled artifact red-team job(s)`);
    } catch (error) {
      this.logger.error(`artifact red-team recovery failed: ${redactLogText(error instanceof Error ? error.message : String(error))}`);
    }
  }
}

function normalizeVerdicts(value: unknown): ClaimVerdict[] {
  const parsed = StoredVerdictsSchema.safeParse(value);
  if (!parsed.success) throw new Error('artifact red-team verification verdict payload is malformed');
  return parsed.data.map((item) => ({
    claimId: item.claimId,
    claimText: item.claimText,
    evidenceId: item.evidenceId,
    ...(item.counterEvidenceId === undefined ? {} : { counterEvidenceId: item.counterEvidenceId }),
    verdict: item.verdict,
    confidence: item.confidence,
    matchedTerms: item.matchedTerms,
    contradictedTerms: item.contradictedTerms,
    rationale: item.rationale,
    decisionImpact: item.decisionImpact,
  }));
}

const INSTRUCTION_LIKE_PATTERN = /(?:ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions?|system\s+prompt|developer\s+message|(?:call|use|invoke)\s+(?:a\s+)?tool|<\/?system\b|이전\s*지시.*무시|시스템\s*프롬프트|도구(?:를|\s).*사용)/iu;

function containsInstructionLikePayload(parts: string[]): boolean {
  return parts.some((part) => INSTRUCTION_LIKE_PATTERN.test(part));
}
