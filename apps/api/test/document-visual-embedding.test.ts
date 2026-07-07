import { describe, expect, it, vi } from 'vitest';
import { DocumentUnitEmbeddingService } from '../src/consulting/document-unit-embedding.service.js';
import { LocalVisualHashProvider } from '../src/consulting/local-visual-hash.provider.js';
import { VisualDocumentSearchService } from '../src/consulting/visual-document-search.service.js';
import { VoyageMultimodalProvider } from '../src/consulting/voyage-multimodal.provider.js';

function makeDb() {
  const inserted: unknown[] = [];
  const values = vi.fn((rows: unknown) => {
    if (Array.isArray(rows)) inserted.push(...rows);
    else inserted.push(rows);
    return { onConflictDoNothing: vi.fn(async () => []) };
  });
  return {
    inserted,
    insert: vi.fn(() => ({ values })),
  };
}

describe('document visual embeddings', () => {
  it('creates deterministic local multimodal fallback vectors without leaking image bytes', async () => {
    const provider = new LocalVisualHashProvider();
    const input = {
      documentUnitId: 'unit-1',
      documentRef: '창원-예산표.pdf',
      modality: 'page_visual' as const,
      locator: '창원-예산표.pdf#page-1',
      textContent: 'visual-page: 창원-예산표 page 1',
      metadata: { imageSha256: 'abc123', imageBytes: 2048, imageBase64: 'MUST_NOT_PERSIST' },
    };

    const a = await provider.embed(input);
    const b = await provider.embed(input);

    expect(a.provider).toBe('local_visual_hash_v1');
    expect(a.status).toBe('fallback');
    expect(a.embedding).toEqual(b.embedding);
    expect(a.embedding).toHaveLength(32);
    expect(JSON.stringify(a)).not.toContain('MUST_NOT_PERSIST');
  });

  it('persists one embedding ledger row per document retrieval unit', async () => {
    const db = makeDb();
    const service = new DocumentUnitEmbeddingService(db as never, new LocalVisualHashProvider());

    const count = await service.embedAndPersistUnits({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      units: [{
        id: '22222222-2222-4222-8222-222222222222',
        documentRef: '창원-예산표.pdf',
        modality: 'page_visual',
        locator: '창원-예산표.pdf#page-1',
        textContent: 'visual-page: 창원-예산표 page 1',
        metadata: { imageSha256: 'abc123', imageBytes: 2048 },
      }],
    });

    expect(count).toBe(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.inserted[0]).toMatchObject({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      documentUnitId: '22222222-2222-4222-8222-222222222222',
      provider: 'local_visual_hash_v1',
      status: 'fallback',
      embeddingDim: 32,
    });
    expect(JSON.stringify(db.inserted[0])).not.toContain('imageBytes');
  });

  it('uses vector similarity to lift visually relevant document units above plain lexical prior', () => {
    const search = new VisualDocumentSearchService(new LocalVisualHashProvider());
    const ranked = search.rankUnits('조직도', [
      { id: 'lexical', scorePrior: 0.9, textContent: '조직도라는 단어만 있는 일반 텍스트', embedding: [0, 1], modality: 'text' },
      { id: 'visual', scorePrior: 0.4, textContent: '도표 이미지 페이지', embedding: [1, 0], modality: 'page_visual' },
    ], [1, 0]);

    expect(ranked[0]?.id).toBe('visual');
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it('keeps Voyage disabled when the feature flag or key is absent', async () => {
    const provider = new VoyageMultimodalProvider({ VOYAGE_MULTIMODAL_ENABLED: false, VOYAGE_MULTIMODAL_MODEL: 'voyage-multimodal-3.5' } as never, { get: vi.fn(() => '') });
    const result = await provider.embed({
      documentUnitId: 'unit-1',
      documentRef: 'x.pdf',
      modality: 'page_visual',
      locator: 'x.pdf#page-1',
      textContent: 'visual page',
      metadata: {},
    });

    expect(result.status).toBe('disabled');
    expect(result.embedding).toEqual([]);
    expect(result.fallbackReason).toMatch(/disabled|missing/i);
  });
});
