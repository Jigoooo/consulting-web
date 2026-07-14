export type AsyncCollectionState = 'loading' | 'error' | 'empty' | 'ready';

export function resolveAsyncCollectionState({
  isLoading,
  isError,
  itemCount,
}: {
  isLoading: boolean;
  isError: boolean;
  itemCount: number;
}): AsyncCollectionState {
  if (itemCount > 0) return 'ready';
  if (isError) return 'error';
  if (isLoading) return 'loading';
  return 'empty';
}
