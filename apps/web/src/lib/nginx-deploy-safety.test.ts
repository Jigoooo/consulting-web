import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const nginx = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../nginx.conf'),
  'utf8',
);
const securityHeaders = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../nginx-security-headers.conf'),
  'utf8',
);
const dockerfile = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../Dockerfile'),
  'utf8',
);
const apiDockerfile = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../api/Dockerfile'),
  'utf8',
);
const productionCompose = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../docker-compose.prod.yml'),
  'utf8',
);

function block(start: string): string {
  const at = nginx.indexOf(start);
  if (at < 0) return '';
  const open = nginx.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < nginx.length; i += 1) {
    if (nginx[i] === '{') depth += 1;
    if (nginx[i] === '}') {
      depth -= 1;
      if (depth === 0) return nginx.slice(open + 1, i);
    }
  }
  return '';
}

function composeServiceBlock(name: string): string {
  const lines = productionCompose.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^ {2}\S/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start, end).join('\n');
}

describe('nginx SPA deploy cache policy', () => {
  it('never browser- or CDN-caches the SPA shell', () => {
    const root = block('location /');
    expect(root).toContain(
      'Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"',
    );
    expect(root).toContain('CDN-Cache-Control "no-store"');
    expect(root).toContain('Cloudflare-CDN-Cache-Control "no-store"');
  });

  it('keeps service-worker control files uncached with security headers', () => {
    const controls = block('location ~ ^/(sw\\.js|version\\.json|manifest\\.webmanifest)$');
    expect(controls).toContain('include /etc/nginx/snippets/security-headers.conf');
    expect(controls).toContain(
      'Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"',
    );
    expect(controls).toContain('CDN-Cache-Control "no-store"');
    expect(controls).toContain('Cloudflare-CDN-Cache-Control "no-store"');
  });

  it('caches only hashed assets immutably while preserving security headers', () => {
    const assets = block('location /assets/');
    expect(assets).toContain('include /etc/nginx/snippets/security-headers.conf');
    expect(assets).toContain('Cache-Control "public, max-age=31536000, immutable"');
  });

  it('allows bundled data fonts without opening font loading to external origins', () => {
    expect(securityHeaders).toContain("font-src 'self' data:");
  });

  it('pins build bases and production runtime images by digest', () => {
    const fromLines = dockerfile.match(/^FROM .+$/gm) ?? [];
    expect(fromLines).toHaveLength(2);
    expect(fromLines.every((line) => /@sha256:[a-f0-9]{64}/.test(line))).toBe(true);
    const apiExternalFromLines = (apiDockerfile.match(/^FROM .+$/gm) ?? []).filter(
      (line) => !line.startsWith('FROM base '),
    );
    expect(apiExternalFromLines).toHaveLength(3);
    expect(apiExternalFromLines.every((line) => /@sha256:[a-f0-9]{64}/.test(line))).toBe(true);
    expect(productionCompose).toMatch(/image: postgres:[^\s]+@sha256:[a-f0-9]{64}/);
    expect(productionCompose).toMatch(/image: redis:[^\s]+@sha256:[a-f0-9]{64}/);
    expect(productionCompose).toMatch(/image: alpine:[^\s]+@sha256:[a-f0-9]{64}/);
    expect(productionCompose).toMatch(/image: pgvector\/pgvector:[^\s]+@sha256:[a-f0-9]{64}/);
    expect(productionCompose).toMatch(/image: \$\{CONSULTING_WEB_IMAGE:-sha256:[a-f0-9]{64}\}/);
  });

  it('runs the shared brain PG18 as a schema-gated production dependency', () => {
    const brainPg = composeServiceBlock('brain-pg');
    const api = composeServiceBlock('api');
    expect(brainPg).toContain('pgvector/pgvector:pg18@sha256:');
    expect(brainPg).toContain('brain-pg-data:/var/lib/postgresql');
    expect(brainPg).not.toContain('/var/lib/postgresql/data');
    expect(brainPg).toContain("to_regclass('brain_raw.topics')");
    expect(brainPg).toContain("to_regclass('brain_rag.chunk_texts')");
    expect(api).toContain('@brain-pg:5432/consulting');
    expect(api).toMatch(/brain-pg:\s*\n\s+condition: service_healthy/);
  });
});
