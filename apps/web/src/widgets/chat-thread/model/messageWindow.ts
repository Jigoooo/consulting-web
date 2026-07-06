import type { ChatMessage, ListMessagesPageResponse } from '@consulting/contracts';

export type MessageWindowMode = 'latest' | 'around';
export type MessagePageDirection = 'latest' | 'older' | 'newer' | 'around';

export interface MessageWindow {
  readonly mode: MessageWindowMode;
  readonly messagesById: Map<string, ChatMessage>;
  readonly orderedIds: string[];
  readonly messages: ChatMessage[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly olderCursor: string | null;
  readonly newerCursor: string | null;
  readonly anchorMessageId: string | null;
}

function createEmpty(mode: MessageWindowMode = 'latest'): MessageWindow {
  return {
    mode,
    messagesById: new Map(),
    orderedIds: [],
    messages: [],
    hasOlder: false,
    hasNewer: false,
    olderCursor: null,
    newerCursor: null,
    anchorMessageId: null,
  };
}

function chronological(a: ChatMessage, b: ChatMessage): number {
  const t = a.createdAt.localeCompare(b.createdAt);
  if (t !== 0) return t;
  return a.id.localeCompare(b.id);
}

function materialize(
  base: Omit<MessageWindow, 'messages'>,
): MessageWindow {
  const messages = base.orderedIds.map((id) => base.messagesById.get(id)).filter((m): m is ChatMessage => Boolean(m));
  return { ...base, messages };
}

export function mergeMessagePage(
  current: MessageWindow | undefined,
  page: ListMessagesPageResponse,
  direction: MessagePageDirection,
): MessageWindow {
  const mode: MessageWindowMode = direction === 'around' ? 'around' : current?.mode ?? 'latest';
  const source = direction === 'around' ? createEmpty('around') : current ?? createEmpty(mode);
  const messagesById = new Map(source.messagesById);
  for (const message of page.messages) {
    messagesById.set(message.id, message);
  }

  const orderedIds = Array.from(messagesById.values())
    .sort(chronological)
    .map((message) => message.id);

  const hasOlder = direction === 'older' || direction === 'around' || direction === 'latest'
    ? page.hasOlder
    : source.hasOlder;
  const hasNewer = direction === 'newer' || direction === 'around' || direction === 'latest'
    ? page.hasNewer
    : source.hasNewer;
  const olderCursor = direction === 'older' || direction === 'around' || direction === 'latest'
    ? page.olderCursor
    : source.olderCursor;
  const newerCursor = direction === 'newer' || direction === 'around' || direction === 'latest'
    ? page.newerCursor
    : source.newerCursor;

  return materialize({
    mode,
    messagesById,
    orderedIds,
    hasOlder,
    hasNewer,
    olderCursor,
    newerCursor,
    anchorMessageId: page.anchorMessageId ?? (direction === 'around' ? null : source.anchorMessageId),
  });
}
