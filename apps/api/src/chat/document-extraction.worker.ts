import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { schema } from '@consulting/db-schema';
import { eq } from 'drizzle-orm';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { EvidenceToDecisionService } from '../consulting/evidence-to-decision.service.js';
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
    @Inject(EvidenceToDecisionService) private readonly evidenceDecision: EvidenceToDecisionService,
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
    const [extractionRow] = await this.db
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
      })
      .returning({ id: schema.documentExtractions.id });

    if (!extractionRow || extracted.text.trim().length === 0) return;
    const baseUnits = this.evidenceDecision.buildDocumentRetrievalUnits({
      documents: [{ id: job.attachmentId, title: job.fileName, text: extracted.text, qualityScore: extracted.qualityScore }],
    });
    const visualUnits = renderPdfVisualUnits(buffer, job.attachmentId, job.fileName, extracted.qualityScore);
    const units = [
      ...baseUnits.filter((unit) => unit.modality !== 'page_visual'),
      ...(visualUnits.length > 0 ? visualUnits : baseUnits.filter((unit) => unit.modality === 'page_visual')),
    ];
    await this.db.delete(schema.documentRetrievalUnits).where(eq(schema.documentRetrievalUnits.extractionId, extractionRow.id));
    if (units.length === 0) return;
    await this.db.insert(schema.documentRetrievalUnits).values(
      units.map((unit) => ({
        workspaceId: job.workspaceId,
        attachmentId: job.attachmentId,
        extractionId: extractionRow.id,
        documentRef: job.fileName,
        modality: unit.modality,
        locator: unit.locator,
        textContent: unit.text.slice(0, 20_000),
        scorePrior: String(unit.scorePrior),
        metadata: unit.metadata,
      })),
    );
  }
}

export function renderPdfVisualUnits(buffer: Buffer, attachmentId: string, fileName: string, qualityScore: number) {
  if (!fileName.toLowerCase().endsWith('.pdf')) return [];
  const dir = mkdtempSync(join(tmpdir(), 'consulting-pdf-visual-'));
  const input = join(dir, 'input.pdf');
  const prefix = join(dir, 'page');
  try {
    writeFileSync(input, buffer);
    const rendered = spawnSync('pdftoppm', ['-f', '1', '-l', '3', '-r', '96', '-png', input, prefix], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (rendered.status !== 0) return [];
    return readdirSync(dir)
      .filter((name) => /^page-\d+\.png$/u.test(name))
      .sort()
      .slice(0, 3)
      .map((name, index) => {
        const png = readFileSync(join(dir, name));
        const imageSha256 = createHash('sha256').update(png).digest('hex');
        const embedding = imageEmbedding32(png);
        return {
          documentId: attachmentId,
          modality: 'page_visual' as const,
          locator: `${fileName}#page-${index + 1}`,
          text: `visual-page: ${fileName} page ${index + 1} image_sha256=${imageSha256.slice(0, 16)} embedding_provider=local_visual_hash_v1`,
          scorePrior: Math.round((0.55 + Math.max(0, Math.min(1, qualityScore / 100)) * 0.25) * 10_000) / 10_000,
          metadata: {
            title: fileName,
            page: index + 1,
            mimeType: 'image/png',
            imageSha256,
            imageBytes: png.length,
            embeddingProvider: 'local_visual_hash_v1',
            targetProvider: 'colpali_or_voyage_multimodal',
            embedding,
          },
        };
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function imageEmbedding32(png: Buffer): number[] {
  const digest = createHash('sha256').update(png).digest();
  return Array.from(digest).map((byte) => Math.round(((byte / 255) * 2 - 1) * 10_000) / 10_000);
}
