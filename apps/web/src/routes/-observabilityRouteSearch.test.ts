import { describe, expect, it } from 'vitest';
import { parseObservabilitySearch } from './-observabilityRouteSearch';

describe('observability route search', () => {
  it('preserves a non-empty thread context', () => {
    expect(parseObservabilitySearch({ threadId: 'thread-1' })).toEqual({ threadId: 'thread-1' });
  });

  it.each([{ threadId: '' }, { threadId: 42 }, {}])('drops invalid thread context: %j', (search) => {
    expect(parseObservabilitySearch(search)).toEqual({});
  });
});
