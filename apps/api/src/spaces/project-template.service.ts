import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import { ok, err, type Result, domainError } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export interface ProjectTemplateTopicSpec {
  name: string;
  slug: string;
  defaultThreadTitle: string;
}

export interface ProjectTemplateChannelSpec {
  name: string;
  slug: string;
  topics: ProjectTemplateTopicSpec[];
}

export interface ProjectTemplateSpec {
  templateKey: 'consulting_default';
  channels: ProjectTemplateChannelSpec[];
}

export interface ApplyConsultingDefaultCommand {
  projectId: string;
  actorUserId: string;
  brainSlugOverride?: string;
  requestId?: string;
}

export interface ApplyProjectTemplateResult {
  projectId: string;
  brainSlug: string;
  created: {
    channels: number;
    topics: number;
    threads: number;
    consultingLinks: number;
  };
}

export interface ProjectTemplateBackfillPreview {
  readOnly: true;
  projectId: string;
  projectName: string;
  projectSlug: string;
  brainSlug: string;
  expectedMemoryTopicPrefix: string;
  before: {
    channels: number;
    topics: number;
    threads: number;
    messages: number;
    consultingLinks: number;
  };
  plannedCreates: {
    channels: number;
    topics: number;
    threads: number;
    consultingLinks: number;
  };
  existingConsultingTopicSlugs: string[];
  warnings: string[];
}

export const CONSULTING_DEFAULT_TEMPLATE: ProjectTemplateSpec = {
  templateKey: 'consulting_default',
  channels: [
    {
      name: '자료수집',
      slug: 'source-collection',
      topics: [
        { name: '원문·근거', slug: 'source-evidence', defaultThreadTitle: '원문·근거 수집' },
        { name: '인터뷰·현장메모', slug: 'field-notes', defaultThreadTitle: '인터뷰·현장메모 수집' },
      ],
    },
    {
      name: '분석',
      slug: 'analysis',
      topics: [
        { name: '쟁점분석', slug: 'issue-analysis', defaultThreadTitle: '쟁점분석' },
        { name: '정량·정확성 검산', slug: 'exactness-check', defaultThreadTitle: '정량·정확성 검산' },
      ],
    },
    {
      name: '보고서',
      slug: 'reports',
      topics: [
        { name: '보고서 초안', slug: 'draft-report', defaultThreadTitle: '보고서 초안' },
        { name: '검토·수정', slug: 'review-revision', defaultThreadTitle: '검토·수정' },
      ],
    },
    {
      name: '질의응답',
      slug: 'qna',
      topics: [{ name: 'Q&A', slug: 'qna', defaultThreadTitle: 'Q&A' }],
    },
    {
      name: '대화',
      slug: 'conversation',
      topics: [{ name: '기본 대화', slug: 'default-chat', defaultThreadTitle: '기본 대화' }],
    },
  ],
};

export interface ProjectTemplateProject {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
}

class ProjectTemplateConflictError extends Error {}

@Injectable()
export class ProjectTemplateService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async applyConsultingDefault(cmd: ApplyConsultingDefaultCommand): Promise<Result<ApplyProjectTemplateResult>> {
    const [project] = await this.db
      .select({
        id: schema.projects.id,
        workspaceId: schema.projects.workspaceId,
        name: schema.projects.name,
        slug: schema.projects.slug,
      })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, cmd.projectId), eq(schema.projects.status, 'active'), isNull(schema.projects.deletedAt)))
      .limit(1);

    if (!project) return err(domainError('NOT_FOUND', 'project not found'));

    try {
      const result = await this.db.transaction((tx) => this.applyConsultingDefaultToProjectInTransaction(tx, project, cmd));
      return ok(result);
    } catch (error) {
      if (error instanceof ProjectTemplateConflictError) {
        return err(domainError('CONFLICT', error.message));
      }
      return err(domainError('INTERNAL', 'apply consulting_default template failed'));
    }
  }

  async previewConsultingDefaultBackfill(projectId: string): Promise<Result<ProjectTemplateBackfillPreview>> {
    const [project] = await this.db
      .select({
        id: schema.projects.id,
        workspaceId: schema.projects.workspaceId,
        name: schema.projects.name,
        slug: schema.projects.slug,
      })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, projectId), eq(schema.projects.status, 'active'), isNull(schema.projects.deletedAt)))
      .limit(1);

    if (!project) return err(domainError('NOT_FOUND', 'project not found'));

    const brainSlug = normalizeBrainSlug(project.slug, project.id);
    const channels = await this.db
      .select({ id: schema.channels.id, slug: schema.channels.slug })
      .from(schema.channels)
      .where(and(eq(schema.channels.projectId, project.id), isNull(schema.channels.deletedAt)));
    const topics = await this.db
      .select({ id: schema.topics.id, slug: schema.topics.slug, channelId: schema.topics.channelId, memoryTopicId: schema.topics.memoryTopicId })
      .from(schema.topics)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .where(and(eq(schema.channels.projectId, project.id), isNull(schema.channels.deletedAt), isNull(schema.topics.deletedAt)));
    const threads = await this.db
      .select({ id: schema.threads.id, title: schema.threads.title, topicId: schema.threads.topicId })
      .from(schema.threads)
      .innerJoin(schema.topics, eq(schema.topics.id, schema.threads.topicId))
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .where(and(eq(schema.channels.projectId, project.id), isNull(schema.channels.deletedAt), isNull(schema.topics.deletedAt), isNull(schema.threads.deletedAt)));
    const messages = await this.db
      .select({ id: schema.chatMessages.id })
      .from(schema.chatMessages)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.chatMessages.threadId))
      .innerJoin(schema.topics, eq(schema.topics.id, schema.threads.topicId))
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .where(and(eq(schema.channels.projectId, project.id), isNull(schema.channels.deletedAt), isNull(schema.topics.deletedAt), isNull(schema.threads.deletedAt), isNull(schema.chatMessages.deletedAt)));
    const links = await this.db
      .select({ consultingTopicSlug: schema.consultingTopicLinks.consultingTopicSlug })
      .from(schema.consultingTopicLinks)
      .where(and(eq(schema.consultingTopicLinks.projectId, project.id), eq(schema.consultingTopicLinks.status, 'active'), isNull(schema.consultingTopicLinks.archivedAt)));

    const plannedCreates = { channels: 0, topics: 0, threads: 0, consultingLinks: links.some((link) => link.consultingTopicSlug === brainSlug) ? 0 : 1 };
    const expectedMemoryPrefix = `consulting:${brainSlug}#`;

    for (const channelSpec of CONSULTING_DEFAULT_TEMPLATE.channels) {
      const channel = channels.find((row) => row.slug === channelSpec.slug);
      if (!channel) {
        plannedCreates.channels += 1;
        plannedCreates.topics += channelSpec.topics.length;
        plannedCreates.threads += channelSpec.topics.length;
        continue;
      }

      for (const topicSpec of channelSpec.topics) {
        const topic = topics.find((row) => row.channelId === channel.id && row.slug === topicSpec.slug);
        if (!topic) {
          plannedCreates.topics += 1;
          plannedCreates.threads += 1;
          continue;
        }
        const thread = threads.find((row) => row.topicId === topic.id && row.title === topicSpec.defaultThreadTitle);
        if (!thread) plannedCreates.threads += 1;
      }
    }

    const existingConsultingTopicSlugs = links.map((link) => link.consultingTopicSlug).sort();
    const warnings = existingConsultingTopicSlugs
      .filter((slug) => slug !== brainSlug)
      .map((slug) => slug === 'changwon-org-mgmt-diagnosis' ? 'would_conflict_with_changwon_brain' : `would_conflict_with_existing_brain:${slug}`);
    warnings.push(
      ...topics
        .map((topic) => topic.memoryTopicId)
        .filter((memoryTopicId): memoryTopicId is string => Boolean(memoryTopicId && !memoryTopicId.startsWith(expectedMemoryPrefix)))
        .sort()
        .map((memoryTopicId) => `would_conflict_with_existing_memory_topic:${memoryTopicId}`),
    );
    if (brainSlug === 'changwon-org-mgmt-diagnosis') warnings.push('would_link_to_changwon_brain');

    return ok({
      readOnly: true,
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
      brainSlug,
      expectedMemoryTopicPrefix: expectedMemoryPrefix,
      before: {
        channels: channels.length,
        topics: topics.length,
        threads: threads.length,
        messages: messages.length,
        consultingLinks: links.length,
      },
      plannedCreates,
      existingConsultingTopicSlugs,
      warnings,
    });
  }

  async applyConsultingDefaultToProjectInTransaction(
    tx: Tx,
    project: ProjectTemplateProject,
    cmd: Omit<ApplyConsultingDefaultCommand, 'projectId'>,
  ): Promise<ApplyProjectTemplateResult> {
    const brainSlug = normalizeBrainSlug(cmd.brainSlugOverride ?? project.slug, project.id);
    const existingLinks = await tx
      .select({ consultingTopicSlug: schema.consultingTopicLinks.consultingTopicSlug })
      .from(schema.consultingTopicLinks)
      .where(
        and(
          eq(schema.consultingTopicLinks.workspaceId, project.workspaceId),
          eq(schema.consultingTopicLinks.projectId, project.id),
          eq(schema.consultingTopicLinks.status, 'active'),
          isNull(schema.consultingTopicLinks.archivedAt),
        ),
      );
    if (existingLinks.some((link) => link.consultingTopicSlug !== brainSlug)) {
      throw new ProjectTemplateConflictError('project already has active consulting brain link');
    }
    await this.assertNoConflictingMemoryTopics(tx, project, brainSlug);

    const created = { channels: 0, topics: 0, threads: 0, consultingLinks: 0 };

    const [createdProjectLink] = await tx
      .insert(schema.consultingTopicLinks)
      .values({
        workspaceId: project.workspaceId,
        projectId: project.id,
        linkLevel: 'project',
        consultingTopicSlug: brainSlug,
        scopePath: project.name,
        origin: 'system',
        createdByUserId: cmd.actorUserId,
      })
      .onConflictDoNothing()
      .returning({ id: schema.consultingTopicLinks.id });
    if (createdProjectLink) created.consultingLinks += 1;

    const [projectLink] = await tx
      .select({ id: schema.consultingTopicLinks.id })
      .from(schema.consultingTopicLinks)
      .where(
        and(
          eq(schema.consultingTopicLinks.projectId, project.id),
          eq(schema.consultingTopicLinks.linkLevel, 'project'),
          eq(schema.consultingTopicLinks.status, 'active'),
          eq(schema.consultingTopicLinks.consultingTopicSlug, brainSlug),
          isNull(schema.consultingTopicLinks.archivedAt),
        ),
      )
      .limit(1);
    if (!projectLink && !createdProjectLink) throw new Error('project consulting link missing');

    for (const channelSpec of CONSULTING_DEFAULT_TEMPLATE.channels) {
      const channel = await this.ensureChannel(tx, {
        workspaceId: project.workspaceId,
        projectId: project.id,
        projectName: project.name,
        actorUserId: cmd.actorUserId,
        requestId: cmd.requestId,
        spec: channelSpec,
        created,
      });

      for (const topicSpec of channelSpec.topics) {
        const topic = await this.ensureTopic(tx, {
          workspaceId: project.workspaceId,
          channelId: channel.id,
          channelName: channel.name,
          channelSlug: channel.slug,
          actorUserId: cmd.actorUserId,
          requestId: cmd.requestId,
          brainSlug,
          spec: topicSpec,
          created,
        });
        await this.ensureThread(tx, {
          workspaceId: project.workspaceId,
          topicId: topic.id,
          actorUserId: cmd.actorUserId,
          requestId: cmd.requestId,
          spec: topicSpec,
          created,
        });
      }
    }

    return { projectId: project.id, brainSlug, created };
  }

  private async ensureChannel(
    tx: Tx,
    input: {
      workspaceId: string;
      projectId: string;
      projectName: string;
      actorUserId: string;
      requestId: string | undefined;
      spec: ProjectTemplateChannelSpec;
      created: ApplyProjectTemplateResult['created'];
    },
  ): Promise<{ id: string; name: string; slug: string }> {
    const existing = await tx
      .select({ id: schema.channels.id, name: schema.channels.name, slug: schema.channels.slug })
      .from(schema.channels)
      .where(and(eq(schema.channels.projectId, input.projectId), eq(schema.channels.slug, input.spec.slug), isNull(schema.channels.deletedAt)))
      .limit(1);
    if (existing[0]) {
      await this.ensureTemplateProfile(tx, {
        workspaceId: input.workspaceId,
        scopeType: 'channel',
        scopeId: existing[0].id,
        actorUserId: input.actorUserId,
        profile: channelTemplateProfile(input.spec),
      });
      return existing[0];
    }

    const [channel] = await tx
      .insert(schema.channels)
      .values({ workspaceId: input.workspaceId, projectId: input.projectId, name: input.spec.name, slug: input.spec.slug })
      .returning({ id: schema.channels.id, name: schema.channels.name, slug: schema.channels.slug });
    if (!channel) throw new Error('channel insert failed');
    input.created.channels += 1;

    await tx.insert(schema.contextEdges).values({
      workspaceId: input.workspaceId,
      fromScopeType: 'project',
      fromScopeId: input.projectId,
      toScopeType: 'channel',
      toScopeId: channel.id,
      edgeType: 'parent_of',
      origin: 'system',
    }).onConflictDoNothing();

    await this.inheritProjectTagsToChannel(tx, input.workspaceId, input.projectId, channel.id);

    await tx.insert(schema.outboxEvents).values({
      workspaceId: input.workspaceId,
      eventType: 'ChannelCreated',
      aggregateType: 'channel',
      aggregateId: channel.id,
      payload: { projectId: input.projectId, slug: input.spec.slug, templateKey: CONSULTING_DEFAULT_TEMPLATE.templateKey },
      idempotencyKey: `template:${CONSULTING_DEFAULT_TEMPLATE.templateKey}:channel-created:${channel.id}`,
      requestId: input.requestId ?? null,
    }).onConflictDoNothing();

    await tx.insert(schema.auditEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: 'project_template.channel.create',
      scopeType: 'channel',
      scopeId: channel.id,
      after: { projectName: input.projectName, name: input.spec.name, slug: input.spec.slug, templateKey: CONSULTING_DEFAULT_TEMPLATE.templateKey },
      requestId: input.requestId ?? null,
    });

    await this.ensureTemplateProfile(tx, {
      workspaceId: input.workspaceId,
      scopeType: 'channel',
      scopeId: channel.id,
      actorUserId: input.actorUserId,
      profile: channelTemplateProfile(input.spec),
    });

    return channel;
  }

  private async ensureTopic(
    tx: Tx,
    input: {
      workspaceId: string;
      channelId: string;
      channelName: string;
      channelSlug: string;
      actorUserId: string;
      requestId: string | undefined;
      brainSlug: string;
      spec: ProjectTemplateTopicSpec;
      created: ApplyProjectTemplateResult['created'];
    },
  ): Promise<{ id: string; name: string; slug: string }> {
    const memoryTopicId = `consulting:${input.brainSlug}#${input.channelSlug}/${input.spec.slug}`;
    const existing = await tx
      .select({ id: schema.topics.id, name: schema.topics.name, slug: schema.topics.slug, memoryTopicId: schema.topics.memoryTopicId })
      .from(schema.topics)
      .where(and(eq(schema.topics.channelId, input.channelId), eq(schema.topics.slug, input.spec.slug), isNull(schema.topics.deletedAt)))
      .limit(1);
    if (existing[0]) {
      if (existing[0].memoryTopicId && existing[0].memoryTopicId !== memoryTopicId) {
        throw new ProjectTemplateConflictError('template topic already points at another memory topic');
      }
      if (!existing[0].memoryTopicId) {
        await tx.update(schema.topics).set({ memoryTopicId }).where(eq(schema.topics.id, existing[0].id));
      }
      await this.ensureTemplateProfile(tx, {
        workspaceId: input.workspaceId,
        scopeType: 'topic',
        scopeId: existing[0].id,
        actorUserId: input.actorUserId,
        profile: topicTemplateProfile(input.channelName, input.spec),
      });
      return existing[0];
    }

    const [topic] = await tx
      .insert(schema.topics)
      .values({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        name: input.spec.name,
        slug: input.spec.slug,
        memoryTopicId,
      })
      .returning({ id: schema.topics.id, name: schema.topics.name, slug: schema.topics.slug });
    if (!topic) throw new Error('topic insert failed');
    input.created.topics += 1;

    await tx.insert(schema.contextEdges).values({
      workspaceId: input.workspaceId,
      fromScopeType: 'channel',
      fromScopeId: input.channelId,
      toScopeType: 'topic',
      toScopeId: topic.id,
      edgeType: 'parent_of',
      origin: 'system',
    }).onConflictDoNothing();

    await tx.insert(schema.outboxEvents).values({
      workspaceId: input.workspaceId,
      eventType: 'TopicCreated',
      aggregateType: 'topic',
      aggregateId: topic.id,
      payload: { channelId: input.channelId, slug: input.spec.slug, templateKey: CONSULTING_DEFAULT_TEMPLATE.templateKey },
      idempotencyKey: `template:${CONSULTING_DEFAULT_TEMPLATE.templateKey}:topic-created:${topic.id}`,
      requestId: input.requestId ?? null,
    }).onConflictDoNothing();

    await tx.insert(schema.auditEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: 'project_template.topic.create',
      scopeType: 'topic',
      scopeId: topic.id,
      after: { channelName: input.channelName, name: input.spec.name, slug: input.spec.slug, memoryTopicId, templateKey: CONSULTING_DEFAULT_TEMPLATE.templateKey },
      requestId: input.requestId ?? null,
    });

    await this.ensureTemplateProfile(tx, {
      workspaceId: input.workspaceId,
      scopeType: 'topic',
      scopeId: topic.id,
      actorUserId: input.actorUserId,
      profile: topicTemplateProfile(input.channelName, input.spec),
    });

    return topic;
  }

  private async ensureThread(
    tx: Tx,
    input: {
      workspaceId: string;
      topicId: string;
      actorUserId: string;
      requestId: string | undefined;
      spec: ProjectTemplateTopicSpec;
      created: ApplyProjectTemplateResult['created'];
    },
  ): Promise<void> {
    const existing = await tx
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(and(eq(schema.threads.topicId, input.topicId), eq(schema.threads.title, input.spec.defaultThreadTitle), isNull(schema.threads.deletedAt)))
      .limit(1);
    if (existing[0]) return;

    const [thread] = await tx
      .insert(schema.threads)
      .values({ workspaceId: input.workspaceId, topicId: input.topicId, title: input.spec.defaultThreadTitle })
      .returning({ id: schema.threads.id });
    if (!thread) throw new Error('thread insert failed');
    input.created.threads += 1;

    await tx.insert(schema.contextEdges).values({
      workspaceId: input.workspaceId,
      fromScopeType: 'topic',
      fromScopeId: input.topicId,
      toScopeType: 'thread',
      toScopeId: thread.id,
      edgeType: 'parent_of',
      origin: 'system',
    }).onConflictDoNothing();

    await tx.insert(schema.outboxEvents).values({
      workspaceId: input.workspaceId,
      eventType: 'ThreadCreated',
      aggregateType: 'thread',
      aggregateId: thread.id,
      payload: { topicId: input.topicId, title: input.spec.defaultThreadTitle, templateKey: CONSULTING_DEFAULT_TEMPLATE.templateKey },
      idempotencyKey: `template:${CONSULTING_DEFAULT_TEMPLATE.templateKey}:thread-created:${thread.id}`,
      requestId: input.requestId ?? null,
    }).onConflictDoNothing();

    await tx.insert(schema.auditEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: 'project_template.thread.create',
      scopeType: 'thread',
      scopeId: thread.id,
      after: { title: input.spec.defaultThreadTitle, templateKey: CONSULTING_DEFAULT_TEMPLATE.templateKey },
      requestId: input.requestId ?? null,
    });
  }

  private async assertNoConflictingMemoryTopics(tx: Tx, project: ProjectTemplateProject, brainSlug: string): Promise<void> {
    const expectedMemoryPrefix = `consulting:${brainSlug}#`;
    const rows = await tx
      .select({ memoryTopicId: schema.topics.memoryTopicId })
      .from(schema.topics)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .where(and(
        eq(schema.channels.workspaceId, project.workspaceId),
        eq(schema.channels.projectId, project.id),
        isNull(schema.channels.deletedAt),
        isNull(schema.topics.deletedAt),
      ));

    if (rows.some((row) => row.memoryTopicId && !row.memoryTopicId.startsWith(expectedMemoryPrefix))) {
      throw new ProjectTemplateConflictError('project already has topics linked to another memory brain');
    }
  }

  private async ensureTemplateProfile(
    tx: Tx,
    input: {
      workspaceId: string;
      scopeType: 'channel' | 'topic';
      scopeId: string;
      actorUserId: string;
      profile: TemplateProfileFields;
    },
  ): Promise<void> {
    const [existing] = await tx
      .select({
        id: schema.scopeProfiles.id,
        source: schema.scopeProfiles.source,
        deletedAt: schema.scopeProfiles.deletedAt,
      })
      .from(schema.scopeProfiles)
      .where(and(
        eq(schema.scopeProfiles.workspaceId, input.workspaceId),
        eq(schema.scopeProfiles.scopeType, input.scopeType),
        eq(schema.scopeProfiles.scopeId, input.scopeId),
      ))
      .limit(1);

    if (existing?.source === 'manual' && existing.deletedAt === null) return;

    const values = {
      purpose: input.profile.purpose,
      role: input.profile.role,
      style: input.profile.style,
      rules: input.profile.rules,
      source: 'template',
      updatedByUserId: input.actorUserId,
      updatedAt: new Date(),
      deletedAt: null,
    };

    if (existing) {
      await tx.update(schema.scopeProfiles).set(values).where(eq(schema.scopeProfiles.id, existing.id));
      return;
    }

    await tx.insert(schema.scopeProfiles).values({
      workspaceId: input.workspaceId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      purpose: input.profile.purpose,
      role: input.profile.role,
      style: input.profile.style,
      rules: input.profile.rules,
      source: 'template',
      createdByUserId: input.actorUserId,
      updatedByUserId: input.actorUserId,
    }).onConflictDoNothing();
  }

  private async inheritProjectTagsToChannel(tx: Tx, workspaceId: string, projectId: string, channelId: string): Promise<void> {
    const projectTags = await tx
      .select({ tagId: schema.scopeTags.tagId })
      .from(schema.scopeTags)
      .where(and(
        eq(schema.scopeTags.workspaceId, workspaceId),
        eq(schema.scopeTags.scopeType, 'project'),
        eq(schema.scopeTags.scopeId, projectId),
        isNull(schema.scopeTags.deletedAt),
      ));

    for (const tag of projectTags) {
      await tx
        .insert(schema.scopeTags)
        .values({
          workspaceId,
          scopeType: 'channel',
          scopeId: channelId,
          tagId: tag.tagId,
          origin: 'inherited',
        })
        .onConflictDoNothing();
    }
  }

}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

type TemplateProfileFields = {
  purpose: string;
  role: string;
  style: string;
  rules: string;
};

function channelTemplateProfile(spec: ProjectTemplateChannelSpec): TemplateProfileFields {
  const descriptions: Record<string, string> = {
    'source-collection': '원문·근거·인터뷰 등 판단 재료를 누락 없이 모으는 채널',
    analysis: '수집 자료를 근거 기반으로 해석하고 쟁점을 구조화하는 분석 채널',
    reports: '검토 가능한 보고서 초안과 수정본을 만드는 산출물 채널',
    qna: '프로젝트 관련 질문을 짧게 받고 근거 중심으로 답하는 질의응답 채널',
    conversation: '프로젝트 전반의 자유 대화와 작업 지시를 받는 기본 채널',
  };
  return {
    purpose: descriptions[spec.slug] ?? `${spec.name} 업무를 처리하는 채널`,
    role: `${spec.name} 담당 컨설팅 채널`,
    style: '한국어로 간결하게, 결론 먼저, 근거와 한계를 분리한다.',
    rules: '근거 없는 단정 금지. 숫자·날짜·DB 상태는 재측정하거나 검산 필요성을 명시한다.',
  };
}

function topicTemplateProfile(channelName: string, spec: ProjectTemplateTopicSpec): TemplateProfileFields {
  return {
    purpose: `${channelName} 채널의 ${spec.name} 토픽을 다룬다.`,
    role: `${spec.name} 담당 토픽`,
    style: '짧은 실행 단위로 정리하고, 필요한 경우 체크리스트로 답한다.',
    rules: '이 토픽 범위를 벗어난 결론은 참고용으로 표시한다. 근거·계산·원문 확인이 필요한 주장은 검증 전 단정하지 않는다.',
  };
}

function normalizeBrainSlug(value: string, projectId: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `project-${projectId.slice(0, 8)}`;
}
