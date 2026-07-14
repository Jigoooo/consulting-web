import { describe, expect, it } from 'vitest';
import { resolveAsyncCollectionState } from './asyncCollectionState';

describe('resolveAsyncCollectionState', () => {
  it('prioritizes visible cached or live items over background failures', () => {
    expect(resolveAsyncCollectionState({ isLoading: false, isError: true, itemCount: 2 })).toBe('ready');
  });

  it('never presents an initial request failure as an empty collection', () => {
    expect(resolveAsyncCollectionState({ isLoading: false, isError: true, itemCount: 0 })).toBe('error');
  });

  it('distinguishes loading, empty, and ready states', () => {
    expect(resolveAsyncCollectionState({ isLoading: true, isError: false, itemCount: 0 })).toBe('loading');
    expect(resolveAsyncCollectionState({ isLoading: false, isError: false, itemCount: 0 })).toBe('empty');
    expect(resolveAsyncCollectionState({ isLoading: false, isError: false, itemCount: 1 })).toBe('ready');
  });
});
