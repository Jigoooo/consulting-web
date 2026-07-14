import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareRagRegression, computeRagMetrics, exportFailureFixtures, type RetrievalRunLabels } from '../src/consulting/rag-metrics.js';

interface GateFixture {
  schema_version: string;
  run_kind: string;
  ks: number[];
  tolerance: number;
  baseline: {
    totalRuns: number;
    labeledRuns: number;
    labeledHits: number;
    mrr: number;
    precisionAtK: Record<number, number>;
    precisionCoverageAtK: Record<number, number>;
  };
  runs: RetrievalRunLabels[];
  expected_failure_fixture_keys: string[];
}

const fixturePath = resolve(process.cwd(), 'test/fixtures/rag-eval-ci-baseline.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GateFixture;

describe('P3 file-backed RAG regression gate', () => {
  it('runs in the default Vitest pipeline and fails closed on metric/coverage regression', () => {
    expect(fixture.schema_version).toBe('1.0');
    expect(fixture.run_kind).toBe('retrieval_human_label_regression');
    const current = computeRagMetrics(fixture.runs, fixture.ks);
    const gate = compareRagRegression(fixture.baseline, current, fixture.tolerance);
    expect(gate).toEqual(expect.objectContaining({ passed: true, regressions: [] }));
    expect(exportFailureFixtures(fixture.runs).map((item) => item.fixtureKey)).toEqual(fixture.expected_failure_fixture_keys);
  });

  it('fails closed when a high-performing subset hides labeled cohort loss', () => {
    const subset = computeRagMetrics(fixture.runs.slice(0, 1), fixture.ks);
    const gate = compareRagRegression(fixture.baseline, subset, fixture.tolerance);
    expect(gate.passed).toBe(false);
    expect(gate.regressions).toEqual(expect.arrayContaining([
      'total_runs:-1',
      'labeled_runs:-1',
      'labeled_hits:-3',
    ]));
  });
});
