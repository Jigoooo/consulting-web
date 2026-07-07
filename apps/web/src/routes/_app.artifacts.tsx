import { createFileRoute } from '@tanstack/react-router';
import { ArtifactsSurface } from '../components/artifacts/ArtifactsSurface';

export const Route = createFileRoute('/_app/artifacts')({
  validateSearch: (search: Record<string, unknown>): { projectId?: string } =>
    (typeof search.projectId === 'string' && search.projectId ? { projectId: search.projectId } : {}),
  component: ArtifactsPage,
});

function ArtifactsPage() {
  const { projectId } = Route.useSearch();
  return <ArtifactsSurface initialProjectId={projectId} variant="page" />;
}
