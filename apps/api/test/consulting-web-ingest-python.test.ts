import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function runPython(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn('python3', [script], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe('ingest_web_dialogue.py fail-open embedding contract', () => {
  it('stores chunk/FTS/edges even when the embedding provider is down', async () => {
    const script = resolve(process.cwd(), 'test/fixtures/consulting_web_ingest_failopen.py');
    const result = await runPython(script);

    expect(result.code, result.stderr || result.stdout).toBe(0);
  }, 20_000);
});

describe('ingest_web_dialogue.py auto topic provisioning (P1)', () => {
  it('auto-creates an unknown brain topic and ingests the turn idempotently', async () => {
    const script = resolve(process.cwd(), 'test/fixtures/consulting_web_ingest_autotopic.py');
    const result = await runPython(script);

    expect(result.code, result.stderr || result.stdout).toBe(0);
  }, 20_000);
});

describe('ingest_web_dialogue.py verified contradiction bridge', () => {
  it('writes verifier-approved contradiction pairs idempotently without ingesting assistant text as dialogue memory', async () => {
    const script = resolve(process.cwd(), 'test/fixtures/consulting_web_ingest_verified_contradiction.py');
    const result = await runPython(script);

    expect(result.code, result.stderr || result.stdout).toBe(0);
  }, 20_000);
});
