import { describe, expect, it, vi } from 'vitest';
import {
  ARTIFACT_RED_TEAM_PERSONAS,
  ArtifactRedTeamService,
  HermesArtifactRedTeamAgent,
  parseArtifactRedTeamOutput,
} from '../src/artifacts/artifact-red-team.service.js';
import { artifactContentHash } from '../src/artifacts/artifact-export-preflight-audit.js';

const target = {
  artifactId: '11111111-1111-4111-8111-111111111111',
  artifactVersionId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  projectId: '44444444-4444-4444-8444-444444444444',
  title: '적대 검토 대상 보고서',
  versionNo: 1,
  content: '단계적 전환으로 비용을 20% 절감할 수 있습니다.',
  governingMessage: '핵심 결론은 단계적 전환이 가장 안전하다는 것입니다.',
  soWhat: '따라서 전환 비용과 이해관계자 반론을 먼저 검토해야 합니다.',
  sourceThreadId: null,
  sourceMessageId: null,
};

const warningOutput = JSON.stringify({
  verdict: 'PASS_WITH_WARNINGS',
  attacks: [
    { persona: '감사원', severity: 'warning', category: 'unsupported_assumption', message: '20% 절감의 계산 근거가 본문에 없습니다.' },
    { persona: '의회', severity: 'warning', category: 'budget', message: '예산 우선순위의 반대 논리가 없습니다.' },
    { persona: '노조', severity: 'warning', category: 'labor', message: '인력 전환 영향이 설명되지 않았습니다.' },
  ],
  defenses: [
    { attack_index: 0, response: '추가 원가표가 필요합니다.', disposition: 'unresolved' },
    { attack_index: 1, response: '대안 예산 비교가 필요합니다.', disposition: 'unresolved' },
    { attack_index: 2, response: '인력 영향 분석이 필요합니다.', disposition: 'unresolved' },
  ],
});

describe('artifact red-team review', () => {
  it('parses strict reviewer JSON and preserves persona-linked attacks and defenses', () => {
    expect(parseArtifactRedTeamOutput(warningOutput)).toEqual({
      verdict: 'PASS_WITH_WARNINGS',
      attacks: [
        { persona: '감사원', severity: 'warning', category: 'unsupported_assumption', message: '20% 절감의 계산 근거가 본문에 없습니다.' },
        { persona: '의회', severity: 'warning', category: 'budget', message: '예산 우선순위의 반대 논리가 없습니다.' },
        { persona: '노조', severity: 'warning', category: 'labor', message: '인력 전환 영향이 설명되지 않았습니다.' },
      ],
      defenses: [
        { attackIndex: 0, response: '추가 원가표가 필요합니다.', disposition: 'unresolved' },
        { attackIndex: 1, response: '대안 예산 비교가 필요합니다.', disposition: 'unresolved' },
        { attackIndex: 2, response: '인력 영향 분석이 필요합니다.', disposition: 'unresolved' },
      ],
    });
  });

  it('rejects unknown personas and self-contradictory PASS verdicts', () => {
    expect(() => parseArtifactRedTeamOutput(JSON.stringify({
      verdict: 'PASS_WITH_WARNINGS',
      attacks: [{ persona: '감사원', severity: 'warning', category: 'scope', message: 'persona 누락' }],
      defenses: [],
    }))).toThrow(/persona/iu);
    expect(() => parseArtifactRedTeamOutput(JSON.stringify({
      verdict: 'BLOCKED',
      attacks: [{ persona: '관리자', severity: 'blocker', category: 'scope', message: '잘못된 persona' }],
      defenses: [],
    }))).toThrow(/red-team/i);
    expect(() => parseArtifactRedTeamOutput(JSON.stringify({
      verdict: 'PASS',
      attacks: [
        { persona: '감사원', severity: 'warning', category: 'audit', message: '감사 반론' },
        { persona: '의회', severity: 'warning', category: 'budget', message: '예산 반론' },
        { persona: '노조', severity: 'warning', category: 'labor', message: '노동 반론' },
      ],
      defenses: [
        { attack_index: 0, response: '해결됨', disposition: 'mitigated' },
        { attack_index: 1, response: '해결되지 않음', disposition: 'unresolved' },
        { attack_index: 2, response: '해결됨', disposition: 'mitigated' },
      ],
    }))).toThrow(/PASS/u);
  });

  it('enqueues one exact version/hash-bound durable review without calling the agent inline', async () => {
    const contentHash = artifactContentHash(target.content, target.governingMessage, target.soWhat);
    const pending = {
      artifactId: target.artifactId,
      artifactVersionId: target.artifactVersionId,
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      contentHash,
      status: 'pending',
      verdict: null,
      policyVersion: 'artifact_red_team_v1',
      reviewedAt: null,
      attacks: [],
      defenses: [],
    };
    const ledger = { latest: vi.fn() };
    const jobs = { enqueue: vi.fn(), latest: vi.fn().mockResolvedValue(pending) };
    const service = new ArtifactRedTeamService(ledger as any, {
      ARTIFACT_RED_TEAM_MODE: 'warning', ARTIFACT_RED_TEAM_TIMEOUT_MS: 45_000,
    } as any, jobs as any);

    await expect(service.enqueue({
      target,
      contentHash,
      evidence: [],
      verdicts: [],
      reviewedByUserId: '55555555-5555-4555-8555-555555555555',
    })).resolves.toMatchObject({ status: 'pending', contentHash });
    expect(jobs.enqueue).toHaveBeenCalledWith({
      target,
      contentHash,
      mode: 'warning',
      requestedByUserId: '55555555-5555-4555-8555-555555555555',
    });
    expect(ledger.latest).not.toHaveBeenCalled();
  });

  it('runs the reviewer in a unique no-tool context with the exact version hash', async () => {
    const runStrictJsonTask = vi.fn().mockResolvedValue({
      reviewerRunId: 'run_isolated_red_team',
      rawJson: warningOutput,
      latencyMs: 5,
    });
    const agent = new HermesArtifactRedTeamAgent({ runStrictJsonTask } as any);
    const contentHash = artifactContentHash(target.content, target.governingMessage, target.soWhat);

    await expect(agent.review({
      target,
      contentHash,
      evidence: [],
      verdicts: [],
      reviewedByUserId: null,
      personas: ARTIFACT_RED_TEAM_PERSONAS,
      timeoutMs: 45_000,
    })).resolves.toEqual({ reviewerRunId: 'run_isolated_red_team', rawJson: warningOutput });

    const call = runStrictJsonTask.mock.calls[0]![0];
    expect(call.sessionId).toMatch(/^cw-red-team-[a-f0-9]{32}$/u);
    expect(call.timeoutMs).toBe(45_000);
    expect(call.profile).toBe('artifact-red-team');
    expect(call.instructions).toMatch(/Never use tools/iu);
    expect(JSON.parse(call.prompt)).toMatchObject({
      artifact: { artifactVersionId: target.artifactVersionId, contentHash, content: target.content },
      personas: ARTIFACT_RED_TEAM_PERSONAS,
    });
  });


  it('shows a newer retry job ahead of an older terminal failure', async () => {
    const contentHash = artifactContentHash(target.content, target.governingMessage, target.soWhat);
    const terminal = {
      artifactId: target.artifactId,
      artifactVersionId: target.artifactVersionId,
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      contentHash,
      status: 'failed',
      verdict: 'BLOCKED',
      policyVersion: 'artifact_red_team_v1',
      reviewedAt: '2026-07-11T12:00:00.000Z',
      attacks: [],
      defenses: [],
    };
    const pending = { ...terminal, status: 'pending', verdict: null, reviewedAt: null };
    const ledger = { latest: vi.fn().mockResolvedValue(terminal) };
    const jobs = { latest: vi.fn().mockResolvedValue(pending) };
    const service = new ArtifactRedTeamService(ledger as any, {
      ARTIFACT_RED_TEAM_MODE: 'warning', ARTIFACT_RED_TEAM_TIMEOUT_MS: 45_000,
    } as any, jobs as any);

    await expect(service.latest(target)).resolves.toMatchObject({ status: 'pending', verdict: null });
  });
});
