import { useEffect, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage } from '@consulting/contracts';
import { Markdown } from '../../../shared/ui/markdown/Markdown';
import { StreamingMarkdown } from '../../../shared/ui/markdown/StreamingMarkdown';
import { Icon } from '../../../shared/icons/Icon';
import { IconButton } from '../../../shared/ui/button/Button';
import { SkeletonMessage } from '../../../shared/ui/skeleton/Skeleton';
import { hoveredMessageStore } from '../../../lib/threadCtx';
import { ThinkingRibbon } from './ThinkingRibbon';
import { HighlightedText } from './HighlightedText';
import s from '../../thread-view/ui/ThreadView.module.css';

interface LiveTurnLike {
  id: number;
  role: 'user' | 'ai';
  text: string;
  runId?: string;
  streaming?: boolean;
  error?: string;
}

/** A search match to highlight within the stream (F3). */
export interface HighlightState {
  /** message ids that matched the current query */
  ids: Set<string>;
  /** the query string (for range highlighting) */
  query: string;
  /** the id currently focused by the result navigator (stronger highlight) */
  focusedId: string | null;
}

interface Props {
  messages: ChatMessage[];
  live: LiveTurnLike[];
  userName: string;
  busy: boolean;
  activeTool: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  bottomRef: RefObject<HTMLDivElement | null>;
  hasOlder: boolean;
  hasNewer: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  olderError: boolean;
  newerError: boolean;
  targetMessageId: string | null;
  highlight: HighlightState | null;
  onLoadOlder: () => Promise<void> | void;
  onLoadNewer: () => Promise<void> | void;
  onAtBottomChange: (atBottom: boolean) => void;
  onCopy: (text: string) => Promise<void> | void;
  onSaveArtifact: (content: string, messageId?: string) => Promise<void> | void;
  onRetry: (message: string) => Promise<void> | void;
  onRetryLast: () => Promise<void> | void;
}

function PersistedRow({
  message,
  userName,
  busy,
  highlight,
  onCopy,
  onSaveArtifact,
  onRetry,
}: {
  message: ChatMessage;
  userName: string;
  busy: boolean;
  highlight: HighlightState | null;
  onCopy: Props['onCopy'];
  onSaveArtifact: Props['onSaveArtifact'];
  onRetry: Props['onRetry'];
}) {
  const isMatch = highlight?.ids.has(message.id) ?? false;
  const highlightQuery = isMatch ? highlight?.query ?? '' : '';
  return (
    <div
      className={`${s.msg} ${s.msgHover}`}
      data-turn={`p-${message.id}`}
      data-message-id={message.id}
      onMouseEnter={() => message.role === 'assistant' && hoveredMessageStore.set(message.id)}
      onMouseLeave={() => message.role === 'assistant' && hoveredMessageStore.set(null)}
    >
      <div className={`${s.avatar} ${message.role === 'user' ? s.avatarUser : s.avatarAi}`}>
        {message.role === 'user' ? (message.authorName ?? userName).slice(0, 1) : <Icon name="bot" size="sm" decorative />}
      </div>
      <div className={s.body}>
        <div className={s.meta}>
          <span className={s.who}>{message.role === 'user' ? (message.authorName ?? userName) : '지구'}</span>
          <span className={s.time}>
            {new Date(message.createdAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}
          </span>
          <span className={s.msgActions}>
            <IconButton type="button" className={s.msgActionBtn} label="복사" icon="copy" onClick={() => void onCopy(message.content)} />
            {message.role === 'assistant' && message.content ? (
              <IconButton
                type="button"
                className={s.msgActionBtn}
                label="산출물로 저장"
                icon="download"
                onClick={() => void onSaveArtifact(message.content, message.id)}
              />
            ) : null}
            {message.role === 'user' ? (
              <IconButton
                type="button"
                className={s.msgActionBtn}
                label="다시 질문"
                icon="retry"
                disabled={busy}
                onClick={() => void onRetry(message.content)}
              />
            ) : null}
          </span>
        </div>
        {message.role === 'assistant' && !highlightQuery ? (
          <Markdown text={message.content} />
        ) : (
          <div className={s.text}>
            <HighlightedText text={message.content} query={highlightQuery} />
          </div>
        )}
        {message.finishState === 'error' ? (
          <div className={s.msgError}>이 응답은 오류로 중단되었어요.</div>
        ) : null}
        {message.finishState === 'cancelled' ? (
          <div className={s.msgNote}>중단된 응답</div>
        ) : null}
      </div>
    </div>
  );
}

function LiveRow({
  turn,
  userName,
  busy,
  activeTool,
  onCopy,
  onSaveArtifact,
  onRetryLast,
}: {
  turn: LiveTurnLike;
  userName: string;
  busy: boolean;
  activeTool: string | null;
  onCopy: Props['onCopy'];
  onSaveArtifact: Props['onSaveArtifact'];
  onRetryLast: Props['onRetryLast'];
}) {
  return (
    <div key={`live-${turn.id}`} className={`${s.msg} ${s.msgHover}`} data-turn={`l-${turn.id}`}>
      <div className={`${s.avatar} ${turn.role === 'user' ? s.avatarUser : s.avatarAi}`}>
        {turn.role === 'user' ? userName.slice(0, 1) : <Icon name="bot" size="sm" decorative />}
      </div>
      <div className={s.body}>
        <div className={s.meta}>
          <span className={s.who}>{turn.role === 'user' ? userName : '지구'}</span>
          {!turn.streaming && turn.text ? (
            <span className={s.msgActions}>
              <IconButton type="button" className={s.msgActionBtn} label="복사" icon="copy" onClick={() => void onCopy(turn.text)} />
              {turn.role === 'ai' ? (
                <IconButton
                  type="button"
                  className={s.msgActionBtn}
                  label="산출물로 저장"
                  icon="download"
                  onClick={() => void onSaveArtifact(turn.text)}
                />
              ) : null}
            </span>
          ) : null}
        </div>
        {turn.role === 'ai' ? (
          turn.text ? (
            <div>
              {turn.streaming ? <StreamingMarkdown text={turn.text} /> : <Markdown text={turn.text} />}
              {turn.streaming ? <span className={s.cursor} /> : null}
            </div>
          ) : turn.streaming ? (
            <ThinkingRibbon tool={activeTool} />
          ) : null
        ) : (
          <div className={s.text}>{turn.text}</div>
        )}
        {turn.error ? (
          <div className={s.liveError}>
            {turn.error}
            {!busy ? (
              <button type="button" className={`${s.retryBtn} cwTap`} onClick={() => void onRetryLast()}>
                <Icon name="retry" size="xs" decorative /> 다시 시도
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function VirtualMessageStream({
  messages,
  live,
  userName,
  busy,
  activeTool,
  scrollRef,
  bottomRef,
  hasOlder,
  hasNewer,
  isLoadingOlder,
  isLoadingNewer,
  olderError,
  newerError,
  targetMessageId,
  highlight,
  onLoadOlder,
  onLoadNewer,
  onAtBottomChange,
  onCopy,
  onSaveArtifact,
  onRetry,
  onRetryLast,
}: Props) {
  const didInitialScroll = useRef(false);
  const allowAutoLoad = useRef(false);
  const pendingAnchor = useRef<{ index: number; offset: number } | null>(null);
  const previousLength = useRef(messages.length);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => messages[index]?.id ?? index,
    estimateSize: () => 132,
    overscan: 12,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Fresh guard/callback values for the IntersectionObserver without re-subscribing.
  const guards = useRef({ hasOlder, hasNewer, isLoadingOlder, isLoadingNewer });
  guards.current = { hasOlder, hasNewer, isLoadingOlder, isLoadingNewer };
  const loadOlderRef = useRef(onLoadOlder);
  loadOlderRef.current = onLoadOlder;
  const loadNewerRef = useRef(onLoadNewer);
  loadNewerRef.current = onLoadNewer;
  const atBottomRef = useRef(onAtBottomChange);
  atBottomRef.current = onAtBottomChange;

  // Initial mount: pin to the newest message, then arm auto-loading.
  useEffect(() => {
    if (messages.length === 0) {
      didInitialScroll.current = false;
      allowAutoLoad.current = false;
      previousLength.current = 0;
      return;
    }
    if (didInitialScroll.current) return;
    didInitialScroll.current = true;
    allowAutoLoad.current = false;
    previousLength.current = messages.length;
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
      requestAnimationFrame(() => {
        allowAutoLoad.current = true;
      });
    });
  }, [messages.length, virtualizer]);

  // After an older page prepends, restore the anchor's on-screen position.
  useEffect(() => {
    const anchor = pendingAnchor.current;
    const prev = previousLength.current;
    if (messages.length === prev) return;
    previousLength.current = messages.length;
    if (!anchor || messages.length <= prev) return;
    pendingAnchor.current = null;
    const added = messages.length - prev;
    const newIndex = anchor.index + added;
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(newIndex, { align: 'start' });
      requestAnimationFrame(() => {
        const scroller = scrollRef.current;
        if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollTop - anchor.offset);
      });
    });
  }, [messages.length, virtualizer, scrollRef]);

  // Sentinel-driven infinite scroll + bottom-proximity tracking (A1). Callbacks
  // are read from refs and inlined here, so this effect does NOT depend on the
  // React Compiler stabilizing anything (E1) — deps are the stable scrollRef only.
  useEffect(() => {
    const scroller = scrollRef.current;
    const topEl = topSentinelRef.current;
    const bottomEl = bottomSentinelRef.current;
    if (!scroller) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === bottomEl) {
            // bottom sentinel visibility === "user is at/near the tail"
            atBottomRef.current(entry.isIntersecting);
          }
          if (!entry.isIntersecting) continue;
          if (entry.target === topEl) {
            if (!allowAutoLoad.current) continue;
            const g = guards.current;
            if (!g.hasOlder || g.isLoadingOlder) continue;
            const first = virtualizer.getVirtualItems()[0];
            if (first) {
              const el = scroller.querySelector<HTMLElement>(`[data-index="${first.index}"]`);
              const offset = el ? el.getBoundingClientRect().top - scroller.getBoundingClientRect().top : 0;
              pendingAnchor.current = { index: first.index, offset };
            }
            void loadOlderRef.current();
          } else if (entry.target === bottomEl) {
            if (!allowAutoLoad.current) continue;
            const g = guards.current;
            if (!g.hasNewer || g.isLoadingNewer) continue;
            void loadNewerRef.current();
          }
        }
      },
      { root: scroller, rootMargin: '320px 0px 120px 0px', threshold: 0 },
    );
    if (topEl) io.observe(topEl);
    if (bottomEl) io.observe(bottomEl);
    return () => io.disconnect();
  }, [scrollRef, virtualizer]);

  // Jump-to-search-hit: center the target row and pulse-highlight it.
  useEffect(() => {
    if (!targetMessageId) return;
    const index = messages.findIndex((message) => message.id === targetMessageId);
    if (index < 0) return;
    setHighlightedId(targetMessageId);
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(index, { align: 'center' });
    });
    const timer = window.setTimeout(() => setHighlightedId((current) => (current === targetMessageId ? null : current)), 1800);
    return () => window.clearTimeout(timer);
  }, [messages, targetMessageId, virtualizer]);

  return (
    <>
      <div ref={topSentinelRef} className={s.scrollSentinel} aria-hidden="true" />
      {/* Top loading / end-of-history affordance (A6) */}
      {isLoadingOlder ? (
        <div className={s.loadEdge}>
          <span className={s.sp} /> 이전 대화 불러오는 중…
        </div>
      ) : olderError ? (
        <button type="button" className={`${s.loadRetry} cwTap`} onClick={() => void loadOlderRef.current()}>
          <Icon name="retry" size="xs" decorative /> 이전 대화를 불러오지 못했어요. 다시 시도
        </button>
      ) : !hasOlder && messages.length > 0 ? (
        <div className={s.loadEnd}>대화의 시작이에요</div>
      ) : null}

      <div className={s.virtualCanvas} style={{ height: totalSize }}>
        {virtualItems.map((virtualRow) => {
          const message = messages[virtualRow.index];
          if (!message) return null;
          const isMatch = highlight?.ids.has(message.id) ?? false;
          const isFocused = highlight?.focusedId === message.id;
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className={[
                s.virtualItem,
                message.id === highlightedId ? s.virtualItemHit : '',
                isMatch ? s.virtualItemMatch : '',
                isFocused ? s.virtualItemFocused : '',
              ].filter(Boolean).join(' ')}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <PersistedRow
                message={message}
                userName={userName}
                busy={busy}
                highlight={highlight}
                onCopy={onCopy}
                onSaveArtifact={onSaveArtifact}
                onRetry={onRetry}
              />
            </div>
          );
        })}
      </div>

      {/* Bottom loading / end affordance (A6) */}
      {isLoadingNewer ? (
        <div className={s.loadEdge}>
          <span className={s.sp} /> 이후 대화 불러오는 중…
        </div>
      ) : newerError ? (
        <button type="button" className={`${s.loadRetry} cwTap`} onClick={() => void loadNewerRef.current()}>
          <Icon name="retry" size="xs" decorative /> 이후 대화를 불러오지 못했어요. 다시 시도
        </button>
      ) : hasNewer ? (
        <div className={s.loadEdge}>
          <SkeletonMessage />
        </div>
      ) : null}
      <div ref={bottomSentinelRef} className={s.scrollSentinel} aria-hidden="true" />
      {live.map((turn) => (
        <LiveRow
          key={`live-${turn.id}`}
          turn={turn}
          userName={userName}
          busy={busy}
          activeTool={activeTool}
          onCopy={onCopy}
          onSaveArtifact={onSaveArtifact}
          onRetryLast={onRetryLast}
        />
      ))}
      <div ref={bottomRef} />
    </>
  );
}
