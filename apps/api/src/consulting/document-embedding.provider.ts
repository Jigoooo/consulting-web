import { createHash } from 'node:crypto';

export type DocumentUnitModality = 'text' | 'table' | 'page_visual';
export type DocumentEmbeddingStatus = 'ok' | 'fallback' | 'disabled' | 'failed';

export interface DocumentEmbeddingInput {
  documentUnitId: string;
  documentRef: string;
  modality: DocumentUnitModality;
  locator: string;
  textContent: string;
  metadata: Record<string, unknown>;
}

export interface DocumentEmbeddingResult {
  provider: string;
  model: string;
  embedding: number[];
  embeddingDim: number;
  inputSha256: string;
  status: DocumentEmbeddingStatus;
  fallbackReason: string | null;
}

export interface DocumentEmbeddingProvider {
  readonly providerId: string;
  readonly model: string;
  embed(input: DocumentEmbeddingInput): Promise<DocumentEmbeddingResult>;
}

export function stableEmbeddingPayload(input: DocumentEmbeddingInput): string {
  return JSON.stringify({
    documentRef: input.documentRef,
    modality: input.modality,
    locator: input.locator,
    textContent: input.textContent.slice(0, 20_000),
    metadata: sanitizeEmbeddingMetadata(input.metadata),
  });
}

export function inputSha256(input: DocumentEmbeddingInput): string {
  return createHash('sha256').update(stableEmbeddingPayload(input)).digest('hex');
}

export function sanitizeEmbeddingMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/base64|bytes|binary|buffer|raw/iu.test(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
  }
  return out;
}

export function normaliseVector(values: number[]): number[] {
  return values.map((value) => Math.round(Math.max(-1, Math.min(1, value)) * 10_000) / 10_000);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aa += av * av;
    bb += bv * bv;
  }
  if (aa <= 0 || bb <= 0) return 0;
  return Math.max(0, dot / Math.sqrt(aa * bb));
}
