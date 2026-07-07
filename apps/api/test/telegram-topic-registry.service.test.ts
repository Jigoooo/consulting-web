import { describe, expect, it } from 'vitest';
import {
  CHANGWON_TELEGRAM_TOPIC_REGISTRY,
  buildTelegramTopicBackfillPlanFromSnapshot,
} from '../src/consulting/telegram-topic-registry.service.js';

describe('TelegramTopicRegistryService dry-run planner', () => {
  it('covers the Changwon Telegram forum threads with exact chat/thread bindings', () => {
    expect(CHANGWON_TELEGRAM_TOPIC_REGISTRY.map((item) => item.telegramThreadId)).toEqual(['12', '524', '533', '356', '1']);
    expect(CHANGWON_TELEGRAM_TOPIC_REGISTRY.map((item) => `${item.telegramChatId}:${item.telegramThreadId}`)).toEqual([
      '-1004453868195:12',
      '-1004453868195:524',
      '-1004453868195:533',
      '-1004453868195:356',
      '-1004453868195:1',
    ]);
    expect(CHANGWON_TELEGRAM_TOPIC_REGISTRY.find((item) => item.telegramThreadId === '524')?.profile.rules).toContain('보수');
    expect(CHANGWON_TELEGRAM_TOPIC_REGISTRY.find((item) => item.telegramThreadId === '533')?.profile.rules).toContain('근속승진');
    expect(CHANGWON_TELEGRAM_TOPIC_REGISTRY.find((item) => item.telegramThreadId === '356')?.profile.rules).toContain('대행사업');
    expect(CHANGWON_TELEGRAM_TOPIC_REGISTRY.find((item) => item.telegramThreadId === '1')?.reviewRequired).toBe(true);
  });

  it('builds a read-only backfill plan without relying on NULL thread bindings', () => {
    const plan = buildTelegramTopicBackfillPlanFromSnapshot({
      projectId: 'project-1',
      projectName: '창원시 컨설팅',
      workspaceId: 'workspace-1',
      telegramChannel: { id: 'channel-telegram', slug: 'telegram', name: '텔레그램' },
      existingTopics: [
        { id: 'topic-existing', channelId: 'channel-telegram', slug: 'changwon-consulting', name: '창원-컨설팅', memoryTopicId: 'consulting:changwon-org-mgmt-diagnosis#telegram/changwon-consulting' },
      ],
      existingThreads: [
        { id: 'thread-existing', topicId: 'topic-existing', title: '창원-컨설팅' },
      ],
      existingTelegramTopicLinks: [
        { telegramChatId: '-1004453868195', telegramThreadId: '12', memoryTopicId: 'consulting:changwon-org-mgmt-diagnosis#telegram/changwon-consulting' },
      ],
      existingTopicProfiles: [{ scopeType: 'topic', scopeId: 'topic-existing', source: 'manual' }],
      before: { webMessages: 249, telegramChunks: 112 },
    });

    expect(plan.readOnly).toBe(true);
    expect(plan.before).toEqual({ webMessages: 249, telegramChunks: 112 });
    expect(plan.plannedCreates).toEqual({ channels: 0, topics: 4, threads: 4, telegramTopicLinks: 4, topicProfiles: 4 });
    expect(plan.exactBindingKeys).toEqual([
      '-1004453868195:12',
      '-1004453868195:524',
      '-1004453868195:533',
      '-1004453868195:356',
      '-1004453868195:1',
    ]);
    expect(plan.warnings).toContain('thread_1_review_required');
    expect(plan.warnings).not.toContain('would_create_null_thread_binding');
  });
});
