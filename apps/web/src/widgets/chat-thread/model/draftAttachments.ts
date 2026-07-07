import type { ChatMessageAttachment } from '@consulting/contracts';

export interface DraftAttachmentInput {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt?: string;
  uploaderUserId?: string | null;
}

export function createDraftAttachment(input: DraftAttachmentInput): ChatMessageAttachment {
  return {
    id: input.id,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    extraction: null,
    uploaderUserId: input.uploaderUserId ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function appendDraftAttachment(
  current: readonly ChatMessageAttachment[],
  next: ChatMessageAttachment,
  maxAttachments = 10,
): ChatMessageAttachment[] {
  const withoutDuplicate = current.filter((item) => item.id !== next.id);
  if (withoutDuplicate.length >= maxAttachments) return [...withoutDuplicate.slice(0, maxAttachments)];
  return [...withoutDuplicate, next];
}

export function draftAttachmentsForSend(
  draftAttachments: readonly ChatMessageAttachment[],
  messageOverride?: string,
): ChatMessageAttachment[] {
  return messageOverride ? [] : [...draftAttachments];
}

export function canSubmitDraft(message: string, draftAttachments: readonly ChatMessageAttachment[]): boolean {
  return message.trim().length > 0 || draftAttachments.length > 0;
}
