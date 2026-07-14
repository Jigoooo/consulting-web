export type ConsultingInsightIntentDecision = 'analysis' | 'factual' | 'ambiguous';

export interface ConsultingInsightIntentRoute {
  decision: ConsultingInsightIntentDecision;
  confidence: number;
  reasons: string[];
}

const FACTUAL_PATTERNS = [
  /얼마(야|인가|인지)/iu,
  /몇\s*(명|건|개|원|%)/iu,
  /(페이지|쪽|조문|표|행|열).*(찾|보여|확인)/iu,
  /(그대로|단순).*(요약|정리)/iu,
  /(PPTX|파일).*(만들|생성)/iu,
] as const;

const ANALYSIS_PATTERNS = [
  /(왜|원인|메커니즘|작동\s*원리)/iu,
  /(의사결정|정책|선택|순서|임계값).*(달라|변수|영향)/iu,
  /(반사실|counterfactual|2차\s*효과|연쇄\s*효과)/iu,
  /(깊게|심층|비자명|뻔한\s*말\s*말고|기관\s*고유).*(분석|인사이트|찾|봐)/iu,
  /(어떤\s*의미|시사점).*(메커니즘|결정|정책)/iu,
] as const;

export function routeConsultingInsightIntent(text: string): ConsultingInsightIntentRoute {
  const normalized = text.trim().split(/\s+/u).filter(Boolean).join(' ');
  if (!normalized) return { decision: 'ambiguous', confidence: 0, reasons: ['empty'] };
  const factual = FACTUAL_PATTERNS.filter((pattern) => pattern.test(normalized));
  const analysis = ANALYSIS_PATTERNS.filter((pattern) => pattern.test(normalized));
  if (factual.length > 0 && analysis.length === 0) {
    return { decision: 'factual', confidence: Math.min(0.99, 0.82 + 0.04 * factual.length), reasons: factual.map(String) };
  }
  if (analysis.length > 0 && factual.length === 0) {
    return { decision: 'analysis', confidence: Math.min(0.99, 0.78 + 0.05 * analysis.length), reasons: analysis.map(String) };
  }
  if (analysis.length > 0 && factual.length > 0) {
    return { decision: 'ambiguous', confidence: 0.58, reasons: ['mixed_analysis_factual'] };
  }
  if (normalized.length <= 12 || normalized.endsWith('봐줘') || normalized.endsWith('해줘')) {
    return { decision: 'ambiguous', confidence: 0.35, reasons: ['underspecified'] };
  }
  return { decision: 'factual', confidence: 0.62, reasons: ['no_analysis_signal'] };
}
