import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ChatThread } from '../components/chat/ChatThread';

const searchSchema = z.object({
  title: z.string().default('스레드'),
});

export const Route = createFileRoute('/_app/th/$threadId')({
  validateSearch: searchSchema,
  component: ThreadPage,
});

function ThreadPage() {
  const { threadId } = Route.useParams();
  const { title } = Route.useSearch();
  return <ChatThread threadId={threadId} title={title} />;
}
