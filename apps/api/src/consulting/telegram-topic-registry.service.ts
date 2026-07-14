import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import { domainError, err, ok, type Result } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export interface TelegramTopicProfile {
  purpose: string;
  role: string;
  style: string;
  rules: string;
}

export interface TelegramTopicRegistryEntry {
  telegramChatId: string;
  telegramThreadId: string;
  telegramTopicName: string;
  webTopicName: string;
  webTopicSlug: string;
  defaultThreadTitle: string;
  consultingTopicSlug: string;
  memoryTopicId: string;
  profile: TelegramTopicProfile;
  reviewRequired?: boolean;
}

export interface TelegramTopicBackfillSnapshot {
  workspaceId: string;
  projectId: string;
  projectName: string;
  telegramChannel: { id: string; slug: string; name: string } | null;
  existingTopics: Array<{
    id: string;
    channelId: string;
    slug: string;
    name: string;
    memoryTopicId: string | null;
  }>;
  existingThreads: Array<{ id: string; topicId: string; title: string }>;
  existingTelegramTopicLinks: Array<{
    workspaceId: string;
    projectId: string;
    channelId: string;
    webTopicId: string;
    threadId: string | null;
    telegramChatId: string;
    telegramThreadId: string;
    consultingTopicSlug: string;
    memoryTopicId: string;
    ancestorWorkspaceId?: string | null;
    ancestorWorkspaceStatus?: string | null;
    ancestorWorkspaceDeletedAt?: Date | null;
    ancestorProjectWorkspaceId?: string | null;
    ancestorProjectStatus?: string | null;
    ancestorProjectDeletedAt?: Date | null;
    ancestorChannelWorkspaceId?: string | null;
    ancestorChannelProjectId?: string | null;
    ancestorChannelStatus?: string | null;
    ancestorChannelDeletedAt?: Date | null;
    ancestorTopicWorkspaceId?: string | null;
    ancestorTopicChannelId?: string | null;
    ancestorTopicSlug?: string | null;
    ancestorTopicMemoryTopicId?: string | null;
    ancestorTopicStatus?: string | null;
    ancestorTopicDeletedAt?: Date | null;
    ancestorThreadWorkspaceId?: string | null;
    ancestorThreadTopicId?: string | null;
    ancestorThreadTitle?: string | null;
    ancestorThreadStatus?: string | null;
    ancestorThreadDeletedAt?: Date | null;
  }>;
  existingTopicProfiles: Array<{ scopeType: string; scopeId: string; source: string }>;
  before: { webMessages: number; telegramChunks: number };
  warnings?: string[];
}

export interface TelegramTopicBackfillPlan {
  readOnly: true;
  projectId: string;
  projectName: string;
  registry: TelegramTopicRegistryEntry[];
  exactBindingKeys: string[];
  before: { webMessages: number; telegramChunks: number };
  plannedCreates: {
    channels: number;
    topics: number;
    threads: number;
    telegramTopicLinks: number;
    topicProfiles: number;
  };
  plannedRows: {
    topics: Array<{ slug: string; name: string; memoryTopicId: string }>;
    threads: Array<{ topicSlug: string; title: string }>;
    telegramTopicLinks: Array<{
      telegramChatId: string;
      telegramThreadId: string;
      memoryTopicId: string;
    }>;
    topicProfiles: Array<{ topicSlug: string; source: string; purpose: string }>;
  };
  warnings: string[];
}

export interface TelegramTopicBindingAuditRow {
  telegramChatId: string;
  telegramThreadId: string | null;
  telegramTopicName: string | null;
  consultingTopicSlug: string | null;
  memoryTopicId: string | null;
  webTopicSlug: string | null;
  webTopicName: string | null;
  webTopicMemoryTopicId: string | null;
  threadTitle: string | null;
  status: string | null;
}

export interface TelegramTopicBindingAuditSnapshot {
  workspaceId: string;
  projectId: string;
  projectName: string;
  topicLinks: TelegramTopicBindingAuditRow[];
}

export type TelegramTopicBindingAuditIssueCode =
  | 'BROAD_OR_NULL_THREAD_BINDING'
  | 'DUPLICATE_ACTIVE_TELEGRAM_TOPIC_LINK'
  | 'MISSING_TELEGRAM_TOPIC_LINK'
  | 'UNEXPECTED_TELEGRAM_TOPIC_LINK'
  | 'MEMORY_TOPIC_MISMATCH'
  | 'WEB_TOPIC_MISMATCH'
  | 'THREAD_TITLE_MISMATCH'
  | 'CONSULTING_TOPIC_MISMATCH'
  | 'TELEGRAM_TOPIC_NAME_MISMATCH';

export interface TelegramTopicBindingAuditIssue {
  code: TelegramTopicBindingAuditIssueCode;
  severity: 'blocker' | 'warning';
  key: string;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface TelegramTopicBindingAuditResult {
  readOnly: true;
  status: 'ok' | 'blocked';
  workspaceId: string;
  projectId: string;
  projectName: string;
  registryCount: number;
  activeBindingCount: number;
  exactBindingKeys: string[];
  matchedKeys: string[];
  blockers: TelegramTopicBindingAuditIssue[];
  warnings: TelegramTopicBindingAuditIssue[];
}

const CHANGWON_CHAT_ID = '-1004453868195';
const CHANGWON_BRAIN = 'changwon-org-mgmt-diagnosis';
const TELEGRAM_MEMORY_PREFIX = `consulting:${CHANGWON_BRAIN}#telegram`;

export const CHANGWON_TELEGRAM_TOPIC_REGISTRY: TelegramTopicRegistryEntry[] = [
  {
    telegramChatId: CHANGWON_CHAT_ID,
    telegramThreadId: '12',
    telegramTopicName: '창원-컨설팅',
    webTopicName: '창원-컨설팅',
    webTopicSlug: 'changwon-consulting',
    defaultThreadTitle: '창원-컨설팅',
    consultingTopicSlug: 'changwon-consulting',
    memoryTopicId: `${TELEGRAM_MEMORY_PREFIX}/changwon-consulting`,
    profile: {
      purpose: '창원 컨설팅 일반 질의와 초기 논의를 처리한다.',
      role: '창원 컨설팅 일반 조정자',
      style: '한국어로 간결하게, 결론 먼저, 내부 경로/마크다운 과잉 노출 없이 답한다.',
      rules:
        '창원 컨설팅 공통 맥락을 우선하되, 보수·근속승진·대행사업 세부 질문은 해당 전용 토픽 근거와 라벨을 우선한다.',
    },
  },
  {
    telegramChatId: CHANGWON_CHAT_ID,
    telegramThreadId: '524',
    telegramTopicName: '창원_보수체계',
    webTopicName: '창원_보수체계',
    webTopicSlug: 'changwon-pay-system',
    defaultThreadTitle: '창원_보수체계',
    consultingTopicSlug: 'changwon-pay-system',
    memoryTopicId: `${TELEGRAM_MEMORY_PREFIX}/changwon-pay-system`,
    profile: {
      purpose: '보수수준·직급·호봉·보수체계 비교와 산정 근거를 분리해 검토한다.',
      role: '창원 보수체계 분석가',
      style: '숫자와 기준을 분리하고, 계산은 검산 전 단정하지 않는다.',
      rules:
        '보수, 직급, 호봉, 임금, 수당, 지연계수 질문은 이 토픽 근거를 최우선으로 사용한다. 금액·비율은 Exactness Gate 검산 대상으로 취급한다.',
    },
  },
  {
    telegramChatId: CHANGWON_CHAT_ID,
    telegramThreadId: '533',
    telegramTopicName: '창원_근속승진',
    webTopicName: '창원_근속승진',
    webTopicSlug: 'changwon-tenure-promotion',
    defaultThreadTitle: '창원_근속승진',
    consultingTopicSlug: 'changwon-tenure-promotion',
    memoryTopicId: `${TELEGRAM_MEMORY_PREFIX}/changwon-tenure-promotion`,
    profile: {
      purpose: '근속승진·승진체계·직급 전환 효과를 제도와 수치 근거로 검토한다.',
      role: '창원 근속승진 분석가',
      style: '제도 조건, 적용 대상, 수치 효과를 구분해 짧게 답한다.',
      rules:
        '근속승진, 승진, 직급, 호봉 전환 질문은 이 토픽 근거를 최우선으로 사용한다. 적용 조건이 불명확하면 확인 필요로 표시한다.',
    },
  },
  {
    telegramChatId: CHANGWON_CHAT_ID,
    telegramThreadId: '356',
    telegramTopicName: '창원_대행사업',
    webTopicName: '창원_대행사업',
    webTopicSlug: 'changwon-agency-business',
    defaultThreadTitle: '창원_대행사업',
    consultingTopicSlug: 'changwon-agency-business',
    memoryTopicId: `${TELEGRAM_MEMORY_PREFIX}/changwon-agency-business`,
    profile: {
      purpose: '대행사업·위탁·이관·레포츠파크 관련 쟁점과 근거를 분리해 검토한다.',
      role: '창원 대행사업/위탁 분석가',
      style: '사업 범위, 책임 주체, 이관 효과를 구분해 답한다.',
      rules:
        '대행사업, 위탁, 이관, 레포츠파크 질문은 이 토픽 근거를 최우선으로 사용한다. 조직/예산 영향은 근거 확인 전 단정하지 않는다.',
    },
  },
  {
    telegramChatId: CHANGWON_CHAT_ID,
    telegramThreadId: '1060',
    telegramTopicName: '창원_예산편성기준',
    webTopicName: '창원_예산편성기준',
    webTopicSlug: 'changwon-budget-standards',
    defaultThreadTitle: '창원_예산편성기준',
    consultingTopicSlug: 'changwon-budget-standards',
    memoryTopicId: `${TELEGRAM_MEMORY_PREFIX}/changwon-budget-standards`,
    profile: {
      purpose: '창원시설공단 예산편성기준의 조문·적용범위·해석 쟁점을 원문 근거로 검토한다.',
      role: '창원 예산편성기준 분석가',
      style: '조문 원문, 적용 대상, 해석을 분리하고 과대해석 가능성을 명시한다.',
      rules:
        '예산편성기준, 인건비 편성, 수당 신설, 통상임금, 지급근거 질문은 이 토픽 근거를 최우선으로 사용한다. 지방직영기업과 지방공사·공단 적용 범위를 혼동하지 않는다.',
    },
  },
  {
    telegramChatId: CHANGWON_CHAT_ID,
    telegramThreadId: '1',
    telegramTopicName: 'General/검토필요',
    webTopicName: '일반/검토필요',
    webTopicSlug: 'general-review-required',
    defaultThreadTitle: '일반/검토필요',
    consultingTopicSlug: 'changwon-general-review',
    memoryTopicId: `${TELEGRAM_MEMORY_PREFIX}/general`,
    reviewRequired: true,
    profile: {
      purpose: 'General topic으로 들어온 창원 관련 기타 질의를 임시 수용하고 수동 분류를 기다린다.',
      role: '창원 Telegram General 검토 대기함',
      style: '자동 확정하지 말고, 필요한 경우 어느 전용 토픽으로 옮길지 제안한다.',
      rules:
        'thread 1은 검토필요 상태다. 보수/근속승진/대행사업으로 명확히 분류되기 전에는 현재 범위 사실처럼 단정하지 않는다.',
    },
  },
];

export function auditTelegramTopicBindingsFromSnapshot(
  snapshot: TelegramTopicBindingAuditSnapshot,
): TelegramTopicBindingAuditResult {
  const exactBindingKeys = CHANGWON_TELEGRAM_TOPIC_REGISTRY.map((entry) =>
    telegramBindingKey(entry.telegramChatId, entry.telegramThreadId),
  );
  const registryByKey = new Map(
    CHANGWON_TELEGRAM_TOPIC_REGISTRY.map((entry) => [
      telegramBindingKey(entry.telegramChatId, entry.telegramThreadId),
      entry,
    ]),
  );
  const blockers: TelegramTopicBindingAuditIssue[] = [];
  const warnings: TelegramTopicBindingAuditIssue[] = [];
  const activeRows = snapshot.topicLinks.filter((row) => (row.status ?? 'active') === 'active');
  const rowsByKey = new Map<string, TelegramTopicBindingAuditRow[]>();

  for (const row of activeRows) {
    if (!row.telegramThreadId) {
      blockers.push(
        bindingIssue(
          'BROAD_OR_NULL_THREAD_BINDING',
          'blocker',
          `${row.telegramChatId}:NULL`,
          'Active Telegram link is not scoped to an exact forum thread.',
          { row },
        ),
      );
      continue;
    }
    const key = telegramBindingKey(row.telegramChatId, row.telegramThreadId);
    const grouped = rowsByKey.get(key) ?? [];
    grouped.push(row);
    rowsByKey.set(key, grouped);
    if (!registryByKey.has(key) && row.telegramChatId === CHANGWON_CHAT_ID) {
      blockers.push(
        bindingIssue(
          'UNEXPECTED_TELEGRAM_TOPIC_LINK',
          'blocker',
          key,
          'Active Changwon Telegram link is not present in the registry.',
          { row },
        ),
      );
    }
  }

  const matchedKeys: string[] = [];
  for (const [key, entry] of registryByKey) {
    const rows = rowsByKey.get(key) ?? [];
    if (rows.length === 0) {
      blockers.push(
        bindingIssue(
          'MISSING_TELEGRAM_TOPIC_LINK',
          'blocker',
          key,
          'Registry thread has no active web telegram_topic_links row.',
          { expected: entry },
        ),
      );
      continue;
    }
    if (rows.length > 1) {
      blockers.push(
        bindingIssue(
          'DUPLICATE_ACTIVE_TELEGRAM_TOPIC_LINK',
          'blocker',
          key,
          'Registry thread has duplicate active web telegram_topic_links rows.',
          { rows },
        ),
      );
      continue;
    }
    const row = rows[0]!;
    const before = blockers.length;
    if (
      row.memoryTopicId !== entry.memoryTopicId ||
      row.webTopicMemoryTopicId !== entry.memoryTopicId
    ) {
      blockers.push(
        bindingIssue(
          'MEMORY_TOPIC_MISMATCH',
          'blocker',
          key,
          'Telegram link memory topic does not match the registry/web topic memory id.',
          {
            expected: entry.memoryTopicId,
            actualLink: row.memoryTopicId,
            actualWebTopic: row.webTopicMemoryTopicId,
          },
        ),
      );
    }
    if (row.webTopicSlug !== entry.webTopicSlug) {
      blockers.push(
        bindingIssue(
          'WEB_TOPIC_MISMATCH',
          'blocker',
          key,
          'Telegram link points at a different web topic slug.',
          { expected: entry.webTopicSlug, actual: row.webTopicSlug },
        ),
      );
    }
    if (row.threadTitle !== entry.defaultThreadTitle) {
      blockers.push(
        bindingIssue(
          'THREAD_TITLE_MISMATCH',
          'blocker',
          key,
          'Telegram link points at a different default web thread title.',
          { expected: entry.defaultThreadTitle, actual: row.threadTitle },
        ),
      );
    }
    if (row.consultingTopicSlug !== entry.consultingTopicSlug) {
      blockers.push(
        bindingIssue(
          'CONSULTING_TOPIC_MISMATCH',
          'blocker',
          key,
          'Telegram link points at a different consulting brain slug.',
          { expected: entry.consultingTopicSlug, actual: row.consultingTopicSlug },
        ),
      );
    }
    if (row.telegramTopicName !== entry.telegramTopicName) {
      warnings.push(
        bindingIssue(
          'TELEGRAM_TOPIC_NAME_MISMATCH',
          'warning',
          key,
          'Telegram topic display name differs from the registry; routing remains exact but labels may be stale.',
          { expected: entry.telegramTopicName, actual: row.telegramTopicName },
        ),
      );
    }
    if (blockers.length === before) matchedKeys.push(key);
  }

  matchedKeys.sort(bindingKeySort);
  blockers.sort(issueSort);
  warnings.sort(issueSort);
  return {
    readOnly: true,
    status: blockers.length === 0 ? 'ok' : 'blocked',
    workspaceId: snapshot.workspaceId,
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    registryCount: CHANGWON_TELEGRAM_TOPIC_REGISTRY.length,
    activeBindingCount: activeRows.length,
    exactBindingKeys: [...exactBindingKeys].sort(bindingKeySort),
    matchedKeys,
    blockers,
    warnings,
  };
}

export function buildTelegramTopicBackfillPlanFromSnapshot(
  snapshot: TelegramTopicBackfillSnapshot,
): TelegramTopicBackfillPlan {
  const plannedRows: TelegramTopicBackfillPlan['plannedRows'] = {
    topics: [],
    threads: [],
    telegramTopicLinks: [],
    topicProfiles: [],
  };
  const warnings = new Set<string>(snapshot.warnings ?? []);
  const telegramChannel = snapshot.telegramChannel;
  if (!telegramChannel) warnings.add('telegram_channel_missing');

  for (const entry of CHANGWON_TELEGRAM_TOPIC_REGISTRY) {
    if (entry.reviewRequired) warnings.add('thread_1_review_required');
    if (!entry.telegramThreadId) warnings.add('would_create_null_thread_binding');

    const existingTopic = telegramChannel
      ? snapshot.existingTopics.find(
          (topic) => topic.channelId === telegramChannel.id && topic.slug === entry.webTopicSlug,
        )
      : undefined;
    if (!existingTopic) {
      plannedRows.topics.push({
        slug: entry.webTopicSlug,
        name: entry.webTopicName,
        memoryTopicId: entry.memoryTopicId,
      });
      plannedRows.threads.push({ topicSlug: entry.webTopicSlug, title: entry.defaultThreadTitle });
      plannedRows.topicProfiles.push({
        topicSlug: entry.webTopicSlug,
        source: 'inferred',
        purpose: entry.profile.purpose,
      });
    } else {
      const existingThread = snapshot.existingThreads.find(
        (thread) =>
          thread.topicId === existingTopic.id && thread.title === entry.defaultThreadTitle,
      );
      if (!existingThread)
        plannedRows.threads.push({
          topicSlug: entry.webTopicSlug,
          title: entry.defaultThreadTitle,
        });
      const existingProfile = snapshot.existingTopicProfiles.find(
        (profile) => profile.scopeType === 'topic' && profile.scopeId === existingTopic.id,
      );
      if (!existingProfile)
        plannedRows.topicProfiles.push({
          topicSlug: entry.webTopicSlug,
          source: 'inferred',
          purpose: entry.profile.purpose,
        });
      if (existingTopic.memoryTopicId && existingTopic.memoryTopicId !== entry.memoryTopicId) {
        warnings.add(`memory_topic_mismatch:${entry.webTopicSlug}`);
      }
    }

    const existingLink = snapshot.existingTelegramTopicLinks.find(
      (link) =>
        link.telegramChatId === entry.telegramChatId &&
        link.telegramThreadId === entry.telegramThreadId,
    );
    if (!existingLink) {
      plannedRows.telegramTopicLinks.push({
        telegramChatId: entry.telegramChatId,
        telegramThreadId: entry.telegramThreadId,
        memoryTopicId: entry.memoryTopicId,
      });
    } else if (existingLink.memoryTopicId !== entry.memoryTopicId) {
      warnings.add(`telegram_link_memory_topic_mismatch:${entry.telegramThreadId}`);
    }
  }

  return {
    readOnly: true,
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    registry: CHANGWON_TELEGRAM_TOPIC_REGISTRY,
    exactBindingKeys: CHANGWON_TELEGRAM_TOPIC_REGISTRY.map(
      (item) => `${item.telegramChatId}:${item.telegramThreadId}`,
    ),
    before: snapshot.before,
    plannedCreates: {
      channels: telegramChannel ? 0 : 1,
      topics: plannedRows.topics.length,
      threads: plannedRows.threads.length,
      telegramTopicLinks: plannedRows.telegramTopicLinks.length,
      topicProfiles: plannedRows.topicProfiles.length,
    },
    plannedRows,
    warnings: [...warnings].sort(),
  };
}

@Injectable()
export class TelegramTopicRegistryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  getChangwonRegistry(): TelegramTopicRegistryEntry[] {
    return CHANGWON_TELEGRAM_TOPIC_REGISTRY;
  }

  async previewChangwonBackfill(
    projectId: string,
    before: { telegramChunks?: number } = {},
  ): Promise<Result<TelegramTopicBackfillPlan>> {
    const [project] = await this.db
      .select({
        id: schema.projects.id,
        workspaceId: schema.projects.workspaceId,
        name: schema.projects.name,
      })
      .from(schema.projects)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.projects.workspaceId))
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.status, 'active'),
          isNull(schema.projects.deletedAt),
          eq(schema.workspaces.status, 'active'),
          isNull(schema.workspaces.deletedAt),
        ),
      )
      .limit(1);
    if (!project) return err(domainError('NOT_FOUND', 'project not found'));

    const channels = await this.db
      .select({
        id: schema.channels.id,
        workspaceId: schema.channels.workspaceId,
        projectId: schema.channels.projectId,
        slug: schema.channels.slug,
        name: schema.channels.name,
      })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.projectId, project.id),
          eq(schema.channels.status, 'active'),
          isNull(schema.channels.deletedAt),
        ),
      );
    const telegramChannel =
      channels.find((channel) => channel.slug === 'telegram' || channel.name === '텔레그램') ??
      null;

    const topics = await this.db
      .select({
        id: schema.topics.id,
        workspaceId: schema.topics.workspaceId,
        channelId: schema.topics.channelId,
        slug: schema.topics.slug,
        name: schema.topics.name,
        memoryTopicId: schema.topics.memoryTopicId,
      })
      .from(schema.topics)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .where(
        and(
          eq(schema.channels.projectId, project.id),
          eq(schema.topics.status, 'active'),
          isNull(schema.topics.deletedAt),
          isNull(schema.channels.deletedAt),
        ),
      );

    const threads = await this.db
      .select({
        id: schema.threads.id,
        workspaceId: schema.threads.workspaceId,
        topicId: schema.threads.topicId,
        title: schema.threads.title,
      })
      .from(schema.threads)
      .innerJoin(schema.topics, eq(schema.topics.id, schema.threads.topicId))
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .where(
        and(
          eq(schema.channels.projectId, project.id),
          eq(schema.threads.status, 'active'),
          isNull(schema.threads.deletedAt),
          isNull(schema.topics.deletedAt),
          isNull(schema.channels.deletedAt),
        ),
      );

    let links: TelegramTopicBackfillSnapshot['existingTelegramTopicLinks'] = [];
    const serviceWarnings: string[] = [];
    try {
      links = await this.db
        .select({
          workspaceId: schema.telegramTopicLinks.workspaceId,
          projectId: schema.telegramTopicLinks.projectId,
          channelId: schema.telegramTopicLinks.channelId,
          webTopicId: schema.telegramTopicLinks.webTopicId,
          threadId: schema.telegramTopicLinks.threadId,
          telegramChatId: schema.telegramTopicLinks.telegramChatId,
          telegramThreadId: schema.telegramTopicLinks.telegramThreadId,
          consultingTopicSlug: schema.telegramTopicLinks.consultingTopicSlug,
          memoryTopicId: schema.telegramTopicLinks.memoryTopicId,
          ancestorWorkspaceId: schema.workspaces.id,
          ancestorWorkspaceStatus: schema.workspaces.status,
          ancestorWorkspaceDeletedAt: schema.workspaces.deletedAt,
          ancestorProjectWorkspaceId: schema.projects.workspaceId,
          ancestorProjectStatus: schema.projects.status,
          ancestorProjectDeletedAt: schema.projects.deletedAt,
          ancestorChannelWorkspaceId: schema.channels.workspaceId,
          ancestorChannelProjectId: schema.channels.projectId,
          ancestorChannelStatus: schema.channels.status,
          ancestorChannelDeletedAt: schema.channels.deletedAt,
          ancestorTopicWorkspaceId: schema.topics.workspaceId,
          ancestorTopicChannelId: schema.topics.channelId,
          ancestorTopicSlug: schema.topics.slug,
          ancestorTopicMemoryTopicId: schema.topics.memoryTopicId,
          ancestorTopicStatus: schema.topics.status,
          ancestorTopicDeletedAt: schema.topics.deletedAt,
          ancestorThreadWorkspaceId: schema.threads.workspaceId,
          ancestorThreadTopicId: schema.threads.topicId,
          ancestorThreadTitle: schema.threads.title,
          ancestorThreadStatus: schema.threads.status,
          ancestorThreadDeletedAt: schema.threads.deletedAt,
        })
        .from(schema.telegramTopicLinks)
        .leftJoin(
          schema.workspaces,
          eq(schema.workspaces.id, schema.telegramTopicLinks.workspaceId),
        )
        .leftJoin(schema.projects, eq(schema.projects.id, schema.telegramTopicLinks.projectId))
        .leftJoin(schema.channels, eq(schema.channels.id, schema.telegramTopicLinks.channelId))
        .leftJoin(schema.topics, eq(schema.topics.id, schema.telegramTopicLinks.webTopicId))
        .leftJoin(schema.threads, eq(schema.threads.id, schema.telegramTopicLinks.threadId))
        .where(
          and(
            eq(schema.telegramTopicLinks.telegramChatId, CHANGWON_CHAT_ID),
            eq(schema.telegramTopicLinks.status, 'active'),
          ),
        );
    } catch (error) {
      if (isMissingRelationError(error, 'telegram_topic_links'))
        serviceWarnings.push('telegram_topic_links_table_missing');
      else throw error;
    }

    const malformedBindings: string[] = [];
    for (const link of links) {
      const registered = CHANGWON_TELEGRAM_TOPIC_REGISTRY.some(
        (entry) =>
          link.telegramChatId === entry.telegramChatId &&
          link.telegramThreadId === entry.telegramThreadId,
      );
      if (!registered)
        malformedBindings.push(`${link.telegramChatId}:${link.telegramThreadId ?? 'null'}`);
    }
    for (const entry of CHANGWON_TELEGRAM_TOPIC_REGISTRY) {
      const matchingLinks = links.filter(
        (link) =>
          link.telegramChatId === entry.telegramChatId &&
          link.telegramThreadId === entry.telegramThreadId,
      );
      const expectedTopic = telegramChannel
        ? topics.find(
            (topic) => topic.channelId === telegramChannel.id && topic.slug === entry.webTopicSlug,
          )
        : undefined;
      const expectedThread = expectedTopic
        ? threads.find(
            (thread) =>
              thread.topicId === expectedTopic.id && thread.title === entry.defaultThreadTitle,
          )
        : undefined;
      const expectedRowsValid =
        (!telegramChannel ||
          (telegramChannel.workspaceId === project.workspaceId &&
            telegramChannel.projectId === project.id)) &&
        (!expectedTopic ||
          (expectedTopic.workspaceId === project.workspaceId &&
            (expectedTopic.memoryTopicId === null ||
              expectedTopic.memoryTopicId === entry.memoryTopicId))) &&
        (!expectedThread || expectedThread.workspaceId === project.workspaceId);
      if (!expectedRowsValid) {
        malformedBindings.push(`${entry.telegramChatId}:${entry.telegramThreadId}`);
      }
      if (matchingLinks.length === 0) continue;
      const link = matchingLinks[0];
      if (
        matchingLinks.length !== 1 ||
        !link ||
        !telegramChannel ||
        !expectedTopic ||
        !expectedThread ||
        link.workspaceId !== project.workspaceId ||
        link.projectId !== project.id ||
        link.channelId !== telegramChannel.id ||
        link.webTopicId !== expectedTopic.id ||
        link.threadId !== expectedThread.id ||
        link.memoryTopicId !== entry.memoryTopicId ||
        link.consultingTopicSlug !== entry.consultingTopicSlug ||
        link.ancestorWorkspaceId !== project.workspaceId ||
        link.ancestorWorkspaceStatus !== 'active' ||
        link.ancestorWorkspaceDeletedAt !== null ||
        link.ancestorProjectWorkspaceId !== project.workspaceId ||
        link.ancestorProjectStatus !== 'active' ||
        link.ancestorProjectDeletedAt !== null ||
        link.ancestorChannelWorkspaceId !== project.workspaceId ||
        link.ancestorChannelProjectId !== project.id ||
        link.ancestorChannelStatus !== 'active' ||
        link.ancestorChannelDeletedAt !== null ||
        link.ancestorTopicWorkspaceId !== project.workspaceId ||
        link.ancestorTopicChannelId !== telegramChannel.id ||
        link.ancestorTopicSlug !== entry.webTopicSlug ||
        link.ancestorTopicMemoryTopicId !== entry.memoryTopicId ||
        link.ancestorTopicStatus !== 'active' ||
        link.ancestorTopicDeletedAt !== null ||
        link.ancestorThreadWorkspaceId !== project.workspaceId ||
        link.ancestorThreadTopicId !== expectedTopic.id ||
        link.ancestorThreadTitle !== entry.defaultThreadTitle ||
        link.ancestorThreadStatus !== 'active' ||
        link.ancestorThreadDeletedAt !== null
      ) {
        malformedBindings.push(`${entry.telegramChatId}:${entry.telegramThreadId}`);
      }
    }
    if (malformedBindings.length > 0) {
      return err(
        domainError(
          'CONFLICT',
          `telegram_topic_binding_scope_mismatch:${malformedBindings.sort().join(',')}`,
        ),
      );
    }

    let profiles: TelegramTopicBackfillSnapshot['existingTopicProfiles'] = [];
    try {
      profiles = await this.db
        .select({
          scopeType: schema.scopeProfiles.scopeType,
          scopeId: schema.scopeProfiles.scopeId,
          source: schema.scopeProfiles.source,
        })
        .from(schema.scopeProfiles)
        .where(
          and(
            eq(schema.scopeProfiles.workspaceId, project.workspaceId),
            eq(schema.scopeProfiles.scopeType, 'topic'),
            isNull(schema.scopeProfiles.deletedAt),
          ),
        );
    } catch (error) {
      if (isMissingRelationError(error, 'scope_profiles'))
        serviceWarnings.push('scope_profiles_table_missing');
      else throw error;
    }

    const messages = await this.db
      .select({ id: schema.chatMessages.id })
      .from(schema.chatMessages)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.chatMessages.threadId))
      .innerJoin(schema.topics, eq(schema.topics.id, schema.threads.topicId))
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .where(
        and(
          eq(schema.channels.projectId, project.id),
          isNull(schema.chatMessages.deletedAt),
          isNull(schema.threads.deletedAt),
          isNull(schema.topics.deletedAt),
          isNull(schema.channels.deletedAt),
        ),
      );

    return ok(
      buildTelegramTopicBackfillPlanFromSnapshot({
        workspaceId: project.workspaceId,
        projectId: project.id,
        projectName: project.name,
        telegramChannel,
        existingTopics: topics,
        existingThreads: threads,
        existingTelegramTopicLinks: links,
        existingTopicProfiles: profiles,
        before: { webMessages: messages.length, telegramChunks: before.telegramChunks ?? 0 },
        warnings: serviceWarnings,
      }),
    );
  }
}

function telegramBindingKey(chatId: string, threadId: string): string {
  return `${chatId}:${threadId}`;
}

function bindingKeySort(a: string, b: string): number {
  const [, threadA = ''] = a.split(':');
  const [, threadB = ''] = b.split(':');
  const nA = Number(threadA);
  const nB = Number(threadB);
  if (Number.isFinite(nA) && Number.isFinite(nB) && nA !== nB) return nA - nB;
  return a.localeCompare(b);
}

function bindingIssue(
  code: TelegramTopicBindingAuditIssueCode,
  severity: TelegramTopicBindingAuditIssue['severity'],
  key: string,
  detail: string,
  evidence: Record<string, unknown>,
): TelegramTopicBindingAuditIssue {
  return { code, severity, key, detail, evidence };
}

function issueSort(a: TelegramTopicBindingAuditIssue, b: TelegramTopicBindingAuditIssue): number {
  const keyCompare = bindingKeySort(a.key, b.key);
  if (keyCompare !== 0) return keyCompare;
  return a.code.localeCompare(b.code);
}

function isMissingRelationError(error: unknown, relationName: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; cause?: unknown; message?: unknown };
  const cause = record.cause as { code?: unknown; message?: unknown } | undefined;
  const message = `${typeof record.message === 'string' ? record.message : ''}\n${typeof cause?.message === 'string' ? cause.message : ''}`;
  return record.code === '42P01' || cause?.code === '42P01' || message.includes(relationName);
}
