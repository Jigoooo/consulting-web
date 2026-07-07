import { describe, expect, it } from 'vitest';
import {
  appendDraftAttachment,
  canSubmitDraft,
  createDraftAttachment,
  draftAttachmentsForSend,
} from './draftAttachments';

const base = createDraftAttachment({
  id: '11111111-1111-4111-8111-111111111111',
  fileName: 'memo.txt',
  mimeType: 'text/plain',
  sizeBytes: 128,
  createdAt: '2026-07-07T00:00:00.000Z',
  uploaderUserId: '22222222-2222-4222-8222-222222222222',
});

describe('draft attachment helpers', () => {
  it('builds a chat-message-compatible draft attachment from a just-uploaded file', () => {
    expect(base).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      fileName: 'memo.txt',
      mimeType: 'text/plain',
      sizeBytes: 128,
      extraction: null,
      uploaderUserId: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-07-07T00:00:00.000Z',
    });
  });

  it('uses only current draft attachments for a normal send and none for retry/override sends', () => {
    expect(draftAttachmentsForSend([base])).toEqual([base]);
    expect(draftAttachmentsForSend([base], 'retry this answer')).toEqual([]);
  });

  it('lets an attachment-only draft submit but does not treat old thread attachments as draft input', () => {
    expect(canSubmitDraft('', [base])).toBe(true);
    expect(canSubmitDraft('   ', [])).toBe(false);
  });

  it('deduplicates draft attachments and enforces the stream limit', () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      createDraftAttachment({
        id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        fileName: `${index}.txt`,
        mimeType: 'text/plain',
        sizeBytes: index,
        createdAt: '2026-07-07T00:00:00.000Z',
      }),
    );
    expect(appendDraftAttachment(many, base)).toHaveLength(10);
    expect(appendDraftAttachment([base], { ...base, fileName: 'memo-v2.txt' })).toEqual([{ ...base, fileName: 'memo-v2.txt' }]);
  });
});
