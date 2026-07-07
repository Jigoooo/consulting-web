import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { SECRET_PROVIDER, type SecretProviderPort } from '../secrets/secret-provider.port.js';
import type {
  ClaimInput,
  ClaimVerificationLattice,
  ClaimVerdict,
  ClaimVerdictKind,
  EvidenceInput,
  StrictJsonVerificationResult,
  VerificationMetrics,
  VerifierTrace,
} from './evidence-to-decision.service.js';

export type NliLabel = 'entailment' | 'contradiction' | 'neutral';

export interface NliClassification {
  label: NliLabel;
  confidence: number;
  latencyMs: number;
  rationale: string;
}

export interface NliProvider {
  providerId: string;
  model: string;
  classify(input: { claim: ClaimInput; evidence: EvidenceInput }): Promise<NliClassification>;
}

export interface LlmStrictJsonVerifier {
  providerId: string;
  model: string;
  verifyJson(input: { claims: ClaimInput[]; evidence: EvidenceInput[]; nliVerdicts: ClaimVerdict[] }): Promise<{ rawJson: string; latencyMs: number }>;
}

export type RepairWorkflowMode = 'general_chat' | 'report_decision';
export type RepairActionId = 'remove_sentence' | 'mark_insufficient_evidence';

export interface TargetedRepairAction {
  claimId: string;
  action: RepairActionId;
  before: string;
  after: string;
  reason: string;
}

export interface RepairWorkflowResult {
  mode: RepairWorkflowMode;
  publishedAnswer: string;
  repairRounds: number;
  requiresManualAction: boolean;
  warnings: string[];
  actions: TargetedRepairAction[];
  initial: StrictJsonVerificationResult;
  final: StrictJsonVerificationResult;
  nodeDurationsMs: { verify: number; targetedRepair: number; reverify: number };
  langGraph: { dependencyAdded: false; recommended: boolean; reason: string };
}

const StrictJsonVerdictSchema = z
  .object({
    claim_id: z.string().min(1),
    verdict: z.enum(['supports', 'refutes', 'mixed', 'not_enough_info']),
    confidence: z.number().min(0).max(1),
    evidence_id: z.string().nullable(),
    rationale: z.string().min(1),
  })
  .strict();

const StrictJsonVerifierOutputSchema = z.object({ verdicts: z.array(StrictJsonVerdictSchema) }).strict();

type StrictJsonVerdict = z.infer<typeof StrictJsonVerdictSchema>;

const STOP_TERMS = new Set(['근거', '자료', '판단', '기준', '핵심', '대한', '한다', '된다', '있다', '없다', 'the', 'and', 'for']);
const SUFFIX_RE = /(입니다|이었다|했다|한다|하는|하다|에서|으로|부터|까지|에게|보다|처럼|이며|이고|이나|거나|과|와|을|를|은|는|이|가|의|에|도|만|로)$/u;
const CONTRADICTION_PAIRS: Array<[string, string]> = [
  ['증가', '감소'],
  ['늘', '줄'],
  ['상승', '하락'],
  ['확대', '축소'],
  ['필요', '불필요'],
  ['가능', '불가능'],
  ['유지', '폐지'],
  ['찬성', '반대'],
  ['supports', 'refutes'],
  ['increase', 'decrease'],
  ['higher', 'lower'],
  ['yes', 'no'],
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[가-힣A-Za-z0-9]{2,}/gu) ?? []) {
    const term = raw.toLowerCase().replace(SUFFIX_RE, '');
    if (term.length < 2 || STOP_TERMS.has(term) || out.includes(term)) continue;
    out.push(term);
  }
  return out;
}

function hasNegatingPhrase(text: string): boolean {
  return /(근거는\s*없|아니|불가능|불필요|반대|refute|not\s+supported|no\s+evidence)/iu.test(text);
}

function contradictionTerms(claimTerms: string[], evidenceTerms: string[]): string[] {
  const out: string[] = [];
  for (const [left, right] of CONTRADICTION_PAIRS) {
    const claimHasLeft = claimTerms.some((term) => term.includes(left));
    const claimHasRight = claimTerms.some((term) => term.includes(right));
    const evidenceHasLeft = evidenceTerms.some((term) => term.includes(left));
    const evidenceHasRight = evidenceTerms.some((term) => term.includes(right));
    if (claimHasLeft && evidenceHasRight) out.push(`${left}↔${right}`);
    if (claimHasRight && evidenceHasLeft) out.push(`${right}↔${left}`);
  }
  return [...new Set(out)];
}

function verdictFromNli(label: NliLabel): ClaimVerdictKind {
  if (label === 'entailment') return 'supports';
  if (label === 'contradiction') return 'refutes';
  return 'not_enough_info';
}

function emptyMetrics(): VerificationMetrics {
  return { totalLatencyMs: 0, providerCalls: { nli: 0, llm: 0, heuristic: 0 }, providerLatencies: {} };
}

function addLatency(metrics: VerificationMetrics, key: string, latencyMs: number): void {
  const safe = Math.max(0, Math.round(latencyMs));
  metrics.totalLatencyMs += safe;
  metrics.providerLatencies[key] = (metrics.providerLatencies[key] ?? 0) + safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function durationSince(started: number): number {
  return Math.max(0, Date.now() - started);
}

function repairableVerdicts(result: StrictJsonVerificationResult): ClaimVerdict[] {
  return result.lattice.verdicts.filter((verdict) => verdict.verdict === 'refutes' || verdict.verdict === 'mixed' || verdict.verdict === 'not_enough_info');
}

function applyTargetedRepair(draftAnswer: string, verdicts: ClaimVerdict[]): { answer: string; actions: TargetedRepairAction[]; removedClaimIds: Set<string> } {
  let answer = draftAnswer;
  const actions: TargetedRepairAction[] = [];
  const removedClaimIds = new Set<string>();
  for (const verdict of verdicts) {
    const action: RepairActionId = verdict.verdict === 'not_enough_info' ? 'mark_insufficient_evidence' : 'remove_sentence';
    const replacement = action === 'mark_insufficient_evidence' ? `자료 부족으로 단정하지 않습니다: ${verdict.claimText}` : '';
    const before = answer;
    answer = replaceClaimSentence(answer, verdict.claimText, replacement);
    if (answer !== before || action === 'remove_sentence') removedClaimIds.add(verdict.claimId);
    actions.push({ claimId: verdict.claimId, action, before: verdict.claimText, after: replacement, reason: `${verdict.verdict}:${verdict.rationale}` });
  }
  return { answer: normalizeAnswerSpacing(answer), actions, removedClaimIds };
}

function replaceClaimSentence(answer: string, claimText: string, replacement: string): string {
  if (answer.includes(claimText)) return answer.replace(claimText, replacement);
  const prefix = claimText.slice(0, Math.min(12, claimText.length));
  const sentence = answer.split(/(?<=[.!?。]|다\.)\s+|\n+/u).find((part) => part.includes(prefix));
  return sentence ? answer.replace(sentence, replacement) : answer;
}

function normalizeAnswerSpacing(answer: string): string {
  return answer.replace(/\s+([.!?。])/gu, '$1').replace(/(?:^|\s+)\.\s*/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
}

function summarize(verdicts: ClaimVerdict[]): ClaimVerificationLattice['summary'] {
  return {
    supports: verdicts.filter((verdict) => verdict.verdict === 'supports').length,
    refutes: verdicts.filter((verdict) => verdict.verdict === 'refutes').length,
    mixed: verdicts.filter((verdict) => verdict.verdict === 'mixed').length,
    notEnoughInfo: verdicts.filter((verdict) => verdict.verdict === 'not_enough_info').length,
    claimCount: verdicts.length,
  };
}

function lattice(verdicts: ClaimVerdict[]): ClaimVerificationLattice {
  return { verdicts, verdictsByClaim: Object.fromEntries(verdicts.map((verdict) => [verdict.claimId, verdict])), summary: summarize(verdicts) };
}

export function parseStrictJsonVerifierOutput(rawJson: string, allowedClaimIds: Set<string>, allowedEvidenceIds: Set<string>): { verdicts: StrictJsonVerdict[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid strict JSON verifier output: ${reason}`, { cause: error });
  }
  const result = StrictJsonVerifierOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`strict JSON verifier output schema violation: ${result.error.message}`);
  }
  for (const verdict of result.data.verdicts) {
    if (!allowedClaimIds.has(verdict.claim_id)) throw new Error(`unknown claim_id in strict JSON verifier output: ${verdict.claim_id}`);
    if (verdict.evidence_id !== null && !allowedEvidenceIds.has(verdict.evidence_id)) throw new Error(`unknown evidence_id in strict JSON verifier output: ${verdict.evidence_id}`);
  }
  return result.data;
}

@Injectable()
export class LocalNliProvider implements NliProvider {
  readonly providerId = 'local_nli';
  readonly model = 'term-overlap-contradiction-v1';

  classify(input: { claim: ClaimInput; evidence: EvidenceInput }): Promise<NliClassification> {
    const claimTerms = terms(input.claim.text);
    const evidenceTerms = terms(input.evidence.text);
    const overlap = claimTerms.filter((term) => evidenceTerms.some((candidate) => candidate.includes(term) || term.includes(candidate))).length / Math.max(1, Math.min(claimTerms.length, 6));
    const contradictedTerms = contradictionTerms(claimTerms, evidenceTerms);
    const contradiction = (contradictedTerms.length > 0 && overlap >= 0.25) || (hasNegatingPhrase(input.evidence.text) && overlap >= 0.35);
    const qualityBoost = clamp01((input.evidence.qualityScore ?? 50) / 100) * 0.12;
    const confidence = round4(clamp01(overlap + qualityBoost + (contradiction ? 0.2 : 0)));
    const label: NliLabel = contradiction ? 'contradiction' : confidence >= 0.55 ? 'entailment' : 'neutral';
    const directional = contradictedTerms.length > 0 ? `; contradiction_terms=${contradictedTerms.join(',')}` : '';
    return Promise.resolve({ label, confidence, latencyMs: 0, rationale: `${label}; overlap=${round4(overlap)}; quality=${input.evidence.qualityScore ?? 'n/a'}${directional}` });
  }
}

@Injectable()
export class DisabledLlmStrictJsonVerifier implements LlmStrictJsonVerifier {
  readonly providerId = 'disabled_llm_json';
  readonly model = 'disabled';

  verifyJson(): Promise<{ rawJson: string; latencyMs: number }> {
    return Promise.resolve({ rawJson: '{"verdicts":[]}', latencyMs: 0 });
  }
}

@Injectable()
export class HermesStrictJsonVerifier implements LlmStrictJsonVerifier {
  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(SECRET_PROVIDER) private readonly secrets: SecretProviderPort,
  ) {}

  get providerId(): string {
    return this.env.VERIFIER_LLM_ENABLED ? 'hermes_strict_json' : 'disabled_llm_json';
  }

  get model(): string {
    return this.env.VERIFIER_LLM_MODEL ?? 'hermes-default';
  }

  async verifyJson(input: { claims: ClaimInput[]; evidence: EvidenceInput[]; nliVerdicts: ClaimVerdict[] }): Promise<{ rawJson: string; latencyMs: number }> {
    const started = Date.now();
    const apiKey = this.secrets.get('HERMES_API_KEY');
    if (!this.env.VERIFIER_LLM_ENABLED || apiKey.length === 0) return { rawJson: '{"verdicts":[]}', latencyMs: 0 };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.env.VERIFIER_LLM_TIMEOUT_MS);
    try {
      const runId = await this.startRun(this.strictJsonPrompt(input), apiKey, controller.signal);
      const rawJson = await this.readRunOutput(runId, apiKey, controller.signal);
      return { rawJson, latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async startRun(prompt: string, apiKey: string, signal: AbortSignal): Promise<string> {
    const payload: Record<string, unknown> = {
      input: prompt,
      session_id: 'cw-verifier-strict-json',
      instructions: 'You are a strict fact-checking judge. Return ONLY one JSON object. No markdown, no prose.',
    };
    if (this.env.VERIFIER_LLM_MODEL) payload.model = this.env.VERIFIER_LLM_MODEL;
    const response = await fetch(this.url('/v1/runs'), {
      method: 'POST',
      signal,
      headers: this.headers(apiKey, { 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Hermes strict JSON verifier run start failed (${response.status})`);
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.run_id !== 'string' || body.run_id.length === 0) {
      throw new Error('Hermes strict JSON verifier returned invalid run_id');
    }
    return body.run_id;
  }

  private async readRunOutput(runId: string, apiKey: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(this.url(`/v1/runs/${encodeURIComponent(runId)}/events`), {
      method: 'GET',
      signal,
      headers: this.headers(apiKey, { accept: 'text/event-stream' }),
    });
    if (!response.ok) throw new Error(`Hermes strict JSON verifier events failed (${response.status})`);
    if (!response.body) throw new Error('Hermes strict JSON verifier event body is empty');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = this.drainSseBuffer(buffer);
        buffer = parsed.remainder;
        output += parsed.output;
        if (parsed.completed) return parsed.output.trim().length > 0 ? parsed.output.trim() : output.trim();
      }
      buffer += decoder.decode();
      const parsed = this.drainSseBuffer(`${buffer}\n\n`);
      output += parsed.output;
      return output.trim();
    } finally {
      reader.releaseLock();
    }
  }

  private drainSseBuffer(buffer: string): { output: string; remainder: string; completed: boolean } {
    let remainder = buffer;
    let output = '';
    let completed = false;
    let boundary = remainder.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = remainder.slice(0, boundary);
      remainder = remainder.slice(boundary + 2);
      const event = this.parseSseFrame(frame);
      if (typeof event?.delta === 'string') output += event.delta;
      if (event?.event === 'run.completed') {
        if (typeof event.output === 'string') output = event.output;
        completed = true;
      }
      boundary = remainder.indexOf('\n\n');
    }
    return { output, remainder, completed };
  }

  private parseSseFrame(frame: string): Record<string, unknown> | null {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n');
    if (data.length === 0) return null;
    try {
      const parsed: unknown = JSON.parse(data);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private strictJsonPrompt(input: { claims: ClaimInput[]; evidence: EvidenceInput[]; nliVerdicts: ClaimVerdict[] }): string {
    return JSON.stringify({
      task: 'Return strict JSON: {"verdicts":[{"claim_id":"...","verdict":"supports|refutes|mixed|not_enough_info","confidence":0..1,"evidence_id":"... or null","rationale":"short reason"}]}',
      rules: [
        'Use only provided evidence IDs.',
        'Use not_enough_info if evidence is absent or ambiguous.',
        'Do not invent claim_id or evidence_id.',
        'Return JSON only.',
      ],
      claims: input.claims.map((claim) => ({ id: claim.id, text: claim.text })),
      evidence: input.evidence.map((item) => ({ id: item.id, text: item.text, qualityScore: item.qualityScore ?? null })),
      nli_prefilter: input.nliVerdicts.map((verdict) => ({ claim_id: verdict.claimId, verdict: verdict.verdict, confidence: verdict.confidence, evidence_id: verdict.evidenceId })),
    });
  }

  private url(path: string): string {
    return `${this.env.HERMES_API_BASE_URL.replace(/\/$/, '')}${path}`;
  }

  private headers(apiKey: string, extra: Record<string, string>): Record<string, string> {
    return { ...extra, authorization: `Bearer ${apiKey}` };
  }
}

@Injectable()
export class ClaimVerifierService {
  constructor(
    @Optional() @Inject(LocalNliProvider) private readonly nli: NliProvider = new LocalNliProvider(),
    @Optional() @Inject(DisabledLlmStrictJsonVerifier) private readonly llm?: LlmStrictJsonVerifier,
  ) {}

  async verify(input: { claims: ClaimInput[]; evidence: EvidenceInput[]; highRiskClaimIds?: string[] }): Promise<StrictJsonVerificationResult> {
    const metrics = emptyMetrics();
    const highRiskClaimIds = new Set(input.highRiskClaimIds ?? []);
    const nliVerdicts: ClaimVerdict[] = [];
    const llmClaims: ClaimInput[] = [];

    for (const claim of input.claims) {
      const best = await this.bestNliVerdict(claim, input.evidence, metrics);
      nliVerdicts.push(best);
      if (this.llm && this.llm.providerId !== 'disabled_llm_json' && (highRiskClaimIds.has(claim.id) || best.confidence < 0.75 || best.verdict === 'not_enough_info')) {
        llmClaims.push(claim);
      }
    }

    const byClaim = new Map(nliVerdicts.map((verdict) => [verdict.claimId, verdict]));
    if (llmClaims.length > 0 && this.llm && this.llm.providerId !== 'disabled_llm_json') {
      const llmResult = await this.llm.verifyJson({ claims: llmClaims, evidence: input.evidence, nliVerdicts });
      metrics.providerCalls.llm += 1;
      addLatency(metrics, `llm:${this.llm.providerId}`, llmResult.latencyMs);
      const parsed = parseStrictJsonVerifierOutput(llmResult.rawJson, new Set(input.claims.map((claim) => claim.id)), new Set(input.evidence.map((item) => item.id)));
      for (const verdict of parsed.verdicts) {
        const claim = input.claims.find((item) => item.id === verdict.claim_id);
        if (!claim) continue;
        byClaim.set(verdict.claim_id, this.fromStrictJsonVerdict(claim, verdict, this.llm, llmResult.latencyMs));
      }
    }

    const verdicts = input.claims.map((claim) => byClaim.get(claim.id) ?? this.neiVerdict(claim, null, 'missing_verifier_result'));
    const resultLattice = lattice(verdicts);
    return {
      verifier: this.llm && metrics.providerCalls.llm > 0 ? `nli_${this.nli.providerId}+llm_${this.llm.providerId}_v1` : `nli_${this.nli.providerId}_v1`,
      lattice: resultLattice,
      strictJson: {
        verdicts: verdicts.map((verdict) => ({
          claim_id: verdict.claimId,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          evidence_id: verdict.evidenceId,
          rationale: verdict.rationale,
        })),
      },
      metrics,
    };
  }

  async repairAndReverify(input: { mode: RepairWorkflowMode; draftAnswer: string; claims: ClaimInput[]; evidence: EvidenceInput[]; maxRepairRounds?: number }): Promise<RepairWorkflowResult> {
    const verifyStarted = Date.now();
    const initial = await this.verify({ claims: input.claims, evidence: input.evidence });
    const verify = durationSince(verifyStarted);
    const problems = repairableVerdicts(initial);
    if (input.mode === 'general_chat' || problems.length === 0 || (input.maxRepairRounds ?? 1) <= 0) {
      return {
        mode: input.mode,
        publishedAnswer: input.draftAnswer,
        repairRounds: 0,
        requiresManualAction: problems.length > 0,
        warnings: problems.length > 0 ? [`검증 필요 claim ${problems.length}건: 우측 패널의 repair action을 사용하세요.`] : [],
        actions: [],
        initial,
        final: initial,
        nodeDurationsMs: { verify, targetedRepair: 0, reverify: 0 },
        langGraph: { dependencyAdded: false, recommended: false, reason: 'plain Nest one-shot verifier is enough for general chat/manual actions' },
      };
    }

    const repairStarted = Date.now();
    const repaired = applyTargetedRepair(input.draftAnswer, problems);
    const targetedRepair = durationSince(repairStarted);
    const remainingClaims = input.claims.filter((claim) => !repaired.removedClaimIds.has(claim.id));
    const reverifyStarted = Date.now();
    const final = await this.verify({ claims: remainingClaims, evidence: input.evidence });
    const reverify = durationSince(reverifyStarted);
    const unresolved = repairableVerdicts(final);
    const warnings = [
      `문제 claim ${problems.length}건을 targeted repair 처리했습니다.`,
      ...unresolved.map((verdict) => `재검증 후에도 확인 필요: ${verdict.claimId} ${verdict.verdict}`),
    ];
    const publishedAnswer = unresolved.length > 0 ? `${repaired.answer}

주의: ${warnings.join(' ')}` : repaired.answer;
    return {
      mode: input.mode,
      publishedAnswer,
      repairRounds: 1,
      requiresManualAction: unresolved.length > 0,
      warnings,
      actions: repaired.actions,
      initial,
      final,
      nodeDurationsMs: { verify, targetedRepair, reverify },
      langGraph: { dependencyAdded: false, recommended: unresolved.length > 0, reason: unresolved.length > 0 ? 'human interrupt/resume may be useful after max repair round' : 'max-one targeted repair works without LangGraph' },
    };
  }

  private async bestNliVerdict(claim: ClaimInput, evidence: EvidenceInput[], metrics: VerificationMetrics): Promise<ClaimVerdict> {
    if (evidence.length === 0) return this.neiVerdict(claim, null, 'no evidence');
    let best: ClaimVerdict | null = null;
    for (const item of evidence) {
      const classified = await this.nli.classify({ claim, evidence: item });
      metrics.providerCalls.nli += 1;
      addLatency(metrics, `nli:${this.nli.providerId}`, classified.latencyMs);
      const candidate = this.fromNliClassification(claim, item, classified);
      if (!best || this.verdictRank(candidate) > this.verdictRank(best)) best = candidate;
    }
    return best ?? this.neiVerdict(claim, null, 'no evidence classified');
  }

  private fromNliClassification(claim: ClaimInput, evidence: EvidenceInput, classified: NliClassification): ClaimVerdict {
    const verdict = verdictFromNli(classified.label);
    const trace: VerifierTrace = { provider: this.nli.providerId, model: this.nli.model, label: classified.label, latencyMs: Math.max(0, Math.round(classified.latencyMs)), source: 'nli' };
    return {
      claimId: claim.id,
      claimText: claim.text,
      evidenceId: evidence.id,
      verdict,
      confidence: round4(clamp01(classified.confidence)),
      matchedTerms: terms(claim.text).filter((term) => terms(evidence.text).some((candidate) => candidate.includes(term) || term.includes(candidate))),
      contradictedTerms: verdict === 'refutes' ? ['nli_contradiction'] : [],
      rationale: `${classified.rationale}; evidence=${evidence.id}; provider=${trace.provider}; latency_ms=${trace.latencyMs}`,
      decisionImpact: clamp01(claim.decisionImpact ?? 0.5),
      verifierTrace: trace,
    };
  }

  private fromStrictJsonVerdict(claim: ClaimInput, verdict: StrictJsonVerdict, llm: LlmStrictJsonVerifier, latencyMs: number): ClaimVerdict {
    const trace: VerifierTrace = { provider: llm.providerId, model: llm.model, label: verdict.verdict, latencyMs: Math.max(0, Math.round(latencyMs)), source: 'llm' };
    return {
      claimId: claim.id,
      claimText: claim.text,
      evidenceId: verdict.evidence_id,
      verdict: verdict.verdict,
      confidence: round4(clamp01(verdict.confidence)),
      matchedTerms: [],
      contradictedTerms: verdict.verdict === 'refutes' ? ['llm_refutes'] : [],
      rationale: `${verdict.rationale}; provider=${trace.provider}; latency_ms=${trace.latencyMs}`,
      decisionImpact: clamp01(claim.decisionImpact ?? 0.5),
      verifierTrace: trace,
    };
  }

  private neiVerdict(claim: ClaimInput, evidenceId: string | null, reason: string): ClaimVerdict {
    return {
      claimId: claim.id,
      claimText: claim.text,
      evidenceId,
      verdict: 'not_enough_info',
      confidence: 0,
      matchedTerms: [],
      contradictedTerms: [],
      rationale: `not_enough_info; ${reason}; provider=${this.nli.providerId}; latency_ms=0`,
      decisionImpact: clamp01(claim.decisionImpact ?? 0.5),
      verifierTrace: { provider: this.nli.providerId, model: this.nli.model, label: 'neutral', latencyMs: 0, source: 'nli' },
    };
  }

  private verdictRank(verdict: ClaimVerdict): number {
    const tieBreak = verdict.verdict === 'mixed' ? 0.04 : verdict.verdict === 'refutes' ? 0.03 : verdict.verdict === 'supports' ? 0.02 : 0.01;
    return verdict.confidence + tieBreak;
  }
}
