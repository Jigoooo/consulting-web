import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { inputSha256, normaliseVector, stableEmbeddingPayload, type DocumentEmbeddingInput, type DocumentEmbeddingProvider, type DocumentEmbeddingResult } from './document-embedding.provider.js';

@Injectable()
export class LocalVisualHashProvider implements DocumentEmbeddingProvider {
  readonly providerId = 'local_visual_hash_v1';
  readonly model = 'sha256-32d';

  embed(input: DocumentEmbeddingInput): Promise<DocumentEmbeddingResult> {
    const digest = createHash('sha256').update(stableEmbeddingPayload(input)).digest();
    const embedding = normaliseVector(Array.from(digest).map((byte) => (byte / 255) * 2 - 1));
    return Promise.resolve({
      provider: this.providerId,
      model: this.model,
      embedding,
      embeddingDim: embedding.length,
      inputSha256: inputSha256(input),
      status: 'fallback',
      fallbackReason: 'local_hash_provider',
    });
  }
}
