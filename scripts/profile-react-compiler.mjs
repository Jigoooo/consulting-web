#!/usr/bin/env node
import { gzipSync } from 'node:zlib';
import { readdir, readFile, rm, mkdir, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const webDir = join(repo, 'apps/web');
const reportDir = join(repo, 'reports');
const reportPath = join(reportDir, 'react-compiler-profile.json');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(p));
    else files.push(p);
  }
  return files;
}

async function summarize(label, compilerEnabled) {
  const dist = join(webDir, 'dist');
  await rm(dist, { recursive: true, force: true });
  const env = { ...process.env };
  if (!compilerEnabled) env.DISABLE_REACT_COMPILER = '1';
  else delete env.DISABLE_REACT_COMPILER;

  const run = spawnSync('pnpm', ['--filter', '@consulting/web', 'build'], {
    cwd: repo,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.status !== 0) {
    process.stderr.write(run.stdout);
    process.stderr.write(run.stderr);
    throw new Error(`${label} build failed with exit ${run.status}`);
  }

  const files = await walk(dist);
  const assets = [];
  let totalBytes = 0;
  let totalGzipBytes = 0;
  for (const file of files) {
    const buf = await readFile(file);
    const rel = relative(dist, file);
    const gzipBytes = gzipSync(buf).length;
    totalBytes += buf.length;
    totalGzipBytes += gzipBytes;
    assets.push({ file: rel, bytes: buf.length, gzipBytes });
  }
  assets.sort((a, b) => b.gzipBytes - a.gzipBytes || a.file.localeCompare(b.file));

  return {
    label,
    compilerEnabled,
    totalBytes,
    totalGzipBytes,
    compilerRuntimeAssets: assets.filter((a) => a.file.includes('compiler-runtime')),
    topAssets: assets.slice(0, 12),
  };
}

await mkdir(reportDir, { recursive: true });
const withoutCompiler = await summarize('without-react-compiler', false);
const withCompiler = await summarize('with-react-compiler', true);
const delta = {
  bytes: withCompiler.totalBytes - withoutCompiler.totalBytes,
  gzipBytes: withCompiler.totalGzipBytes - withoutCompiler.totalGzipBytes,
  gzipPercent: withoutCompiler.totalGzipBytes === 0 ? 0 : Number((((withCompiler.totalGzipBytes - withoutCompiler.totalGzipBytes) / withoutCompiler.totalGzipBytes) * 100).toFixed(2)),
};
const report = {
  generatedAt: new Date().toISOString(),
  command: 'pnpm --filter @consulting/web profile:react-compiler',
  comparison: { withoutCompiler, withCompiler, delta },
  judgment: withCompiler.compilerRuntimeAssets.length > 0
    ? 'React Compiler transform is active; compare gzip delta with interaction profiling before calling it a net win.'
    : 'React Compiler runtime asset was not found; inspect Vite/plugin-react configuration.',
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

// Leave dist in the normal compiler-enabled state after profiling.
await rm(join(webDir, 'dist'), { recursive: true, force: true });
const restore = spawnSync('pnpm', ['--filter', '@consulting/web', 'build'], {
  cwd: repo,
  env: { ...process.env },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (restore.status !== 0) {
  process.stderr.write(restore.stdout);
  process.stderr.write(restore.stderr);
  throw new Error(`restore build failed with exit ${restore.status}`);
}

console.log(JSON.stringify({ reportPath, delta, compilerRuntimeAssets: withCompiler.compilerRuntimeAssets }, null, 2));
