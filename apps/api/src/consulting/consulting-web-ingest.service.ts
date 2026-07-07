import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { ConsultingTopicResolver } from './consulting-topic-resolver.service.js';

const PYTHON = process.env.CONSULTING_PYTHON ?? 'python3';
const DEFAULT_WEB_INGEST = existsSync('/app/scripts/ingest_web_dialogue.py')
  ? '/app/scripts/ingest_web_dialogue.py'
  : '/home/jigoo/.hermes/workspace/consulting-web/apps/api/scripts/ingest_web_dialogue.py';
const WEB_INGEST = process.env.CONSULTING_WEB_INGEST_SCRIPT ?? DEFAULT_WEB_INGEST;

export interface ConsultingWebTurnIngestInput {
  threadId: string;
  userText: string;
  assistantText: string;
  runId: string | null;
  assistantMessageId: string;
}

@Injectable()
export class ConsultingWebIngestService {
  constructor(private readonly resolver: ConsultingTopicResolver) {}

  async ingestCompletedTurn(input: ConsultingWebTurnIngestInput): Promise<void> {
    try {
      if (!input.userText.trim() || !input.assistantText.trim()) return;
      const scope = await this.resolver.resolveThread(input.threadId);
      if (!scope || scope.archived) return;
      const payload = {
        consultingTopicSlug: scope.consultingTopicSlug,
        consultingTopicId: scope.consultingTopicId,
        sessionId: `consulting-web-thread:${input.threadId}`,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        channelId: scope.channelId,
        topicId: scope.topicId,
        threadId: scope.threadId,
        scopePath: scope.scopePath,
        userText: input.userText,
        assistantText: input.assistantText,
        runId: input.runId,
        assistantMessageId: input.assistantMessageId,
        timestamp: Date.now() / 1000,
      };
      await runPythonJson(PYTHON, [WEB_INGEST], payload, 60_000);
    } catch {
      // Best-effort background indexing: never fail/slow the chat UX because memory ingest failed.
    }
  }
}

function runPythonJson(command: string, args: string[], payload: unknown, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('consulting-web ingest timed out'));
    }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 2_000) stderr = stderr.slice(-2_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr || `consulting-web ingest failed (${code ?? 'signal'})`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
