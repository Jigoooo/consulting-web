/** Queue DI tokens + names, split out to avoid circular imports (module ↔ service). */
export const OUTBOX_RELAY_QUEUE = Symbol('OUTBOX_RELAY_QUEUE');
export const CONSULTING_WEB_INGEST_QUEUE = Symbol('CONSULTING_WEB_INGEST_QUEUE');
export const DOCUMENT_EXTRACTION_QUEUE = Symbol('DOCUMENT_EXTRACTION_QUEUE');

export const QUEUE_NAMES = {
  outboxRelay: 'outbox-relay',
  consultingWebIngest: 'consulting-web-ingest',
  botInvocation: 'bot-invocation',
  hermesRun: 'hermes-run',
  artifactProcessing: 'artifact-processing',
  memoryRegistration: 'memory-registration',
  notification: 'notification',
  searchIndex: 'search-index',
  documentExtraction: 'document-extraction',
} as const;
