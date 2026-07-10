import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConsultingGraphRagBridge } from '../src/consulting/consulting-graphrag-bridge.service.js';

const pythonPath = '/home/jigoo/.hermes/workspace/consulting/.venv/bin/python3';
const cliPath = '/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory_cli.py';
const d = existsSync(pythonPath) && existsSync(cliPath) ? describe : describe.skip;

d('ConsultingGraphRagBridge', () => {
  it('recalls existing changwon GraphRAG evidence through the consulting brain CLI', async () => {
    const bridge = new ConsultingGraphRagBridge();
    const result = await bridge.recall({
      topicSlug: 'changwon-org-mgmt-diagnosis',
      query: '정원 인건비 조직진단',
      topK: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    const evidenceText = result.hits.map((hit) => `${hit.docTitle ?? ''} ${hit.text}`).join('\n');
    expect(evidenceText).toContain('창원시설공단');
    expect(evidenceText).toMatch(/정원|인건비|조직 진단/u);
  }, 10_000);
});
