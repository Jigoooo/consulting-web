import type { ChatMessage, ListMessagesPageResponse } from '@consulting/contracts';

/** Hard ceiling on the in-memory message window (D4). Paging past this trims the
 *  far side and re-opens that edge's cursor so scrolling back re-hydrates it. */
export const MAX_WINDOW = 400;

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

  let hasOlder = direction === 'older' || direction === 'around' || direction === 'latest'
    ? page.hasOlder
    : source.hasOlder;
  let hasNewer = direction === 'newer' || direction === 'around' || direction === 'latest'
    ? page.hasNewer
    : source.hasNewer;
  let olderCursor = direction === 'older' || direction === 'around' || direction === 'latest'
    ? page.olderCursor
    : source.olderCursor;
  let newerCursor = direction === 'newer' || direction === 'around' || direction === 'latest'
    ? page.newerCursor
    : source.newerCursor;

  const anchorMessageId = page.anchorMessageId ?? (direction === 'around' ? null : source.anchorMessageId);

  // D4: enforce the memory ceiling. Trim the side OPPOSITE the growth direction
  // and re-open that edge so the trimmed messages can be paged back in.
  //
  // Anchor handling: when the user keeps paging in ONE direction they are moving
  // away from the jump anchor, so trimming the far (opposite) side is always safe
  // — we only guarantee we never trim so far that the anchor itself is evicted in
  // the SAME merge that introduced it (the 'around' seed). Concretely we cap the
  // cut so at least the anchor and everything past it (in the growth direction)
  // survives, but we do NOT let the anchor pin the trailing edge forever.
  let trimmedIds = orderedIds;
  if (orderedIds.length > MAX_WINDOW) {
    const overflow = orderedIds.length - MAX_WINDOW;
    // Newer growth ('newer'/'latest') trims the oldest side; older growth trims
    // the newest side. 'around' (the seed) defaults to trimming the newest side.
    const trimFromStart = direction === 'newer' || direction === 'latest';
    if (trimFromStart) {
      // Trimming the oldest side (newer/latest growth). The user is scrolling
      // toward the tail and away from any jump anchor, so no anchor protection.
      const cut = overflow;
      if (cut > 0) {
        const removed = orderedIds.slice(0, cut);
        trimmedIds = orderedIds.slice(cut);
        for (const id of removed) messagesById.delete(id);
        hasOlder = true;
        olderCursor = trimmedIds[0] ?? olderCursor;
      }
    } else {
      // Trimming the newest side (older growth). Same rule mirrored.
      let cut = overflow;
      if (direction === 'around' && anchorMessageId) {
        const anchorIdx = orderedIds.indexOf(anchorMessageId);
        const fromEnd = orderedIds.length - 1 - anchorIdx;
        if (anchorIdx >= 0 && fromEnd < cut) cut = fromEnd;
      }
      if (cut > 0) {
        const keep = orderedIds.length - cut;
        const removed = orderedIds.slice(keep);
        trimmedIds = orderedIds.slice(0, keep);
        for (const id of removed) messagesById.delete(id);
        hasNewer = true;
        newerCursor = trimmedIds[trimmedIds.length - 1] ?? newerCursor;
      }
    }
  }

  return materialize({
    mode,
    messagesById,
    orderedIds: trimmedIds,
    hasOlder,
    hasNewer,
    olderCursor,
    newerCursor,
    anchorMessageId,
  });
}
