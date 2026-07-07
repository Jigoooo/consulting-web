import { Injectable } from '@nestjs/common';
import type { ConsultingGraphRagHit } from './consulting-graphrag-bridge.service.js';

export type EvidenceSufficiencyStatus = 'sufficient' | 'ambiguous' | 'insufficient';
export type EvidenceSufficiencyAction = 'answer_with_citations' | 'answer_with_scope_label_or_ask' | 'refuse_or_request_evidence';

export interface EvidenceSufficiencyDecision {
  status: EvidenceSufficiencyStatus;
  reason: string;
  requiredAction: EvidenceSufficiencyAction;
  matchedTerms: string[];
}

const STOP_TERMS = new Set(['관련', '근거', '판단', '기준', '핵심', '이슈', '알려줘', '대한', '기존', '자료']);
const SUFFIX_RE = /(입니다|이었다|했다|한다|하는|하다|에서|으로|부터|까지|에게|보다|처럼|이며|이고|이나|거나|과|와|을|를|은|는|이|가|의|에|도|만|로)$/u;

function normalizeTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[가-힣A-Za-z0-9]{2,}/gu) ?? []) {
    const term = raw.replace(SUFFIX_RE, '');
    if (term.length < 2 || STOP_TERMS.has(term) || out.includes(term)) continue;
    out.push(term);
  }
  return out;
}

function signalStrength(hit: ConsultingGraphRagHit): number {
  const breakdown = hit.signalBreakdown;
  if (!breakdown) return 0;
  let strength = 0;
  for (const detail of Object.values(breakdown)) {
    if (!detail || typeof detail !== 'object') continue;
    const rrf = (detail as { rrf?: unknown }).rrf;
    const rank = (detail as { rank?: unknown }).rank;
    if (typeof rank === 'number') strength += rank <= 3 ? 2 : 1;
    if (typeof rrf === 'number' && rrf > 0) strength += 1;
  }
  return strength;
}

@Injectable()
export class EvidenceSufficiencyEvaluator {
  evaluate(input: { query: string; hits: ConsultingGraphRagHit[] }): EvidenceSufficiencyDecision {
    const queryTerms = normalizeTerms(input.query).slice(0, 8);
    if (input.hits.length === 0) {
      return {
        status: 'insufficient',
        reason: 'no_retrieved_context',
        requiredAction: 'refuse_or_request_evidence',
        matchedTerms: [],
      };
    }

    const joinedCurrent = input.hits
      .filter((hit) => hit.sourceRelation !== 'cross_project')
      .map((hit) => hit.text)
      .join(' ');
    const joinedAll = input.hits.map((hit) => hit.text).join(' ');
    const currentMatches = queryTerms.filter((term) => joinedCurrent.includes(term));
    const allMatches = queryTerms.filter((term) => joinedAll.includes(term));
    const linkedClaims = input.hits.filter((hit) => hit.linked.some((link) => link.startsWith('claim:'))).length;
    const strongSignals = input.hits.reduce((sum, hit) => sum + signalStrength(hit), 0);
    const onlyCrossProject = input.hits.every((hit) => hit.sourceRelation === 'cross_project');

    if (allMatches.length < Math.min(2, queryTerms.length || 2)) {
      return {
        status: 'insufficient',
        reason: `low_overlap:${allMatches.length}/${queryTerms.length}`,
        requiredAction: 'refuse_or_request_evidence',
        matchedTerms: allMatches,
      };
    }

    if (onlyCrossProject || (currentMatches.length === 0 && allMatches.length > 0)) {
      return {
        status: 'ambiguous',
        reason: `cross_project_only; query_terms=${allMatches.join(',')}`,
        requiredAction: 'answer_with_scope_label_or_ask',
        matchedTerms: allMatches,
      };
    }

    if (linkedClaims > 0 && strongSignals > 0) {
      return {
        status: 'sufficient',
        reason: `query_terms=${currentMatches.join(',')}; linked_claims=${linkedClaims}; signal_strength=${strongSignals}`,
        requiredAction: 'answer_with_citations',
        matchedTerms: currentMatches,
      };
    }

    return {
      status: 'ambiguous',
      reason: `partial_overlap:${allMatches.length}/${queryTerms.length}; linked_claims=${linkedClaims}; signal_strength=${strongSignals}`,
      requiredAction: 'answer_with_scope_label_or_ask',
      matchedTerms: allMatches,
    };
  }
}
