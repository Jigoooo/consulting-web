export interface ObservabilitySearch {
  threadId?: string;
}

export function parseObservabilitySearch(search: Record<string, unknown>): ObservabilitySearch {
  return typeof search.threadId === 'string' && search.threadId.length > 0
    ? { threadId: search.threadId }
    : {};
}
