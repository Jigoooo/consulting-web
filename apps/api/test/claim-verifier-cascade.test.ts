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

  it('validates an explicit counter evidence id before a mixed verdict can identify contradiction provenance', () => {
    const parsed = parseStrictJsonVerifierOutput(JSON.stringify({
      verdicts: [{
        claim_id: 'c1',
        verdict: 'mixed',
        confidence: 0.8,
        evidence_id: 'e1',
        counter_evidence_id: 'e2',
        rationale: '일부는 지지하지만 반대 수치도 존재',
      }],
    }), new Set(['c1']), new Set(['e1', 'e2']));

    expect(parsed.verdicts[0]?.counter_evidence_id).toBe('e2');
    expect(() => parseStrictJsonVerifierOutput(JSON.stringify({
      verdicts: [{ claim_id: 'c1', verdict: 'mixed', confidence: 0.8, evidence_id: 'e1', counter_evidence_id: 'ghost', rationale: 'x' }],
    }), new Set(['c1']), new Set(['e1', 'e2']))).toThrow(/unknown counter_evidence_id/iu);
    expect(() => parseStrictJsonVerifierOutput(JSON.stringify({
      verdicts: [{ claim_id: 'c1', verdict: 'supports', confidence: 0.8, evidence_id: 'e1', counter_evidence_id: 'e2', rationale: 'x' }],
    }), new Set(['c1']), new Set(['e1', 'e2']))).toThrow(/counter_evidence_id.*mixed/iu);
  });

  it('propagates mixed counter evidence provenance into the verification lattice', async () => {
    const nli: NliProvider = {
      providerId: 'neutral_nli',
      model: 'neutral-v1',
      classify: async () => ({ label: 'neutral', confidence: 0.2, latencyMs: 1, rationale: 'uncertain' }),
    };
    const llm: LlmStrictJsonVerifier = {
      providerId: 'mixed_llm',
      model: 'mixed-v1',
      verifyJson: async () => ({
        rawJson: JSON.stringify({ verdicts: [{ claim_id: 'c1', verdict: 'mixed', confidence: 0.82, evidence_id: 'e1', counter_evidence_id: 'e2', rationale: 'mixed sources' }] }),
        latencyMs: 2,
      }),
    };

    const result = await new ClaimVerifierService(nli, llm).verify({ claims: [claims[0]!], evidence, highRiskClaimIds: ['c1'] });

    expect(result.lattice.verdictsByClaim.c1).toEqual(expect.objectContaining({
      verdict: 'mixed',
      evidenceId: 'e1',
      counterEvidenceId: 'e2',
    }));
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

  it('does not treat undecided policy evidence as support for a strong recommendation', async () => {
    const result = await new ClaimVerifierService(new LocalNliProvider()).verify({
      claims: [{ id: 'undecided-policy-c1', text: '창원시는 즉시 수영장 운영을 폐지해야 한다', decisionImpact: 0.84 }],
      evidence: [{ id: 'undecided-policy-e1', text: '창원시는 수영장 운영 현황을 점검했으며 폐지 여부는 결정되지 않았다', qualityScore: 78 }],
    });

    expect(result.lattice.verdictsByClaim['undecided-policy-c1']).toEqual(expect.objectContaining({
      verdict: 'not_enough_info',
      evidenceId: 'undecided-policy-e1',
    }));
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

  it('runs isolated strict JSON tasks and stops any reviewer that attempts tool use', async () => {
    const requests: Array<{ url: string; body: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, body: typeof init?.body === 'string' ? init.body : null });
      if (url.endsWith('/v1/runs')) return new Response(JSON.stringify({ run_id: 'red_team_tool_run' }), { status: 202 });
      if (url.endsWith('/v1/runs/red_team_tool_run/events')) {
        return new Response([
          'event: tool.started',
          `data: ${JSON.stringify({ tool: 'web_search' })}`,
          '',
          `data: ${JSON.stringify({ event: 'run.completed', output: '{"verdict":"PASS"}' })}`,
          '',
        ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.endsWith('/v1/runs/red_team_tool_run/stop')) return new Response('{}', { status: 200 });
      return new Response('not found', { status: 404 });
    }));
    const adapter = new HermesStrictJsonVerifier(env(), secrets);

    await expect(adapter.runStrictJsonTask({
      prompt: '{"artifact":"untrusted"}',
      instructions: 'Return JSON only. Never use tools.',
      sessionId: 'cw-red-team-unique-session',
      timeoutMs: 1_000,
    })).rejects.toThrow(/tool use/iu);

    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({
      session_id: 'cw-red-team-unique-session',
      instructions: 'Return JSON only. Never use tools.',
    });
    expect(requests.at(-1)?.url).toContain('/v1/runs/red_team_tool_run/stop');
  });

  it('refuses an artifact reviewer profile with any enabled toolset before starting a run', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify({
          data: [{ name: 'web', enabled: true }],
          inventory_complete: true,
          effective_toolsets: ['web'],
          effective_tools: ['web_search'],
        }), { status: 200 });
      }
      return new Response('unexpected run', { status: 500 });
    }));
    const adapter = new HermesStrictJsonVerifier(env({
      ARTIFACT_RED_TEAM_MODE: 'shadow',
      ARTIFACT_RED_TEAM_API_BASE_URL: 'http://reviewer.local:8643',
      ARTIFACT_RED_TEAM_API_KEY: 'reviewer-key',
    }), secrets);

    await expect(adapter.runStrictJsonTask({
      prompt: '{"artifact":"untrusted"}',
      instructions: 'Return JSON only.',
      sessionId: 'cw-red-team-tool-free',
      timeoutMs: 1_000,
      profile: 'artifact-red-team',
    })).rejects.toThrow(/tool-free.*web/iu);
    expect(requests).toEqual(['http://reviewer.local:8643/v1/toolsets']);
  });

  it('rejects a legacy toolset response that omits the effective inventory attestation', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      return new Response(JSON.stringify({ data: [{ name: 'web', enabled: false }] }), { status: 200 });
    }));
    const adapter = new HermesStrictJsonVerifier(env({
      ARTIFACT_RED_TEAM_MODE: 'shadow',
      ARTIFACT_RED_TEAM_API_BASE_URL: 'http://reviewer.local:8643',
      ARTIFACT_RED_TEAM_API_KEY: 'reviewer-key',
    }), secrets);

    await expect(adapter.runStrictJsonTask({
      prompt: '{"artifact":"untrusted"}',
      instructions: 'Return JSON only.',
      sessionId: 'cw-red-team-incomplete-inventory',
      timeoutMs: 1_000,
      profile: 'artifact-red-team',
    })).rejects.toThrow(/inventory attestation/iu);
    expect(requests).toEqual(['http://reviewer.local:8643/v1/toolsets']);
  });

  it('starts an artifact reviewer only after a tool-free preflight on the dedicated endpoint', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const reviewerSecrets: SecretProviderPort = {
      get: (name) => name === 'ARTIFACT_RED_TEAM_API_KEY' ? 'reviewer-key' : 'test-key',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get('authorization') });
      if (url.endsWith('/v1/toolsets')) {
        return new Response(JSON.stringify({
          data: [{ name: 'web', enabled: false }],
          inventory_complete: true,
          effective_toolsets: [],
          effective_tools: [],
        }), { status: 200 });
      }
      if (url.endsWith('/v1/runs')) return new Response(JSON.stringify({ run_id: 'tool_free_run' }), { status: 202 });
      if (url.endsWith('/v1/runs/tool_free_run/events')) {
        return new Response(`data: ${JSON.stringify({ event: 'run.completed', output: '{"verdict":"PASS"}' })}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('not found', { status: 404 });
    }));
    const adapter = new HermesStrictJsonVerifier(env({
      ARTIFACT_RED_TEAM_MODE: 'shadow',
      ARTIFACT_RED_TEAM_API_BASE_URL: 'http://reviewer.local:8643',
      ARTIFACT_RED_TEAM_API_KEY: 'reviewer-key',
    }), reviewerSecrets);

    await expect(adapter.runStrictJsonTask({
      prompt: '{"artifact":"safe data"}',
      instructions: 'Return JSON only.',
      sessionId: 'cw-red-team-tool-free-success',
      timeoutMs: 1_000,
      profile: 'artifact-red-team',
    })).resolves.toMatchObject({ reviewerRunId: 'tool_free_run', rawJson: '{"verdict":"PASS"}' });
    expect(requests.map((request) => request.url)).toEqual([
      'http://reviewer.local:8643/v1/toolsets',
      'http://reviewer.local:8643/v1/runs',
      'http://reviewer.local:8643/v1/runs/tool_free_run/events',
    ]);
    expect(requests.every((request) => request.authorization === 'Bearer reviewer-key')).toBe(true);
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

  it('preserves low-impact unverified claims with a conditional qualifier but hard-hedges high-impact ones', async () => {
    const neiNli: NliProvider = {
      providerId: 'nei_nli',
      model: 'nei-fixture-v1',
      async classify() {
        // neutral => not_enough_info for every claim in this fixture
        return { label: 'neutral', confidence: 0.3, latencyMs: 1, rationale: 'fixture undecided' };
      },
    };
    const service = new ClaimVerifierService(neiNli);
    const neiClaims = [
      { id: 'lo', text: '민원창구 수당 신설은 직원 만족도에 긍정적일 수 있다', decisionImpact: 0.4 },
      { id: 'hi', text: '생활체육지도사 수당은 별표9에 따라 즉시 폐지해야 한다', decisionImpact: 0.9 },
    ];
    const neiEvidence = [
      { id: 'ev', text: '해당 수당의 신설/폐지 여부는 아직 결정되지 않았고 검토 중이다', qualityScore: 60 },
    ];
    const draftAnswer = '민원창구 수당 신설은 직원 만족도에 긍정적일 수 있다. 생활체육지도사 수당은 별표9에 따라 즉시 폐지해야 한다.';

    const report = await service.repairAndReverify({ mode: 'report_decision', draftAnswer, claims: neiClaims, evidence: neiEvidence, maxRepairRounds: 1 });

    // Low-impact unverified claim keeps its substance with a light evidence-status qualifier.
    expect(report.publishedAnswer).toContain('민원창구 수당 신설은 직원 만족도에 긍정적일 수 있다');
    expect(report.publishedAnswer).toContain('근거 확인 필요');
    expect(report.actions).toEqual(expect.arrayContaining([expect.objectContaining({ claimId: 'lo', action: 'qualify_conditional' })]));
    // High-impact unverified claim still gets the hard refusal-to-assert hedge.
    expect(report.publishedAnswer).toContain('자료 부족으로 단정하지 않습니다');
    expect(report.actions).toEqual(expect.arrayContaining([expect.objectContaining({ claimId: 'hi', action: 'mark_insufficient_evidence' })]));
  });
});
