import { Inject, Injectable } from '@nestjs/common';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { SECRET_PROVIDER, type SecretProviderPort } from '../secrets/secret-provider.port.js';
import { inputSha256, type DocumentEmbeddingInput, type DocumentEmbeddingProvider, type DocumentEmbeddingResult } from './document-embedding.provider.js';

interface VoyageEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

@Injectable()
export class VoyageMultimodalProvider implements DocumentEmbeddingProvider {
  readonly providerId = 'voyage_multimodal';

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(SECRET_PROVIDER) private readonly secrets: Pick<SecretProviderPort, 'get'>,
  ) {}

  get model(): string {
    return this.env.VOYAGE_MULTIMODAL_MODEL ?? 'voyage-multimodal-3.5';
  }

  async embed(input: DocumentEmbeddingInput): Promise<DocumentEmbeddingResult> {
    const key = this.secrets.get('VOYAGE_API_KEY');
    if (!this.env.VOYAGE_MULTIMODAL_ENABLED || !key) return this.disabled(input, 'voyage disabled or missing key');

    try {
      const response = await fetch(`${(this.env.VOYAGE_API_BASE_URL ?? 'https://api.voyageai.com').replace(/\/$/u, '')}/v1/multimodalembeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          inputs: [{ content: [{ type: 'text', text: `${input.documentRef}\n${input.locator}\n${input.textContent}`.slice(0, 20_000) }] }],
          truncation: true,
        }),
      });
      if (!response.ok) return this.disabled(input, `voyage_http_${response.status}`);
      const data = await response.json() as VoyageEmbeddingResponse;
      const embedding = data.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) return this.disabled(input, 'voyage_empty_embedding');
      return {
        provider: this.providerId,
        model: this.model,
        embedding,
        embeddingDim: embedding.length,
        inputSha256: inputSha256(input),
        status: 'ok',
        fallbackReason: null,
      };
    } catch {
      return this.disabled(input, 'voyage_request_failed');
    }
  }

  private disabled(input: DocumentEmbeddingInput, reason: string): DocumentEmbeddingResult {
    return {
      provider: this.providerId,
      model: this.model,
      embedding: [],
      embeddingDim: 0,
      inputSha256: inputSha256(input),
      status: 'disabled',
      fallbackReason: reason,
    };
  }
}
