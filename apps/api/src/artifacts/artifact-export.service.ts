import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ArtifactExportFormat = 'pdf' | 'docx';
export interface ArtifactExportResult {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

type PdfEngine = 'typst' | 'weasyprint' | 'chromium';

/**
 * Phase 2-B A-4: deterministic server-side export for artifact markdown.
 * PDF uses a consulting-grade fallback chain: Typst → WeasyPrint → Chromium.
 * DOCX uses Pandoc. Every PDF engine must verify `%PDF-` before success.
 */
@Injectable()
export class ArtifactExportService {
  async export(input: { title: string; versionNo: number; content: string; format: ArtifactExportFormat }): Promise<ArtifactExportResult> {
    const dir = await mkdtemp(join(tmpdir(), 'artifact-export-'));
    try {
      const downloadStem = `${safeFileName(input.title)}-v${input.versionNo}`;
      // Internal temp paths stay ASCII-only: some engines sanitize or drop non-ASCII output paths.
      const tempStem = `artifact-v${input.versionNo}`;
      const mdPath = join(dir, `${tempStem}.md`);
      await writeFile(mdPath, normalizeMarkdown(input.title, input.versionNo, input.content), 'utf8');

      if (input.format === 'docx') {
        const out = join(dir, `${tempStem}.docx`);
        await execFileAsync('pandoc', [mdPath, '-o', out], { timeout: 120_000, maxBuffer: 1024 * 1024 });
        return {
          buffer: await readFile(out),
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileName: `${downloadStem}.docx`,
        };
      }

      const pdf = await exportPdfWithFallback({ dir, tempStem, mdPath, title: input.title });
      return { buffer: pdf, mimeType: 'application/pdf', fileName: `${downloadStem}.pdf` };
    } catch (error) {
      throw new InternalServerErrorException({ code: 'EXPORT_FAILED', message: exportErrorMessage(error) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function exportPdfWithFallback(input: { dir: string; tempStem: string; mdPath: string; title: string }): Promise<Buffer> {
  const attempts: string[] = [];
  const engines: Array<{ name: PdfEngine; run: () => Promise<Buffer> }> = [
    { name: 'typst', run: () => exportPdfWithTypst(input) },
    { name: 'weasyprint', run: () => exportPdfWithWeasyPrint(input) },
    { name: 'chromium', run: () => exportPdfWithChromium(input) },
  ];

  for (const engine of engines) {
    try {
      return await engine.run();
    } catch (error) {
      attempts.push(`${engine.name}: ${compactError(error)}`);
    }
  }
  throw new Error(`all PDF engines failed (${attempts.join(' | ')})`);
}

async function exportPdfWithTypst(input: { dir: string; tempStem: string; mdPath: string; title: string }): Promise<Buffer> {
  const pdfPath = join(input.dir, `${input.tempStem}-typst.pdf`);
  await execFileAsync(
    'pandoc',
    [
      input.mdPath,
      '-o',
      pdfPath,
      '--pdf-engine=typst',
      '--metadata',
      `title=${input.title}`,
      '-V',
      'papersize=a4',
      '-V',
      'margin=18mm',
    ],
    { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return await readVerifiedPdf(pdfPath);
}

async function exportPdfWithWeasyPrint(input: { dir: string; tempStem: string; mdPath: string; title: string }): Promise<Buffer> {
  const htmlPath = join(input.dir, `${input.tempStem}-weasy.html`);
  const pdfPath = join(input.dir, `${input.tempStem}-weasy.pdf`);
  await execFileAsync('pandoc', [input.mdPath, '-s', '--metadata', `title=${input.title}`, '-o', htmlPath], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  const html = await readFile(htmlPath, 'utf8');
  await writeFile(htmlPath, injectPrintCss(html), 'utf8');
  await execFileAsync('weasyprint', [htmlPath, pdfPath], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  return await readVerifiedPdf(pdfPath);
}

async function exportPdfWithChromium(input: { dir: string; tempStem: string; mdPath: string; title: string }): Promise<Buffer> {
  const htmlPath = join(input.dir, `${input.tempStem}-chrome.html`);
  const pdfPath = join(input.dir, `${input.tempStem}-chrome.pdf`);
  await execFileAsync('pandoc', [input.mdPath, '-s', '--metadata', `title=${input.title}`, '-o', htmlPath], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  const html = await readFile(htmlPath, 'utf8');
  await writeFile(htmlPath, injectPrintCss(html), 'utf8');
  const chrome = process.env.CHROME_BIN || 'google-chrome';
  const profile = join(input.dir, 'chrome-profile');
  await execFileAsync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-sandbox',
      `--user-data-dir=${profile}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return await readVerifiedPdf(pdfPath);
}

function normalizeMarkdown(title: string, versionNo: number, content: string): string {
  const trimmed = content.trim();
  const hasTitle = /^#\s+/m.test(trimmed.slice(0, 300));
  const header = hasTitle ? '' : `# ${title}\n\n`;
  return `${header}> 산출물 버전: v${versionNo}\n\n${trimmed}\n`;
}

function safeFileName(input: string): string {
  return input
    .trim()
    // eslint-disable-next-line no-control-regex -- 파일명에서 제어문자(\u0000-\u001f)를 의도적으로 제거
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'artifact';
}

async function readVerifiedPdf(path: string): Promise<Buffer> {
  await waitForFile(path);
  const buffer = await readFile(path);
  if (buffer.length < 1024 || buffer.subarray(0, 5).toString('utf8') !== '%PDF-') {
    throw new Error(`invalid PDF output at ${path} (${buffer.length} bytes)`);
  }
  return buffer;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (lastError instanceof Error) throw lastError;
}

function injectPrintCss(html: string): string {
  const css = `<style>
@page { size: A4; margin: 18mm 16mm; }
body { font-family: "Noto Sans CJK KR", "Malgun Gothic", sans-serif; line-height: 1.62; text-align: left; color: #111827; word-break: keep-all; overflow-wrap: break-word; }
h1,h2,h3,h4,h5,h6,p,ul,ol,li,blockquote,table,pre,code,div { text-align: left; }
table { width:100%; border-collapse:collapse; table-layout:auto; margin: 0.75rem 0 1.1rem 0; }
thead { display:table-header-group; }
tr { page-break-inside:avoid; }
th, td { border:1px solid #d1d5db; padding:0.42rem 0.5rem; vertical-align:top; text-align:left !important; word-break:keep-all; overflow-wrap:anywhere; }
th { background:#f3f4f6; font-weight:700; white-space:nowrap; }
td:first-child { white-space:nowrap; }
pre { white-space: pre-wrap; background:#f9fafb; padding: 0.75rem; border-radius: 8px; }
blockquote { border-left: 4px solid #d1d5db; margin-left: 0; padding-left: 1rem; color: #4b5563; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style>`;
  return html.includes('</head>') ? html.replace('</head>', `${css}</head>`) : `${css}${html}`;
}

function compactError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.replace(/\s+/g, ' ').slice(0, 240);
  return String(error).slice(0, 240);
}

function exportErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return `artifact export failed: ${error.message.slice(0, 500)}`;
  return 'artifact export failed';
}
