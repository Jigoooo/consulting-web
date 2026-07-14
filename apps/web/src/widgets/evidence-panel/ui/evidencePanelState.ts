export type EvidencePanelLoadState = 'loading' | 'error' | 'empty' | 'ready' | 'stale';

export function evidencePanelLoadState(
  isLoading: boolean,
  isError: boolean,
  itemCount: number,
): EvidencePanelLoadState {
  if (itemCount > 0) return isError ? 'stale' : 'ready';
  if (isLoading) return 'loading';
  if (isError) return 'error';
  return 'empty';
}
