import { beforeEach, describe, expect, it } from 'vitest';
import { clearComposerDraftsForTests, readComposerDraft, writeComposerDraft } from './composerDraftStore';

describe('composerDraftStore', () => {
  beforeEach(() => clearComposerDraftsForTests());

  it('keeps drafts isolated by thread while navigating between channels', () => {
    writeComposerDraft('thread-a', 'A의 미전송 초안');
    writeComposerDraft('thread-b', 'B의 미전송 초안');
    expect(readComposerDraft('thread-a')).toBe('A의 미전송 초안');
    expect(readComposerDraft('thread-b')).toBe('B의 미전송 초안');
  });

  it('removes a draft after send or explicit clear', () => {
    writeComposerDraft('thread-a', '전송할 내용');
    writeComposerDraft('thread-a', '');
    expect(readComposerDraft('thread-a')).toBe('');
  });
});
