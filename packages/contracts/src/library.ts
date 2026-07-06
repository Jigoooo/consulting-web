import { z } from 'zod';

const UuidSchema = z.string().uuid();

/**
 * 자료실(축4) — 워크스페이스/프로젝트 단위로 evidence·업로드문서·산출물을
 * 통합 집계해 보여주는 라이브러리. thread에 갇힌 자료를 한곳에서 조회·다운로드.
 */
export const LibrarySourceKindSchema = z.enum(['evidence', 'attachment', 'artifact']);
export type LibrarySourceKind = z.infer<typeof LibrarySourceKindSchema>;

/** 목록 필터의 종류 — kind + evidence 세부 소스(gbrain/web/…)를 함께 노출. */
export const LibrarySourceTypeSchema = z.enum([
  'gbrain', 'web', 'file', 'tool', 'manual', 'document', 'artifact',
]);
export type LibrarySourceType = z.infer<typeof LibrarySourceTypeSchema>;

export const LibrarySourceItemSchema = z
  .object({
    kind: LibrarySourceKindSchema,
    /** kind별 원본 id (evidence_items.id / file_attachments.id / artifacts.id). */
    id: UuidSchema,
    title: z.string(),
    sourceType: LibrarySourceTypeSchema,
    projectId: UuidSchema.nullable(),
    channelName: z.string().nullable(),
    threadId: UuidSchema.nullable(),
    /** 미리보기 스니펫(발췌/추출 앞부분). 대용량 컬럼은 목록에서 제외. */
    snippet: z.string(),
    url: z.string().nullable(),
    mimeType: z.string().nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    /** 답변 딥링크용(evidence만). */
    messageId: UuidSchema.nullable(),
    /** 추출/추가 실패 투명성 — 실패면 배지. */
    status: z.string().nullable(),
    qualityScore: z.number().int().min(0).max(100).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type LibrarySourceItem = z.infer<typeof LibrarySourceItemSchema>;

export const ListLibrarySourcesResponseSchema = z
  .object({
    sources: z.array(LibrarySourceItemSchema),
    /** 커서 페이지네이션 — 다음 페이지 없으면 null. */
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ListLibrarySourcesResponse = z.infer<typeof ListLibrarySourcesResponseSchema>;
