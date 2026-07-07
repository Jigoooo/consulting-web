import { Injectable } from '@nestjs/common';
import { cosineSimilarity } from './document-embedding.provider.js';
import { LocalVisualHashProvider } from './local-visual-hash.provider.js';

export interface VisualRankInput {
  id: string;
  scorePrior: number;
  textContent: string;
  embedding?: number[] | null;
  modality: string;
}

export interface VisualRankedUnit extends VisualRankInput {
  score: number;
  vectorScore: number;
  lexicalScore: number;
}

@Injectable()
export class VisualDocumentSearchService {
  constructor(private readonly queryProvider: LocalVisualHashProvider) {}

  async rankStoredUnits(query: string, rows: VisualRankInput[]): Promise<VisualRankedUnit[]> {
    const queryEmbedding = (await this.queryProvider.embed({
      documentUnitId: 'query',
      documentRef: 'query',
      modality: 'text',
      locator: 'query',
      textContent: query,
      metadata: { kind: 'query' },
    })).embedding;
    return this.rankUnits(query, rows, queryEmbedding);
  }

  rankUnits(query: string, rows: VisualRankInput[], queryEmbedding: number[]): VisualRankedUnit[] {
    const q = query.trim().toLocaleLowerCase();
    return rows
      .map((row) => {
        const vectorScore = row.embedding && row.embedding.length > 0 ? cosineSimilarity(queryEmbedding, row.embedding) : 0;
        const lexicalScore = q && row.textContent.toLocaleLowerCase().includes(q) ? 1 : 0;
        const modalityBoost = row.modality === 'page_visual' && vectorScore > 0 ? 0.03 : 0;
        const score = round4(row.scorePrior * 0.25 + lexicalScore * 0.2 + vectorScore * 0.55 + modalityBoost);
        return { ...row, score, vectorScore: round4(vectorScore), lexicalScore };
      })
      .sort((a, b) => b.score - a.score || b.scorePrior - a.scorePrior || a.id.localeCompare(b.id));
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
