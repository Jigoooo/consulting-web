import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { EvidenceStore } from './evidence.store.js';

export interface DocumentExtractionResult {
  status: 'indexed' | 'skipped' | 'failed';
  extractor: string | null;
  text: string;
  textChars: number;
  qualityScore: number;
  warnings: string[];
}

const INDEXABLE_MIME_PREFIXES = ['text/', 'image/'];
const INDEXABLE_MIME_TYPES = new Set([
  'application/pdf',
  'application/haansofthwp',
  'application/x-hwp',
  'application/vnd.hancom.hwpx',
  'application/hwp+zip',
]);
const MAX_INDEXED_TEXT_CHARS = 200_000;

// 축6: 다단 파서 파이프라인(파이썬 사이드카). apps/api/extractor/ 에 격리된 venv.
// NestJS(CommonJS)라 import.meta 불가 → cwd(보통 apps/api) + 후보 경로로 해석.
function resolveExtractor(): { py: string; script: string } {
  const candidates = [
    join(process.cwd(), 'extractor'),
    join(process.cwd(), 'apps', 'api', 'extractor'),
  ];
  for (const dir of candidates) {
    const py = join(dir, '.venv', 'bin', 'python');
    const script = join(dir, 'extractor_worker.py');
    if (existsSync(py) && existsSync(script)) return { py, script };
  }
  // 없으면 첫 후보를 반환(존재 체크는 호출측에서 다시 함 → 폴백 유도).
  return { py: join(candidates[0]!, '.venv', 'bin', 'python'), script: join(candidates[0]!, 'extractor_worker.py') };
}
const EXTRACTOR = resolveExtractor();
const EXTRACTOR_TIMEOUT_MS = 180_000;

@Injectable()
export class DocumentExtractionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(EvidenceStore) private readonly evidence: EvidenceStore,
  ) {}

  async indexAttachment(input: {
    workspaceId: string;
    threadId: string;
    attachmentId: string;
    fileName: string;
    mimeType: string;
    data: Buffer;
    uploaderUserId: string;
  }): Promise<DocumentExtractionResult> {
    const extracted = extractDocumentText(input.fileName, input.mimeType, input.data);
    const [row] = await this.db
      .insert(schema.documentExtractions)
      .values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        attachmentId: input.attachmentId,
        status: extracted.status,
        extractor: extracted.extractor,
        textContent: extracted.text.slice(0, MAX_INDEXED_TEXT_CHARS),
        textChars: extracted.textChars,
        qualityScore: extracted.qualityScore,
        warnings: extracted.warnings,
      })
      .returning({ id: schema.documentExtractions.id });

    if (row && extracted.status === 'indexed' && extracted.text.trim().length > 0) {
      await this.evidence.addManual({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        messageId: null,
        sourceType: 'file',
        ref: input.fileName,
        excerpt: extracted.text.slice(0, 4000),
        url: null,
        addedByUserId: input.uploaderUserId,
        qualityScore: extracted.qualityScore,
        qualitySignals: extracted.warnings.length > 0 ? extracted.warnings : ['document_text_indexed'],
      });
    }

    return extracted;
  }
}

export function extractDocumentText(fileName: string, mimeType: string, data: Buffer): DocumentExtractionResult {
  const lowerName = fileName.toLowerCase();
  if (!isIndexable(lowerName, mimeType)) {
    return finalize('skipped', null, '', ['unsupported_mime_for_indexing']);
  }

  if (mimeType.startsWith('text/')) {
    return finalize('indexed', 'text/plain', data.toString('utf8'), ['text_layer']);
  }

  const dir = mkdtempSync(join(tmpdir(), 'consulting-doc-'));
  const input = join(dir, safeTempName(lowerName));
  try {
    writeFileSync(input, data);
    // 축6: 최고급 파이썬 다단 파서(pymupdf4llm 레이아웃/표 + 다중 파서 비교 +
    // 다중 OCR + HWPX 구조 파서). 워커가 있으면 우선 사용, 없으면 아래 TS 폴백.
    const viaWorker = runExtractorWorker(input, mimeType);
    if (viaWorker) return viaWorker;

    if (mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
      return extractPdf(input, dir);
    }
    if (lowerName.endsWith('.hwpx') || mimeType.includes('hwpx')) {
      return extractHwpx(input);
    }
    if (lowerName.endsWith('.hwp') || mimeType.includes('hwp')) {
      return extractHwp(input);
    }
    if (mimeType.startsWith('image/')) {
      return extractImageOcr(input);
    }
    return finalize('skipped', null, '', ['unsupported_mime_for_indexing']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 축6: 파이썬 다단 파서 워커 호출. 성공하면 최고 품질 후보를 반환, 워커가
 * 없거나(미배포) 실패하면 null → 호출측이 기존 TS 파이프라인으로 폴백한다.
 * 동기 spawnSync지만 잡 큐 워커 컨텍스트에서 실행되므로 API 스레드를 막지 않는다.
 */
function runExtractorWorker(inputPath: string, mimeType: string): DocumentExtractionResult | null {
  if (!existsSync(EXTRACTOR.py) || !existsSync(EXTRACTOR.script)) return null;
  const res = spawnSync(EXTRACTOR.py, [EXTRACTOR.script, inputPath, mimeType], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: EXTRACTOR_TIMEOUT_MS,
  });
  if (res.status !== 0 || !res.stdout) return null;
  // 워커는 마지막 줄에만 JSON을 쓴다(파서 로그는 stderr로 격리됨).
  const lastLine = res.stdout.trim().split('\n').pop() ?? '';
  try {
    const parsed = JSON.parse(lastLine) as {
      status?: unknown; extractor?: unknown; text?: unknown;
      textChars?: unknown; qualityScore?: unknown; warnings?: unknown;
    };
    const status = parsed.status;
    if (status !== 'indexed' && status !== 'skipped' && status !== 'failed') return null;
    const text = typeof parsed.text === 'string' ? parsed.text.slice(0, MAX_INDEXED_TEXT_CHARS) : '';
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w): w is string => typeof w === 'string') : [];
    return {
      status,
      extractor: typeof parsed.extractor === 'string' ? parsed.extractor : null,
      text,
      textChars: typeof parsed.textChars === 'number' ? parsed.textChars : text.trim().length,
      qualityScore: typeof parsed.qualityScore === 'number' ? parsed.qualityScore : 0,
      warnings: warnings.slice(0, 20),
    };
  } catch {
    return null;
  }
}

function isIndexable(lowerName: string, mimeType: string): boolean {
  return INDEXABLE_MIME_PREFIXES.some((p) => mimeType.startsWith(p))
    || INDEXABLE_MIME_TYPES.has(mimeType)
    || lowerName.endsWith('.pdf')
    || lowerName.endsWith('.hwpx')
    || lowerName.endsWith('.hwp');
}

function extractPdf(input: string, dir: string): DocumentExtractionResult {
  const textPath = join(dir, 'text.txt');
  const pdftotext = run('pdftotext', ['-layout', '-enc', 'UTF-8', input, textPath]);
  if (pdftotext.ok && existsSync(textPath)) {
    const text = readFileSync(textPath, 'utf8');
    if (text.trim().length >= 80) return finalize('indexed', 'pdftotext', text, ['text_layer']);
  }

  const ppmPrefix = join(dir, 'page');
  const rendered = run('pdftoppm', ['-r', '250', '-png', input, ppmPrefix]);
  if (!rendered.ok) return finalize('failed', 'pdftotext', '', ['pdftoppm_missing_or_failed']);
  const ocr = run('sh', ['-c', `for f in ${shellQuote(dir)}/page-*.png; do [ -e "$f" ] && tesseract "$f" stdout -l kor+eng --psm 3; done`]);
  if (!ocr.ok) return finalize('failed', 'ocr', '', ['tesseract_missing_or_failed']);
  return finalize('indexed', 'ocr', ocr.stdout, ['ocr_fallback']);
}

function extractImageOcr(input: string): DocumentExtractionResult {
  const ocr = run('tesseract', [input, 'stdout', '-l', 'kor+eng', '--psm', '3']);
  if (!ocr.ok) return finalize('failed', 'ocr', '', ['tesseract_missing_or_failed']);
  return finalize('indexed', 'ocr', ocr.stdout, ['ocr_image']);
}

function extractHwpx(input: string): DocumentExtractionResult {
  const unzipped = run('unzip', ['-p', input, '*.xml']);
  if (!unzipped.ok) return finalize('failed', 'hwpx', '', ['unzip_missing_or_failed']);
  const text = unzipped.stdout
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  return finalize('indexed', 'hwpx', text, ['hwpx_xml']);
}

function extractHwp(input: string): DocumentExtractionResult {
  const hwp = run('hwp5txt', [input]);
  if (!hwp.ok) return finalize('failed', 'hwp5txt', '', ['hwp5txt_missing_or_failed']);
  return finalize('indexed', 'hwp5txt', hwp.stdout, ['hwp_binary']);
}

function finalize(status: DocumentExtractionResult['status'], extractor: string | null, rawText: string, seedWarnings: string[]): DocumentExtractionResult {
  const text = normalizeText(rawText).slice(0, MAX_INDEXED_TEXT_CHARS);
  const textChars = text.trim().length;
  const warnings = [...seedWarnings];
  if (textChars === 0 && status === 'indexed') warnings.push('empty_text');
  if (textChars > 0 && textChars < 80) warnings.push('short_text');
  if (textChars >= 80) warnings.push('length_ok');
  if (/[가-힣]/.test(text)) warnings.push('korean_text_detected');
  const effectiveStatus = status === 'indexed' && textChars === 0 ? 'failed' : status;
  return {
    status: effectiveStatus,
    extractor,
    text,
    textChars,
    qualityScore: scoreText(effectiveStatus, extractor, textChars, warnings),
    warnings: [...new Set(warnings)].slice(0, 20),
  };
}

function scoreText(status: DocumentExtractionResult['status'], extractor: string | null, textChars: number, warnings: string[]): number {
  if (status === 'skipped') return 0;
  if (status === 'failed') return 10;
  let score = textChars >= 1000 ? 86 : textChars >= 200 ? 78 : textChars >= 80 ? 70 : textChars >= 10 ? 60 : 30;
  if (extractor === 'pdftotext' || extractor === 'text/plain' || extractor === 'hwpx') score += 5;
  if (extractor === 'ocr') score -= 8;
  if (warnings.includes('short_text')) score -= 8;
  if (warnings.includes('korean_text_detected')) score += 3;
  return Math.max(0, Math.min(100, score));
}

function normalizeText(text: string): string {
  // eslint-disable-next-line no-control-regex -- PDF 추출물에서 NUL 문자를 의도적으로 제거
  return text.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function safeTempName(name: string): string {
  return name.replace(/[^a-z0-9._-]/g, '_') || 'upload.bin';
}
