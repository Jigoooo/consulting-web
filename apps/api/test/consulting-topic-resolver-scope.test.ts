import { describe, expect, it } from 'vitest';
import { normalizeConsultingRecallRelation } from '../src/consulting/consulting-topic-resolver.service.js';

describe('consulting topic resolver scope isolation', () => {
  it('preserves same-project relations as cross-scope instead of promoting them to current', () => {
    expect(normalizeConsultingRecallRelation('same_project')).toBe('same_project');
    expect(normalizeConsultingRecallRelation('cross_project')).toBe('cross_project');
  });
});
