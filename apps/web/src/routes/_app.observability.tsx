import { createFileRoute } from '@tanstack/react-router';
import { TraceViewerSurface } from '../components/observability/TraceViewerSurface';

export const Route = createFileRoute('/_app/observability')({
  component: ObservabilityPage,
});

function ObservabilityPage() {
  return <TraceViewerSurface />;
}
