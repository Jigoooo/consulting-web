const draftsByThread = new Map<string, string>();

export function readComposerDraft(threadId: string): string {
  return draftsByThread.get(threadId) ?? '';
}

export function writeComposerDraft(threadId: string, value: string): void {
  if (value) draftsByThread.set(threadId, value);
  else draftsByThread.delete(threadId);
}

export function clearComposerDrafts(): void {
  draftsByThread.clear();
}

/** Backward-compatible test helper. Runtime uses clearComposerDrafts directly. */
export const clearComposerDraftsForTests = clearComposerDrafts;
