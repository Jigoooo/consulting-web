import { createFileRoute } from '@tanstack/react-router';
import { LibrarySurface } from '../components/library/LibrarySurface';

export const Route = createFileRoute('/_app/library')({
  component: LibraryPage,
});

function LibraryPage() {
  return <LibrarySurface variant="page" />;
}
