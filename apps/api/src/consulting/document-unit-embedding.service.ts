import { Inject, Injectable, Optional } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { sanitizeEmbeddingMetadata, type DocumentEmbeddingInput, type DocumentEmbeddingProvider, type DocumentUnitModality } from './document-embedding.provider.js';
import { LocalVisualHashProvider } from './local-visual-hash.provider.js';
import { VoyageMultimodalProvider } from './voyage-multimodal.provider.js';

export interface DocumentUnitForEmbedding {
  id: string;
  documentRef: string;
  modality: string;
  locator: string;
  textContent: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class DocumentUnitEmbeddingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(LocalVisualHashProvider) private readonly localProvider: DocumentEmbeddingProvider,
    @Optional() @Inject(VoyageMultimodalProvider) private readonly voyageProvider?: DocumentEmbeddingProvider,
  ) {}

  async embedAndPersistUnits(input: { workspaceId: string; units: DocumentUnitForEmbedding[] }): Promise<number> {
    if (input.units.length === 0) return 0;
    const rows = [];
    for (const unit of input.units) {
      const embeddingInput: DocumentEmbeddingInput = {
        documentUnitId: unit.id,
        documentRef: unit.documentRef,
        modality: isDocumentUnitModality(unit.modality) ? unit.modality : 'text',
        locator: unit.locator,
        textContent: unit.textContent,
        metadata: unit.metadata,
      };
      const primary = this.voyageProvider ? await this.voyageProvider.embed(embeddingInput) : null;
      const result = primary?.status === 'ok' ? primary : await this.localProvider.embed(embeddingInput);
      rows.push({
        workspaceId: input.workspaceId,
        documentUnitId: unit.id,
        provider: result.provider,
        model: result.model,
        embeddingDim: result.embeddingDim,
        inputSha256: result.inputSha256,
        status: result.status,
        fallbackReason: result.fallbackReason,
        embedding: result.embedding,
        metadata: sanitizeEmbeddingMetadata(unit.metadata),
      });
    }
    try {
      await this.db
        .insert(schema.documentUnitEmbeddings)
        .values(rows)
        .onConflictDoNothing({
          target: [schema.documentUnitEmbeddings.documentUnitId, schema.documentUnitEmbeddings.provider, schema.documentUnitEmbeddings.inputSha256],
        });
    } catch (error) {
      if (isMissingRelationError(error)) return 0;
      throw error;
    }
    return rows.length;
  }
}

function isDocumentUnitModality(value: string): value is DocumentUnitModality {
  return value === 'text' || value === 'table' || value === 'page_visual';
}

function isMissingRelationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  if (record.code === '42P01') return true;
  const message = typeof record.message === 'string' ? record.message : '';
  return /relation .*document_unit_embeddings.* does not exist|no such table: document_unit_embeddings/iu.test(message);
}
