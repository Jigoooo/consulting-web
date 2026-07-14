import { createFileRoute } from '@tanstack/react-router';
import { TraceViewerSurface } from '../components/observability/TraceViewerSurface';
import { parseObservabilitySearch } from './-observabilityRouteSearch';

export const Route = createFileRoute('/_app/observability')({
  validateSearch: parseObservabilitySearch,
  component: ObservabilityPage,
});

function ObservabilityPage() {
  const { threadId } = Route.useSearch();
  return <TraceViewerSurface initialThreadId={threadId} />;
}
