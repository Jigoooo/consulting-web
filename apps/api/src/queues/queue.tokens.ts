/** Queue DI tokens + names, split out to avoid circular imports (module ↔ service). */
export const OUTBOX_RELAY_QUEUE = Symbol('OUTBOX_RELAY_QUEUE');

export const QUEUE_NAMES = {
  outboxRelay: 'outbox-relay',
  botInvocation: 'bot-invocation',
  hermesRun: 'hermes-run',
  artifactProcessing: 'artifact-processing',
  memoryRegistration: 'memory-registration',
  notification: 'notification',
  searchIndex: 'search-index',
} as const;
