import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { schema } from '@consulting/db-schema';
import { eq } from 'drizzle-orm';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { EvidenceStore } from './evidence.store.js';
import { extractDocumentText } from './document-extraction.service.js';

const MAX_INDEXED_TEXT_CHARS = 200_000;

interface ExtractionJob {
  attachmentId: string;
  workspaceId: string;
  threadId: string;
  fileName: string;
  mimeType: string;
  uploaderUserId: string;
}

function redisConnectionFromUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

/**
 * 축6: 문서 추출 잡 워커. 업로드 요청은 즉시 반환하고(extraction row = processing),
 * 이 워커가 백그라운드에서 최고급 다단 파서 파이프라인을 실행해 결과를 채운다.
 * API 요청 스레드에서 무거운 파싱/OCR을 돌리지 않아 성능저하를 방지한다.
 *
 * Worker는 API 프로세스와 같은 컨테이너에서 돌지만 BullMQ가 잡을 순차 처리하므로
 * (concurrency 1~2) 요청 핸들러와 격리된다. 별도 워커 프로세스로 분리도 가능.
 */
@Injectable()
export class DocumentExtractionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentExtractionWorker.name);
  private worker: Worker | null = null;
  private readonly queue: Queue;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(EvidenceStore) private readonly evidence: EvidenceStore,
  ) {
    this.queue = new Queue('document-extraction', {
      connection: redisConnectionFromUrl(this.env.REDIS_URL),
    });
  }

  /** 업로드 컨트롤러가 호출: 추출 잡을 큐에 등록(즉시 반환). */
  async enqueue(job: ExtractionJob): Promise<void> {
    await this.queue.add('extract', job, {
      jobId: `doc_${job.attachmentId}`,
      removeOnComplete: 500,
      removeOnFail: 1000,
      attempts: 2,
      backoff: { type: 'fixed', delay: 5000 },
    });
  }

  onModuleInit(): void {
    this.worker = new Worker(
      'document-extraction',
      async (job) => {
        const data = job.data as ExtractionJob;
        await this.process(data);
      },
      {
        connection: redisConnectionFromUrl(this.env.REDIS_URL),
        concurrency: 2,
      },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.warn(`extraction job ${job?.id} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }

  /** 실제 추출 실행 — 첨부 바이너리를 읽어 다단 파서 파이프라인을 돌리고 결과 저장. */
  private async process(job: ExtractionJob): Promise<void> {
    const [row] = await this.db
      .select({ dataBase64: schema.fileAttachments.dataBase64 })
      .from(schema.fileAttachments)
      .where(eq(schema.fileAttachments.id, job.attachmentId))
      .limit(1);
    if (!row) return; // 삭제됨 — 조용히 종료.

    const buffer = Buffer.from(row.dataBase64, 'base64');
    const extracted = extractDocumentText(job.fileName, job.mimeType, buffer);

    // extraction row upsert(이미 pending 행이 있으면 갱신).
    await this.db
      .insert(schema.documentExtractions)
      .values({
        workspaceId: job.workspaceId,
        threadId: job.threadId,
        attachmentId: job.attachmentId,
        status: extracted.status,
        extractor: extracted.extractor,
        textContent: extracted.text.slice(0, MAX_INDEXED_TEXT_CHARS),
        textChars: extracted.textChars,
        qualityScore: extracted.qualityScore,
        warnings: extracted.warnings,
      })
      .onConflictDoUpdate({
        target: schema.documentExtractions.attachmentId,
        set: {
          status: extracted.status,
          extractor: extracted.extractor,
          textContent: extracted.text.slice(0, MAX_INDEXED_TEXT_CHARS),
          textChars: extracted.textChars,
          qualityScore: extracted.qualityScore,
          warnings: extracted.warnings,
        },
      });

    if (extracted.status === 'indexed' && extracted.text.trim().length > 0) {
      await this.evidence.addManual({
        workspaceId: job.workspaceId,
        threadId: job.threadId,
        messageId: null,
        sourceType: 'file',
        ref: job.fileName,
        excerpt: extracted.text.slice(0, 4000),
        url: null,
        addedByUserId: job.uploaderUserId,
        qualityScore: extracted.qualityScore,
        qualitySignals: extracted.warnings.length > 0 ? extracted.warnings : ['document_text_indexed'],
      });
    }
  }
}
