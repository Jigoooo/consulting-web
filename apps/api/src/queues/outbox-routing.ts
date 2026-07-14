export const CONSULTING_WEB_TURN_COMPLETED_EVENT = 'ConsultingWebTurnCompleted';
export const CHAT_TURN_SETTLEMENT_REQUESTED_EVENT = 'ChatTurnSettlementRequested';
export const NOTIFICATION_PUSH_REQUESTED_EVENT = 'NotificationPushRequested';
export const ARTIFACT_RED_TEAM_REVIEW_REQUESTED_EVENT = 'ArtifactRedTeamReviewRequested';
export const CONSULTING_INSIGHT_SHADOW_REQUESTED_EVENT = 'ConsultingInsightShadowRequested';

export const GENERIC_AUDIT_OUTBOX_EVENTS = [
  'WorkspaceCreated',
  'ChannelCreated',
  'TopicCreated',
  'ThreadCreated',
] as const;

const genericAuditEvents = new Set<string>(GENERIC_AUDIT_OUTBOX_EVENTS);

export type OutboxQueueRoute = 'generic-audit' | 'consulting-web-ingest' | 'chat-turn-settlement' | 'notification-push' | 'artifact-red-team' | 'consulting-insight-shadow';

export class UnsupportedOutboxEventError extends Error {
  constructor(readonly eventType: string) {
    super(`unsupported outbox event type: ${eventType}`);
    this.name = 'UnsupportedOutboxEventError';
  }
}

export function isGenericAuditOutboxEvent(eventType: string): boolean {
  return genericAuditEvents.has(eventType);
}

export function routeOutboxEvent(eventType: string): OutboxQueueRoute {
  if (eventType === CONSULTING_WEB_TURN_COMPLETED_EVENT) return 'consulting-web-ingest';
  if (eventType === CHAT_TURN_SETTLEMENT_REQUESTED_EVENT) return 'chat-turn-settlement';
  if (eventType === NOTIFICATION_PUSH_REQUESTED_EVENT) return 'notification-push';
  if (eventType === ARTIFACT_RED_TEAM_REVIEW_REQUESTED_EVENT) return 'artifact-red-team';
  if (eventType === CONSULTING_INSIGHT_SHADOW_REQUESTED_EVENT) return 'consulting-insight-shadow';
  if (isGenericAuditOutboxEvent(eventType)) return 'generic-audit';
  throw new UnsupportedOutboxEventError(eventType);
}
