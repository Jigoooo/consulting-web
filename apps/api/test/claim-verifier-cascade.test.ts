import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv, type Env } from '../src/config/env.schema.js';
import type { SecretProviderPort } from '../src/secrets/secret-provider.port.js';
import { ClaimVerifierService, HermesStrictJsonVerifier, LocalNliProvider, parseStrictJsonVerifierOutput, type LlmStrictJsonVerifier, type NliProvider } from '../src/consulting/claim-verifier.service.js';

const claims = [
  { id: 'c1', text: '정원 증가는 인건비 부담을 증가시킨다', decisionImpact: 0.9 },
  { id: 'c2', text: '주차장 수입은 감소했다', decisionImpact: 0.7 },
];
const evidence = [
  { id: 'e1', text: '정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다', qualityScore: 90 },
  { id: 'e2', text: '주차장 수입은 전년 대비 증가했으며 감소했다는 근거는 없다', qualityScore: 80 },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

function env(overrides: Record<string, string> = {}): Env {
  const parsed = parseEnv({
    APP_ENV: 'test',
    APP_PUBLIC_URL: 'http://localhost:5173',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'x'.repeat(16),
    JWT_REFRESH_SECRET: 'y'.repeat(16),
    HERMES_API_BASE_URL: 'http://hermes.local',
    HERMES_API_KEY: 'test-key',
    CONSULTING_DEFAULT_TEMPLATE_ENABLED: 'true',
    ...overrides,
  } as NodeJS.ProcessEnv);
  if (!parsed.ok || !parsed.env) throw new Error(`invalid test env: ${parsed.errors?.join(',') ?? 'unknown'}`);
  return parsed.env;
}

const secrets: SecretProviderPort = { get: () => 'test-key' };

describe('ClaimVerifierService cascade', () => {
  it('uses NLI first, falls back to strict JSON LLM for uncertain pairs, and records latency metrics', async () => {
    const nli: NliProvider = {
      providerId: 'fake_nli',
      model: 'fake-nli-v1',
      async classify({ claim }) {
        if (claim.id === 'c1') return { label: 'entailment', confidence: 0.91, latencyMs: 7, rationale: 'fake entailment' };
        return { label: 'neutral', confidence: 0.34, latencyMs: 5, rationale: 'fake uncertain' };
      },
    };
    const llm: LlmStrictJsonVerifier = {
      providerId: 'fake_llm_json',
      model: 'fake-json-v1',
      async verifyJson({ claims }) {
        return {
          rawJson: JSON.stringify({
            verdicts: claims.map((claim) => ({
              claim_id: claim.id,
              verdict: claim.id === 'c2' ? 'refutes' : 'supports',
              confidence: claim.id === 'c2' ? 0.82 : 0.7,
              evidence_id: claim.id === 'c2' ? 'e2' : 'e1',
              rationale: 'strict json fake',
            })),
          }),
          latencyMs: 13,
        };
      },
    };

    const service = new ClaimVerifierService(nli, llm);
    const result = await service.verify({ claims, evidence, highRiskClaimIds: ['c2'] });

    expect(result.verifier).toBe('nli_fake_nli+llm_fake_llm_json_v1');
    expect(result.lattice.verdictsByClaim.c1?.verdict).toBe('supports');
    expect(result.lattice.verdictsByClaim.c2?.verdict).toBe('refutes');
    expect(result.metrics.providerCalls).toEqual(expect.objectContaining({ nli: 4, llm: 1 }));
    expect(result.metrics.totalLatencyMs).toBeGreaterThanOrEqual(25);
    expect(result.lattice.verdictsByClaim.c1?.verifierTrace).toEqual(expect.objectContaining({ provider: 'fake_nli', model: 'fake-nli-v1', latencyMs: 7 }));
    expect(result.lattice.verdictsByClaim.c2?.verifierTrace).toEqual(expect.objectContaining({ provider: 'fake_llm_json', model: 'fake-json-v1', latencyMs: 13 }));
  });

  it('rejects malformed strict JSON instead of silently accepting unknown claim IDs or invalid verdicts', () => {
    expect(() => parseStrictJsonVerifierOutput('{"verdicts":[{"claim_id":"ghost","verdict":"supports","confidence":0.5,"evidence_id":null,"rationale":"x"}]}', new Set(['c1']), new Set(['e1']))).toThrow(/unknown claim_id/iu);
    expect(() => parseStrictJsonVerifierOutput('{"verdicts":[{"claim_id":"c1","verdict":"maybe","confidence":0.5,"evidence_id":null,"rationale":"x"}]}', new Set(['c1']), new Set(['e1']))).toThrow(/invalid enum value|verdict/iu);
    expect(() => parseStrictJsonVerifierOutput('{not json}', new Set(['c1']), new Set(['e1']))).toThrow(/invalid strict json/iu);
  });

  it('treats directional numeric/economic opposites as refuted before LLM fallback', async () => {
    const result = await new ClaimVerifierService(new LocalNliProvider()).verify({
      claims: [{ id: 'directional-c1', text: '주차장 수입은 감소했다', decisionImpact: 0.82 }],
      evidence: [{ id: 'directional-e1', text: '주차장 수입은 전년 대비 증가했다', qualityScore: 80 }],
    });

    expect(result.verifier).toBe('nli_local_nli_v1');
    expect(result.lattice.verdictsByClaim['directional-c1']).toEqual(expect.objectContaining({
      verdict: 'refutes',
      evidenceId: 'directional-e1',
    }));
    expect(result.lattice.summary.refutes).toBe(1);
  });

  it('keeps the Hermes strict JSON adapter env-gated and parses run SSE output when enabled', async () => {
    const disabledFetch = vi.fn();
    vi.stubGlobal('fetch', disabledFetch);
    await expect(new HermesStrictJsonVerifier(env(), secrets).verifyJson({ claims, evidence, nliVerdicts: [] })).resolves.toEqual({ rawJson: '{"verdicts":[]}', latencyMs: 0 });
    expect(disabledFetch).not.toHaveBeenCalled();

    const requests: Array<{ url: string; body: string | null; authorization: string | null }> = [];
    const rawJson = JSON.stringify({ verdicts: [{ claim_id: 'c2', verdict: 'refutes', confidence: 0.81, evidence_id: 'e2', rationale: 'mocked judge' }] });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, body: typeof init?.body === 'string' ? init.body : null, authorization: init?.headers instanceof Headers ? init.headers.get('authorization') : (init?.headers as Record<string, string> | undefined)?.authorization ?? null });
      if (url.endsWith('/v1/runs')) return new Response(JSON.stringify({ run_id: 'verifier_run' }), { status: 202 });
      if (url.endsWith('/v1/runs/verifier_run/events')) return new Response(`data: ${JSON.stringify({ event: 'run.completed', output: rawJson })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      return new Response('not found', { status: 404 });
    }));

    const result = await new HermesStrictJsonVerifier(env({ VERIFIER_LLM_ENABLED: 'true', VERIFIER_LLM_MODEL: 'gpt-5.5' }), secrets).verifyJson({ claims, evidence, nliVerdicts: [] });
    expect(JSON.parse(result.rawJson)).toEqual(JSON.parse(rawJson));
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.authorization).toBe('Bearer test-key');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({ session_id: 'cw-verifier-strict-json', model: 'gpt-5.5' });
  });

  it('does not auto-rerun general chat, but report/decision mode repairs only bad claims and re-verifies once', async () => {
    const nli: NliProvider = {
      providerId: 'repair_nli',
      model: 'repair-fixture-v1',
      async classify({ claim }) {
        if (claim.id === 'c2') return { label: 'contradiction', confidence: 0.88, latencyMs: 3, rationale: 'fixture refute' };
        return { label: 'entailment', confidence: 0.92, latencyMs: 2, rationale: 'fixture support' };
      },
    };
    const service = new ClaimVerifierService(nli);
    const draftAnswer = '정원 증가는 인건비 부담을 증가시킨다. 주차장 수입은 감소했다.';

    const chat = await service.repairAndReverify({ mode: 'general_chat', draftAnswer, claims, evidence });
    expect(chat.repairRounds).toBe(0);
    expect(chat.publishedAnswer).toBe(draftAnswer);
    expect(chat.requiresManualAction).toBe(true);

    const report = await service.repairAndReverify({ mode: 'report_decision', draftAnswer, claims, evidence, maxRepairRounds: 1 });
    expect(report.repairRounds).toBe(1);
    expect(report.publishedAnswer).toContain('정원 증가는 인건비 부담을 증가시킨다');
    expect(report.publishedAnswer).not.toContain('주차장 수입은 감소했다');
    expect(report.actions).toEqual(expect.arrayContaining([expect.objectContaining({ claimId: 'c2', action: 'remove_sentence' })]));
    expect(report.final.lattice.summary.refutes).toBe(0);
    expect(report.nodeDurationsMs).toEqual(expect.objectContaining({ verify: expect.any(Number), targetedRepair: expect.any(Number), reverify: expect.any(Number) }));
    expect(report.langGraph).toEqual(expect.objectContaining({ dependencyAdded: false }));
  });
});
