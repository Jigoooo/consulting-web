import { describe, expect, it } from 'vitest';
import { routeConsultingInsightIntent } from '../src/consulting/consulting-insight-intent.js';

describe('routeConsultingInsightIntent shared-core parity', () => {
  it.each([
    ['몇 명인가', 'factual', 0.86],
    ['왜 이런 구조가 발생했는가', 'analysis', 0.83],
    ['왜 몇 명인지 확인해야 하는가', 'ambiguous', 0.58],
    ['분석해줘', 'ambiguous', 0.35],
    ['현재 조직 현황과 개선 방향을 정리해 주세요', 'factual', 0.62],
    ['', 'ambiguous', 0],
  ] as const)('%s -> %s', (text, decision, confidence) => {
    const actual = routeConsultingInsightIntent(text);
    expect(actual.decision).toBe(decision);
    expect(actual.confidence).toBeCloseTo(confidence, 8);
  });
});
