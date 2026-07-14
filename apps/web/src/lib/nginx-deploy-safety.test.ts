import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const nginx = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../nginx.conf'), 'utf8');
const securityHeaders = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../nginx-security-headers.conf'),
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

describe('nginx SPA deploy cache policy', () => {
  it('never browser- or CDN-caches the SPA shell', () => {
    const root = block('location /');
    expect(root).toContain('Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"');
    expect(root).toContain('CDN-Cache-Control "no-store"');
    expect(root).toContain('Cloudflare-CDN-Cache-Control "no-store"');
  });

  it('keeps service-worker control files uncached with security headers', () => {
    const controls = block('location ~ ^/(sw\\.js|version\\.json|manifest\\.webmanifest)$');
    expect(controls).toContain('include /etc/nginx/snippets/security-headers.conf');
    expect(controls).toContain('Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"');
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
});
