import { Injectable } from '@nestjs/common';
import type { ConsultingGraphRagHit } from './consulting-graphrag-bridge.service.js';

export interface CitationCheckIssue {
  claim: string;
  citation?: string;
  reason: 'citation_not_retrieved' | 'citation_low_overlap' | 'missing_citation';
}

export interface CitationPostCheckResult {
  ok: boolean;
  supportedClaims: Array<{ claim: string; citation: string }>;
  citationMismatches: CitationCheckIssue[];
  unsupportedClaims: CitationCheckIssue[];
}

const STOP_TERMS = new Set(['검색된', '근거', '기준으로', '합니다', '됩니다', '있습니다', '없습니다', '이미']);
const FACTUAL_RE = /(이다|입니다|한다|합니다|된다|됩니다|있다|있습니다|없다|없습니다|필요|확정|증가|감소|부담|영향|제시|늘려)/u;
const CITATION_RE = /\b(?:claim:)?(CL-[A-Z0-9-]+)\b/gu;
const SUFFIX_RE = /(입니다|됩니다|합니다|했다|한다|하는|하다|에서|으로|부터|까지|에게|보다|처럼|이며|이고|이나|거나|과|와|을|를|은|는|이|가|의|에|도|만|로)$/u;

function sentences(answer: string): string[] {
  return answer
    // Keep a trailing citation attached to the factual sentence it supports.
    .replace(/\.\s+(\[(?:claim:)?CL-[A-Z0-9-]+\])/gu, ' $1.')
    .split(/(?<=[.!?。]|[.?!]|다\.)\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

function citations(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const citation = match[1];
    if (citation && !out.includes(citation)) out.push(citation);
  }
  return out;
}

function terms(text: string): string[] {
  const cleaned = text.replace(CITATION_RE, ' ');
  const out: string[] = [];
  for (const raw of cleaned.match(/[가-힣A-Za-z0-9]{2,}/gu) ?? []) {
    const term = raw.replace(SUFFIX_RE, '');
    if (term.length < 2 || STOP_TERMS.has(term) || out.includes(term)) continue;
    out.push(term);
  }
  return out;
}

function citationEvidence(citation: string, evidence: ConsultingGraphRagHit[]): ConsultingGraphRagHit[] {
  return evidence.filter((hit) => hit.linked.includes(`claim:${citation}`) || hit.text.includes(citation));
}

@Injectable()
export class CitationPostCheckService {
  verify(input: { answer: string; evidence: ConsultingGraphRagHit[] }): CitationPostCheckResult {
    const supportedClaims: Array<{ claim: string; citation: string }> = [];
    const citationMismatches: CitationCheckIssue[] = [];
    const unsupportedClaims: CitationCheckIssue[] = [];

    for (const sentence of sentences(input.answer)) {
      const cited = citations(sentence);
      const claimTerms = terms(sentence);
      if (cited.length === 0) {
        if (FACTUAL_RE.test(sentence) && claimTerms.length > 0) {
          unsupportedClaims.push({ claim: sentence, reason: 'missing_citation' });
        }
        continue;
      }

      for (const citation of cited) {
        const supporting = citationEvidence(citation, input.evidence);
        if (supporting.length === 0) {
          citationMismatches.push({ claim: sentence, citation, reason: 'citation_not_retrieved' });
          continue;
        }
        const evidenceText = supporting.map((hit) => hit.text).join(' ');
        const overlap = claimTerms.filter((term) => evidenceText.includes(term));
        if (claimTerms.length > 0 && overlap.length < Math.min(2, claimTerms.length)) {
          citationMismatches.push({ claim: sentence, citation, reason: 'citation_low_overlap' });
          continue;
        }
        supportedClaims.push({ claim: sentence, citation });
      }
    }

    return {
      ok: citationMismatches.length === 0 && unsupportedClaims.length === 0,
      supportedClaims,
      citationMismatches,
      unsupportedClaims,
    };
  }
}
