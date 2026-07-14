/** Queue DI tokens + names, split out to avoid circular imports (module ↔ service). */
export const OUTBOX_RELAY_QUEUE = Symbol('OUTBOX_RELAY_QUEUE');
export const CONSULTING_WEB_INGEST_QUEUE = Symbol('CONSULTING_WEB_INGEST_QUEUE');
export const CHAT_TURN_SETTLEMENT_QUEUE = Symbol('CHAT_TURN_SETTLEMENT_QUEUE');
export const NOTIFICATION_PUSH_QUEUE = Symbol('NOTIFICATION_PUSH_QUEUE');
export const ARTIFACT_RED_TEAM_QUEUE = Symbol('ARTIFACT_RED_TEAM_QUEUE');
export const CONSULTING_INSIGHT_SHADOW_QUEUE = Symbol('CONSULTING_INSIGHT_SHADOW_QUEUE');
export const DOCUMENT_EXTRACTION_QUEUE = Symbol('DOCUMENT_EXTRACTION_QUEUE');

export const QUEUE_NAMES = {
  outboxRelay: 'outbox-relay',
  consultingWebIngest: 'consulting-web-ingest',
  chatTurnSettlement: 'chat-turn-settlement',
  notificationPush: 'notification-push',
  artifactRedTeam: 'artifact-red-team',
  consultingInsightShadow: 'consulting-insight-shadow',
  botInvocation: 'bot-invocation',
  hermesRun: 'hermes-run',
  artifactProcessing: 'artifact-processing',
  memoryRegistration: 'memory-registration',
  notification: 'notification',
  searchIndex: 'search-index',
  documentExtraction: 'document-extraction',
} as const;
