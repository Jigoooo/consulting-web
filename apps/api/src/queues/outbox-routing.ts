export const CONSULTING_WEB_TURN_COMPLETED_EVENT = 'ConsultingWebTurnCompleted';

export const GENERIC_AUDIT_OUTBOX_EVENTS = [
  'WorkspaceCreated',
  'ChannelCreated',
  'TopicCreated',
  'ThreadCreated',
] as const;

const genericAuditEvents = new Set<string>(GENERIC_AUDIT_OUTBOX_EVENTS);

export type OutboxQueueRoute = 'generic-audit' | 'consulting-web-ingest';

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
  if (isGenericAuditOutboxEvent(eventType)) return 'generic-audit';
  throw new UnsupportedOutboxEventError(eventType);
}
