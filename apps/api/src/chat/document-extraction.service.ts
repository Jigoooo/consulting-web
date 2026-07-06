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
