import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import { deleteToolPolicyAuditFixtures } from './tool-policy-audit-fixtures.js';
import {
  AuthSessionResponseSchema,
  SignUpBootstrapResponseSchema,
  CreateProjectResponseSchema,
  CreateChannelResponseSchema,
  CreateTopicResponseSchema,
  CreateThreadResponseSchema,
  ListEvidenceResponseSchema,
  ListArtifactsResponseSchema,
  ArtifactDetailResponseSchema,
  CreateArtifactResponseSchema,
  ListNotificationsResponseSchema,
  UploadAttachmentResponseSchema,
  ListAttachmentsResponseSchema,
  ListMessagesPageResponseSchema,
  OkResponseSchema,
} from '@consulting/contracts';
import { AppModule } from '../src/app.module.js';
import { artifactContentHash } from '../src/artifacts/artifact-export-preflight-audit.js';
import { artifactVerificationPolicyPrefix } from '../src/artifacts/artifact-verification.service.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let app: INestApplication;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const createdUsers: string[] = [];
const createdWorkspaces: string[] = [];

async function waitForValue<T>(
  label: string,
  load: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await load();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Hermes mock that emits tool.started/completed around deltas (Phase 2-A). */
function installHermesToolEventFetchMock() {
  const body = [
    'data: {"event":"tool.started","run_id":"run_p2","tool":"web_search","preview":"창원시 인구 추이"}',
    '',
    'data: {"event":"tool.completed","run_id":"run_p2","tool":"web_search","preview":"창원시 인구 추이 공식 통계 https://kosis.kr/stat"}',
    '',
    'data: {"event":"tool.started","run_id":"run_p2","tool":"web_extract","preview":"https://example.go.kr/facility"}',
    '',
    'data: {"event":"tool.completed","run_id":"run_p2","tool":"web_extract","preview":"공공시설 적정성 공식 자료 https://example.go.kr/facility"}',
    '',
    'data: {"event":"message.delta","run_id":"run_p2","delta":"근거 기반 "}',
    '',
    'data: {"event":"message.delta","run_id":"run_p2","delta":"답변"}',
    '',
    'data: {"event":"run.completed","run_id":"run_p2","output":"근거 기반 답변"}',
    '',
  ].join('\n');
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const u = input instanceof Request ? input.url : String(input);
    if (u.endsWith('/v1/toolsets')) {
      return new Response(JSON.stringify({ object: 'list', platform: 'api_server', inventory_complete: true, inventory_hash: 'a'.repeat(64), effective_toolsets: ['file', 'web'], effective_tools: ['read_file', 'web_search'], data: [{ name: 'web', enabled: true }, { name: 'file', enabled: true }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.endsWith('/v1/capabilities')) {
      return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
    }
    if (u.endsWith('/v1/runs')) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { client_run_id?: string; tool_inventory_hash?: string };
      return new Response(JSON.stringify({ run_id: payload.client_run_id, status: 'started', tool_inventory_hash: payload.tool_inventory_hash }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/events')) {
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function installHermesPlainFetchMock() {
  const body = [
    'data: {"event":"message.delta","run_id":"run_attachment","delta":"첨부 확인"}',
    '',
    'data: {"event":"run.completed","run_id":"run_attachment","output":"첨부 확인"}',
    '',
  ].join('\n');
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const u = input instanceof Request ? input.url : String(input);
    if (u.endsWith('/v1/toolsets')) {
      return new Response(JSON.stringify({ object: 'list', platform: 'api_server', inventory_complete: true, inventory_hash: 'a'.repeat(64), effective_toolsets: ['file', 'web'], effective_tools: ['read_file', 'web_search'], data: [{ name: 'web', enabled: true }, { name: 'file', enabled: true }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.endsWith('/v1/capabilities')) {
      return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
    }
    if (u.endsWith('/v1/runs')) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { client_run_id?: string; input?: string; tool_inventory_hash?: string };
      expect(payload.input).toBeTruthy();
      return new Response(JSON.stringify({ run_id: payload.client_run_id, status: 'started', tool_inventory_hash: payload.tool_inventory_hash }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/events')) return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function makeUser(label: string) {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = 'supersecret1';
  const signup = SignUpBootstrapResponseSchema.parse(
    (await request(app.getHttpServer()).post('/auth/signup').send({ email, password, displayName: label }).expect(201)).body,
  );
  createdUsers.push(signup.userId);
  createdWorkspaces.push(signup.personalWorkspaceId);
  const session = AuthSessionResponseSchema.parse(
    (await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body,
  );
  return { ...signup, bearer: `Bearer ${session.tokens.accessToken}` };
}

async function makeSpaces(bearer: string, workspaceId: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const project = CreateProjectResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/projects').set('authorization', bearer)
      .send({ workspaceId, name: 'P', slug: `p-${stamp}` }).expect(201)).body,
  );
  const channel = CreateChannelResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/channels').set('authorization', bearer)
      .send({ projectId: project.id, name: 'C', slug: `c-${stamp}` }).expect(201)).body,
  );
  const topic = CreateTopicResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/topics').set('authorization', bearer)
      .send({ channelId: channel.id, name: 'T', slug: `t-${stamp}` }).expect(201)).body,
  );
  const thread = CreateThreadResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/threads').set('authorization', bearer)
      .send({ topicId: topic.id, title: 'Phase2 스레드' }).expect(201)).body,
  );
  return { project, channel, topic, thread };
}

d('Phase 2 — evidence, artifacts, notifications', () => {
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (createdWorkspaces.length > 0) {
      await deleteToolPolicyAuditFixtures(pool, createdWorkspaces);
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, createdWorkspaces));
    }
    if (createdUsers.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    }
    await pool.end();
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('E-2: captures tool events from a stream as evidence linked to the assistant message', async () => {
    installHermesToolEventFetchMock();
    const owner = await makeUser('ev-owner');
    const { thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', owner.bearer)
      .send({ threadId: thread.id, message: '근거를 찾아줘', clientMessageId: randomUUID() })
      .expect(200);

    const evidence = await waitForValue(
      'settled tool evidence',
      async () => ListEvidenceResponseSchema.parse(
        (await request(app.getHttpServer())
          .get(`/chat/threads/${thread.id}/evidence`)
          .set('authorization', owner.bearer)
          .expect(200)).body,
      ),
      (value) => value.evidence.length === 2,
    ).catch(async (error: unknown) => {
      const settlements = await db
        .select({
          status: schema.chatTurnSettlements.status,
          evidenceStatus: schema.chatTurnSettlements.evidenceStatus,
          stepErrors: schema.chatTurnSettlements.stepErrors,
          toolUses: schema.chatTurnSettlements.toolUses,
        })
        .from(schema.chatTurnSettlements)
        .where(eq(schema.chatTurnSettlements.threadId, thread.id));
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; settlements=${JSON.stringify(settlements)}`);
    });
    expect(evidence.evidence.length).toBe(2);
    const byRef = Object.fromEntries(evidence.evidence.map((e) => [e.ref, e]));
    expect(byRef.web_search).toBeDefined();
    expect(byRef.web_search!.sourceType).toBe('web');
    expect(byRef.web_search!.url).toContain('https://kosis.kr');
    expect(byRef.web_extract).toBeDefined();
    expect(byRef.web_extract!.excerpt).toContain('적정성');
    // Both linked to the settled assistant message.
    expect(evidence.evidence.every((e) => e.messageId !== null)).toBe(true);
    expect(evidence.evidence.every((e) => /^run_[0-9a-f]{32}$/.test(e.runId ?? ''))).toBe(true);
  }, 15_000);

  it('E-3: manual evidence attach + membership isolation on evidence reads', async () => {
    installHermesToolEventFetchMock();
    const owner = await makeUser('ev-manual');
    const outsider = await makeUser('ev-outsider');
    const { thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    await request(app.getHttpServer())
      .post('/chat/evidence')
      .set('authorization', owner.bearer)
      .send({
        threadId: thread.id,
        sourceType: 'manual',
        ref: '창원시 2026 예산서',
        excerpt: '3장 세출예산 — 공공시설 운영비 12% 증가',
        url: 'https://changwon.go.kr/budget2026',
      })
      .expect(201);

    const evidence = ListEvidenceResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/evidence`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(evidence.evidence.length).toBe(1);
    expect(evidence.evidence[0]!.sourceType).toBe('manual');
    expect(evidence.evidence[0]!.addedByUserId).toBe(owner.userId);

    // Non-member cannot read evidence.
    await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/evidence`)
      .set('authorization', outsider.bearer)
      .expect(404);
  });

  it('A-1/A-2: artifact create → version append → detail with immutable chain', async () => {
    const owner = await makeUser('art-owner');
    const { project, thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    const created = CreateArtifactResponseSchema.parse(
      (await request(app.getHttpServer())
        .post('/artifacts?includeStructure=1')
        .set('authorization', owner.bearer)
        .send({
          projectId: project.id,
          title: '공공시설 적정성 1차 보고',
          content: '# 초안\n\n| 시설 | 판정 |\n|---|---|\n| A | 유지 |',
          note: '초판',
          structure: {
            governingMessage: '공공시설 A는 현행 운영안을 유지하는 것이 타당합니다.',
            soWhat: '따라서 다음 검토 전까지 시설 운영 방식의 변경을 보류해야 합니다.',
          },
          sourceThreadId: thread.id,
        })
        .expect(201)).body,
    );
    expect(created.versionNo).toBe(1);

    const v2 = CreateArtifactResponseSchema.parse(
      (await request(app.getHttpServer())
        .post(`/artifacts/${created.id}/versions?includeStructure=1`)
        .set('authorization', owner.bearer)
        .send({
          content: '# 개정\n\n수치 보강판',
          note: '수치 보강',
          structure: {
            governingMessage: '보강된 수치에서도 공공시설 A의 현행 유지안이 타당합니다.',
            soWhat: '따라서 정량 근거를 추가하되 운영 방식 변경은 계속 보류해야 합니다.',
          },
        })
        .expect(201)).body,
    );
    expect(v2.versionNo).toBe(2);

    const detail = ArtifactDetailResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/artifacts/${created.id}?includeStructure=1`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(detail.headVersion).toBe(2);
    expect(detail.versions.map((v) => v.versionNo)).toEqual([1, 2]);
    expect(detail.versions[0]!.content).toContain('초안');
    expect(detail.versions[1]!.note).toBe('수치 보강');

    const list = ListArtifactsResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/artifacts/workspaces/${owner.personalWorkspaceId}`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(list.artifacts.some((a) => a.id === created.id && a.headVersion === 2)).toBe(true);
  });

  it('A-4/F-VERIFY: blocks final artifact export when the source answer fails verifier gate', async () => {
    const owner = await makeUser('art-gate-owner');
    const { project, thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);
    const [assistant] = await db
      .insert(schema.chatMessages)
      .values({
        workspaceId: owner.personalWorkspaceId,
        threadId: thread.id,
        role: 'assistant',
        content: '정원 증가는 인건비 부담을 줄입니다.',
        runId: 'run_art_gate',
        finishState: 'complete',
      })
      .returning({ id: schema.chatMessages.id });
    await db.insert(schema.claimVerificationVerdicts).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      assistantMessageId: assistant!.id,
      claimId: 'CL-EXPORT-1',
      claimText: '정원 증가는 인건비 부담을 줄입니다.',
      evidenceRef: 'EV-EXPORT-1',
      verdict: 'refutes',
      confidence: '0.94',
      contradictedTerms: ['증가↔감소'],
      rationale: '핵심 claim이 근거와 모순됩니다.',
      verifier: 'fixture',
    });
    await db.insert(schema.exactnessRuns).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      assistantMessageId: assistant!.id,
      required: true,
      status: 'blocked',
      queryHash: 'export-gate-fixture',
      checks: [],
      summary: '수치 검증 실패',
      answerInstruction: 'export 금지',
    });

    const governingMessage = '핵심 결론은 정원 증가가 인건비 부담을 줄인다는 주장입니다.';
    const soWhat = '따라서 검증이 통과하기 전에는 정원 확대 결정을 집행해서는 안 됩니다.';
    const created = CreateArtifactResponseSchema.parse(
      (await request(app.getHttpServer())
        .post('/artifacts?includeStructure=1')
        .set('authorization', owner.bearer)
        .send({
          projectId: project.id,
          title: '검증 실패 산출물',
          content: '# 검증 실패 산출물\n\n정원 증가는 인건비 부담을 줄입니다.',
          note: '검증 실패 소스에서 저장',
          structure: { governingMessage, soWhat },
          sourceThreadId: thread.id,
          sourceMessageId: assistant!.id,
        })
        .expect(201)).body,
    );

    const [artifactVersion] = await db
      .select({
        id: schema.artifactVersions.id,
        content: schema.artifactVersions.content,
        governingMessage: schema.artifactVersions.governingMessage,
        soWhat: schema.artifactVersions.soWhat,
        versionNo: schema.artifactVersions.versionNo,
        sourceThreadId: schema.artifactVersions.sourceThreadId,
        sourceMessageId: schema.artifactVersions.sourceMessageId,
      })
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.artifactId, created.id))
      .limit(1);
    expect(artifactVersion).toBeDefined();
    const verificationTarget = {
      artifactId: created.id,
      artifactVersionId: artifactVersion!.id,
      workspaceId: owner.personalWorkspaceId,
      projectId: project.id,
      title: '검증 실패 산출물',
      versionNo: artifactVersion!.versionNo,
      content: artifactVersion!.content,
      governingMessage: artifactVersion!.governingMessage,
      soWhat: artifactVersion!.soWhat,
      sourceThreadId: artifactVersion!.sourceThreadId,
      sourceMessageId: artifactVersion!.sourceMessageId,
    };
    const blockedGate = {
      decision: 'BLOCKED' as const,
      blockers: [
        { code: 'exactness_blocked' as const, severity: 'blocker' as const, message: '수치 검증이 차단됐습니다.' },
        { code: 'high_impact_refute' as const, severity: 'blocker' as const, message: '핵심 주장이 반박됐습니다.', claimId: 'CL-EXPORT-1' },
      ],
      warnings: [],
    };
    await db.insert(schema.artifactVersionVerifications).values({
      workspaceId: owner.personalWorkspaceId,
      projectId: project.id,
      artifactId: created.id,
      artifactVersionId: artifactVersion!.id,
      contentHash: artifactContentHash(
        artifactVersion!.content,
        artifactVersion!.governingMessage,
        artifactVersion!.soWhat,
      ),
      sourceThreadId: thread.id,
      sourceMessageId: assistant!.id,
      status: 'blocked',
      exactness: { status: 'blocked' },
      verdicts: [{ claimId: 'CL-EXPORT-1', verdict: 'refutes' }],
      gate: blockedGate,
      verifier: `${artifactVerificationPolicyPrefix(verificationTarget)}:fixture`,
      evidenceCount: 1,
      verifiedByUserId: owner.userId,
    });

    const response = await request(app.getHttpServer())
      .get(`/artifacts/${created.id}/export?format=pdf`)
      .set('authorization', owner.bearer)
      .expect(409);

    expect(response.body).toMatchObject({
      code: 'VERIFIER_GATE_BLOCKED',
      gate: {
        decision: 'BLOCKED',
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: 'exactness_blocked' }),
          expect.objectContaining({ code: 'high_impact_refute', claimId: 'CL-EXPORT-1' }),
        ]),
      },
    });
  });

  it('A-2: outsider cannot read or write artifacts (tenant isolation)', async () => {
    const owner = await makeUser('art-iso-owner');
    const outsider = await makeUser('art-iso-out');
    const { project } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    const created = CreateArtifactResponseSchema.parse(
      (await request(app.getHttpServer())
        .post('/artifacts')
        .set('authorization', owner.bearer)
        .send({ projectId: project.id, title: '격리 테스트', content: '내용' })
        .expect(201)).body,
    );

    await request(app.getHttpServer())
      .get(`/artifacts/${created.id}`)
      .set('authorization', outsider.bearer)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/artifacts/${created.id}/versions`)
      .set('authorization', outsider.bearer)
      .send({ content: '악성 개정' })
      .expect(404);
    await request(app.getHttpServer())
      .post('/artifacts')
      .set('authorization', outsider.bearer)
      .send({ projectId: project.id, title: '침투', content: 'x' })
      .expect(404);
  });

  it('A-2/F-VERIFY: rejects artifact source ids that do not belong to the artifact project', async () => {
    const owner = await makeUser('art-source-owner');
    const foreign = await makeUser('art-source-foreign');
    const { project } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);
    const foreignSpaces = await makeSpaces(foreign.bearer, foreign.personalWorkspaceId);
    const [foreignAssistant] = await db
      .insert(schema.chatMessages)
      .values({
        workspaceId: foreign.personalWorkspaceId,
        threadId: foreignSpaces.thread.id,
        role: 'assistant',
        content: '외부 워크스페이스 검증 실패 답변',
        runId: 'run_foreign_artifact_source',
        finishState: 'complete',
      })
      .returning({ id: schema.chatMessages.id });

    await request(app.getHttpServer())
      .post('/artifacts')
      .set('authorization', owner.bearer)
      .send({
        projectId: project.id,
        title: '외부 소스 침투 산출물',
        content: '외부 sourceMessageId를 붙이면 안 됩니다.',
        sourceMessageId: foreignAssistant!.id,
      })
      .expect(400);

    const created = CreateArtifactResponseSchema.parse(
      (await request(app.getHttpServer())
        .post('/artifacts')
        .set('authorization', owner.bearer)
        .send({ projectId: project.id, title: '정상 산출물', content: '정상 초안' })
        .expect(201)).body,
    );

    await request(app.getHttpServer())
      .post(`/artifacts/${created.id}/versions`)
      .set('authorization', owner.bearer)
      .send({ content: '외부 sourceMessageId를 붙인 개정', sourceMessageId: foreignAssistant!.id })
      .expect(400);
  });

  it('F-1/F-3: assistant reply notifies OTHER members; mark-read clears unread', async () => {
    installHermesToolEventFetchMock();
    const owner = await makeUser('noti-owner');
    const member = await makeUser('noti-member');
    const { thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    // Bring member into the workspace via share-link invitation.
    const invite = (await request(app.getHttpServer())
      .post('/invitations')
      .set('authorization', owner.bearer)
      .send({
        workspaceId: owner.personalWorkspaceId,
        scopeType: 'workspace',
        scopeId: owner.personalWorkspaceId,
        role: 'editor',
      })
      .expect(201)).body as { token: string };
    await request(app.getHttpServer())
      .post('/invitations/accept')
      .set('authorization', member.bearer)
      .send({ token: invite.token })
      .expect(201);

    // member_joined lands in owner's feed.
    const ownerFeed = ListNotificationsResponseSchema.parse(
      (await request(app.getHttpServer()).get('/notifications').set('authorization', owner.bearer).expect(200)).body,
    );
    expect(ownerFeed.notifications.some((n) => n.type === 'member_joined')).toBe(true);

    // Owner chats — assistant settle should notify member (not owner).
    await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', owner.bearer)
      .send({ threadId: thread.id, message: '알림 테스트', clientMessageId: randomUUID() })
      .expect(200);

    const memberFeed = await waitForValue(
      'assistant reply notification',
      async () => ListNotificationsResponseSchema.parse(
        (await request(app.getHttpServer()).get('/notifications').set('authorization', member.bearer).expect(200)).body,
      ),
      (value) => value.notifications.some((notification) => notification.type === 'assistant_reply'),
    );
    const reply = memberFeed.notifications.find((n) => n.type === 'assistant_reply');
    expect(reply).toBeDefined();
    expect(reply!.refType).toBe('thread');
    expect(reply!.refId).toBe(thread.id);
    expect(memberFeed.unreadCount).toBeGreaterThan(0);

    // Owner does NOT get their own assistant_reply notification.
    const ownerFeed2 = ListNotificationsResponseSchema.parse(
      (await request(app.getHttpServer()).get('/notifications').set('authorization', owner.bearer).expect(200)).body,
    );
    expect(ownerFeed2.notifications.some((n) => n.type === 'assistant_reply')).toBe(false);

    // Mark all read.
    await request(app.getHttpServer())
      .post('/notifications/read')
      .set('authorization', member.bearer)
      .send({})
      .expect(201);
    const memberFeed2 = ListNotificationsResponseSchema.parse(
      (await request(app.getHttpServer()).get('/notifications').set('authorization', member.bearer).expect(200)).body,
    );
    expect(memberFeed2.unreadCount).toBe(0);
  }, 15_000);

  it('G-3: upload/list/send/download attachment as message attachment without auto-evidence', async () => {
    installHermesPlainFetchMock();
    const owner = await makeUser('att-owner');
    const outsider = await makeUser('att-out');
    const { thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    const payload = Buffer.from('창원시 예산서 텍스트 본문 — 공공시설 운영비 근거자료').toString('base64');
    const uploaded = UploadAttachmentResponseSchema.parse(
      (await request(app.getHttpServer())
        .post('/attachments')
        .set('authorization', owner.bearer)
        .send({ threadId: thread.id, fileName: '예산서.txt', mimeType: 'text/plain', dataBase64: payload })
        .expect(201)).body,
    );

    // mime not on allowlist → 400
    await request(app.getHttpServer())
      .post('/attachments')
      .set('authorization', owner.bearer)
      .send({ threadId: thread.id, fileName: 'x.exe', mimeType: 'application/x-msdownload', dataBase64: payload })
      .expect(400);

    let list = ListAttachmentsResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/attachments/threads/${thread.id}`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(list.attachments.length).toBe(1);
    expect(list.attachments[0]!.fileName).toBe('예산서.txt');
    expect(list.attachments[0]!.sizeBytes).toBeGreaterThan(0);
    expect(['processing', 'indexed']).toContain(list.attachments[0]!.extraction?.status);
    if (list.attachments[0]!.extraction?.status === 'indexed') {
      expect(list.attachments[0]!.extraction?.extractor).toBe('text/plain');
      expect(list.attachments[0]!.extraction?.textChars).toBeGreaterThan(10);
      expect(list.attachments[0]!.extraction?.qualityScore).toBeGreaterThanOrEqual(60);
    }

    // Uploading/extracting a file is NOT evidence by default. Evidence is an
    // explicit user/tool action; attachments live as draft chips until sent.
    const evidenceBeforeSend = ListEvidenceResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/evidence`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(evidenceBeforeSend.evidence).toEqual([]);

    await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', owner.bearer)
      .send({ threadId: thread.id, message: '', clientMessageId: randomUUID(), attachmentIds: [uploaded.id] })
      .expect(200);

    const draftAfterSend = ListAttachmentsResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/attachments/threads/${thread.id}`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(draftAfterSend.attachments).toEqual([]);

    const messages = ListMessagesPageResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/messages?page=1&limit=5`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    const userMessage = messages.messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage!.content).toBe('');
    expect(userMessage!.attachments).toHaveLength(1);
    expect(userMessage!.attachments![0]!.id).toBe(uploaded.id);
    expect(userMessage!.attachments![0]!.fileName).toBe('예산서.txt');

    const evidenceAfterSend = ListEvidenceResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/evidence`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(evidenceAfterSend.evidence).toEqual([]);

    const dl = await request(app.getHttpServer())
      .get(`/attachments/${uploaded.id}/content`)
      .set('authorization', owner.bearer)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.from(dl.body as Buffer).toString('utf8')).toContain('창원시 예산서');

    // outsider blocked on list + download
    await request(app.getHttpServer())
      .get(`/attachments/threads/${thread.id}`)
      .set('authorization', outsider.bearer)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/attachments/${uploaded.id}/content`)
      .set('authorization', outsider.bearer)
      .expect(403);
  });

  it('G-3: owner can delete a draft attachment and it disappears from list/download', async () => {
    const owner = await makeUser('att-del-owner');
    const outsider = await makeUser('att-del-out');
    const { thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);
    const payload = Buffer.from('삭제 가능한 draft 첨부').toString('base64');
    const uploaded = UploadAttachmentResponseSchema.parse(
      (await request(app.getHttpServer())
        .post('/attachments')
        .set('authorization', owner.bearer)
        .send({ threadId: thread.id, fileName: 'delete-me.txt', mimeType: 'text/plain', dataBase64: payload })
        .expect(201)).body,
    );

    await request(app.getHttpServer())
      .delete(`/attachments/${uploaded.id}`)
      .set('authorization', outsider.bearer)
      .expect(403);

    const deleted = OkResponseSchema.parse(
      (await request(app.getHttpServer())
        .delete(`/attachments/${uploaded.id}`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(deleted.ok).toBe(true);

    const list = ListAttachmentsResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/attachments/threads/${thread.id}`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(list.attachments).toEqual([]);

    await request(app.getHttpServer())
      .get(`/attachments/${uploaded.id}/content`)
      .set('authorization', owner.bearer)
      .expect(404);
  });
});
