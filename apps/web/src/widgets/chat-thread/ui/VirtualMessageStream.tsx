import { useEffect, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage, ChatMessageAttachment } from '@consulting/contracts';
import { Markdown } from '../../../shared/ui/markdown/Markdown';
import { StreamingMarkdown } from '../../../shared/ui/markdown/StreamingMarkdown';
import { Icon } from '../../../shared/icons/Icon';
import { IconButton } from '../../../shared/ui/button/Button';
import { SkeletonMessage } from '../../../shared/ui/skeleton/Skeleton';
import { useDelayedFlag } from '../../../shared/lib/useDelayedFlag';
import { formatDateLabel, formatFullDateTime, dayKey } from '../../../shared/lib/formatDate';
import { hoveredMessageStore } from '../../../lib/threadCtx';
import { ThinkingRibbon } from './ThinkingRibbon';
import { HighlightedText } from './HighlightedText';
import { computePrefetchRootMargin } from '../model/prefetchMargin';
import s from '../../thread-view/ui/ThreadView.module.css';

interface LiveTurnLike {
  id: number;
  role: 'user' | 'ai';
  text: string;
  attachments?: ChatMessageAttachment[];
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
  threadId: string;
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
  showNewDivider?: boolean;
  onLoadOlder: () => Promise<void> | void;
  onLoadNewer: () => Promise<void> | void;
  onAtBottomChange: (atBottom: boolean) => void;
  onCopy: (text: string) => Promise<void> | void;
  onSaveArtifact: (content: string, messageId?: string) => Promise<void> | void;
  onRetry: (message: string) => Promise<void> | void;
  onRetryLast: () => Promise<void> | void;
  onChoice: (choice: string) => void;
  onOpenAttachment: (attachment: ChatMessageAttachment) => void;
  onDeleteAttachment: (attachment: ChatMessageAttachment) => Promise<void> | void;
  deletingAttachmentId: string | null;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentCards({
  attachments,
  onOpenAttachment,
  onDeleteAttachment,
  deletingAttachmentId,
}: {
  attachments: ChatMessageAttachment[] | undefined;
  onOpenAttachment: Props['onOpenAttachment'];
  onDeleteAttachment: Props['onDeleteAttachment'];
  deletingAttachmentId: string | null;
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className={s.fileStrip}>
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={s.fileChip}
        >
          <button
            type="button"
            className={s.fileChipMain}
            title={`미리보기 (${fmtSize(attachment.sizeBytes)})`}
            onClick={() => onOpenAttachment(attachment)}
          >
            <Icon name="paperclip" size="xs" decorative /> {attachment.fileName} <span className={s.fileSize}>{fmtSize(attachment.sizeBytes)}</span>
          </button>
          <button
            type="button"
            className={s.fileChipRemove}
            aria-label={`${attachment.fileName} 첨부 삭제`}
            disabled={deletingAttachmentId === attachment.id}
            onClick={() => void onDeleteAttachment(attachment)}
          >
            <Icon name="x" size="xs" decorative />
          </button>
        </div>
      ))}
    </div>
  );
}

function PersistedRow({
  message,
  userName,
  busy,
  highlight,
  onCopy,
  onSaveArtifact,
  onRetry,
  onChoice,
  onOpenAttachment,
  onDeleteAttachment,
  deletingAttachmentId,
}: {
  message: ChatMessage;
  userName: string;
  busy: boolean;
  highlight: HighlightState | null;
  onCopy: Props['onCopy'];
  onSaveArtifact: Props['onSaveArtifact'];
  onRetry: Props['onRetry'];
  onChoice: Props['onChoice'];
  onOpenAttachment: Props['onOpenAttachment'];
  onDeleteAttachment: Props['onDeleteAttachment'];
  deletingAttachmentId: string | null;
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
          <span className={s.time} title={formatFullDateTime(message.createdAt)}>
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
          <Markdown text={message.content} onChoice={onChoice} />
        ) : (
          <div className={s.text}>
            <HighlightedText text={message.content} query={highlightQuery} />
          </div>
        )}
        <AttachmentCards
          attachments={message.attachments}
          onOpenAttachment={onOpenAttachment}
          onDeleteAttachment={onDeleteAttachment}
          deletingAttachmentId={deletingAttachmentId}
        />
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
  onChoice,
  onOpenAttachment,
  onDeleteAttachment,
  deletingAttachmentId,
}: {
  turn: LiveTurnLike;
  userName: string;
  busy: boolean;
  activeTool: string | null;
  onCopy: Props['onCopy'];
  onSaveArtifact: Props['onSaveArtifact'];
  onRetryLast: Props['onRetryLast'];
  onChoice: Props['onChoice'];
  onOpenAttachment: Props['onOpenAttachment'];
  onDeleteAttachment: Props['onDeleteAttachment'];
  deletingAttachmentId: string | null;
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
              {turn.streaming ? <StreamingMarkdown text={turn.text} /> : <Markdown text={turn.text} onChoice={onChoice} />}
              {turn.streaming ? <span className={s.cursor} /> : null}
            </div>
          ) : turn.streaming ? (
            <ThinkingRibbon tool={activeTool} />
          ) : null
        ) : (
          <>
            {turn.text ? <div className={s.text}>{turn.text}</div> : null}
            <AttachmentCards
              attachments={turn.attachments}
              onOpenAttachment={onOpenAttachment}
              onDeleteAttachment={onDeleteAttachment}
              deletingAttachmentId={deletingAttachmentId}
            />
          </>
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
  threadId,
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
  showNewDivider,
  onLoadOlder,
  onLoadNewer,
  onAtBottomChange,
  onCopy,
  onSaveArtifact,
  onRetry,
  onRetryLast,
  onChoice,
  onOpenAttachment,
  onDeleteAttachment,
  deletingAttachmentId,
}: Props) {
  const didInitialScroll = useRef(false);
  const allowAutoLoad = useRef(false);
  const pendingAnchor = useRef<{ index: number; offset: number } | null>(null);
  const previousLength = useRef(messages.length);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [topDateLabel, setTopDateLabel] = useState<string>('');

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => messages[index]?.id ?? index,
    estimateSize: () => 132,
    overscan: 12,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // 축2: sticky 날짜 pill — 현재 뷰포트 상단에 보이는 첫 메시지의 날짜를 추적.
  // 가상 리스트라 DOM 순회 대신 virtualizer가 계산한 상단 인덱스의 createdAt을
  // 읽는다(스크롤마다 virtualItems가 갱신되므로 effect가 재실행됨).
  useEffect(() => {
    const firstIndex = virtualItems[0]?.index;
    if (firstIndex == null) return;
    const msg = messages[firstIndex];
    if (!msg) return;
    const label = formatDateLabel(msg.createdAt);
    setTopDateLabel((prev) => (prev === label ? prev : label));
  }, [virtualItems, messages]);

  // G2: suppress the "불러오는 중" affordance for fast prefetches — only show it
  // when a page load genuinely takes >400ms. Normal prefetches stay silent.
  const showOlderLoading = useDelayedFlag(isLoadingOlder, 400);
  const showNewerLoading = useDelayedFlag(isLoadingNewer, 400);

  // Fresh guard/callback values for the IntersectionObserver without re-subscribing.
  const guards = useRef({ hasOlder, hasNewer, isLoadingOlder, isLoadingNewer });
  guards.current = { hasOlder, hasNewer, isLoadingOlder, isLoadingNewer };
  const loadOlderRef = useRef(onLoadOlder);
  loadOlderRef.current = onLoadOlder;
  const loadNewerRef = useRef(onLoadNewer);
  loadNewerRef.current = onLoadNewer;
  const atBottomRef = useRef(onAtBottomChange);
  atBottomRef.current = onAtBottomChange;

  // Channel switch: reset scroll/paging state so the new thread re-pins to its
  // own tail. Without this, didInitialScroll stays true from the previous
  // channel and the new channel never scrolls to the bottom (bug: 텔레그램
  // 채널에서 맨 밑으로 안 감), and stale virtualizer offset shows the old
  // conversation for a frame (bug: 새 채널에 이전 대화가 보임).
  useEffect(() => {
    didInitialScroll.current = false;
    allowAutoLoad.current = false;
    pendingAnchor.current = null;
    previousLength.current = 0;
    setHighlightedId(null);
    // Snap to top immediately; the initial-scroll effect below re-pins to the
    // tail once this thread's messages are in.
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = 0;
  }, [threadId, scrollRef]);

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
  //
  // G2 (unconscious prefetch): the observer's rootMargin is sized to a multiple
  // of the viewport height and grown with scroll velocity, so older pages are
  // requested well before the top edge scrolls into view. Velocity is tracked in
  // a rAF loop; when the computed margin changes meaningfully we re-arm the
  // observer with the new margin (anchor/sentinel logic is unchanged).
  const rootMarginRef = useRef('');
  useEffect(() => {
    const scroller = scrollRef.current;
    const topEl = topSentinelRef.current;
    const bottomEl = bottomSentinelRef.current;
    if (!scroller) return;

    let io: IntersectionObserver | null = null;
    let lastScrollTop = scroller.scrollTop;
    let lastTs = 0;
    let velocity = 0;
    let rafPending = false;
    let idleTimer = 0;

    const handleIntersect: IntersectionObserverCallback = (entries) => {
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
    };

    const arm = (rootMargin: string) => {
      if (rootMargin === rootMarginRef.current && io) return;
      rootMarginRef.current = rootMargin;
      io?.disconnect();
      io = new IntersectionObserver(handleIntersect, { root: scroller, rootMargin, threshold: 0 });
      if (topEl) io.observe(topEl);
      if (bottomEl) io.observe(bottomEl);
    };

    // Prime with an idle margin. We only re-measure while the user is actively
    // scrolling — no always-on rAF loop, so idle costs nothing.
    arm(computePrefetchRootMargin({ viewportHeight: scroller.clientHeight, velocity: 0 }));

    const measure = () => {
      rafPending = false;
      const now = scroller.scrollTop;
      velocity = Math.abs(now - lastScrollTop);
      lastScrollTop = now;
      arm(computePrefetchRootMargin({ viewportHeight: scroller.clientHeight, velocity }));
    };

    const onScroll = () => {
      lastTs = Date.now();
      if (!rafPending) {
        rafPending = true;
        window.requestAnimationFrame(measure);
      }
      // After scrolling stops, relax the margin back to idle so the observer
      // isn't left armed with a huge velocity-inflated margin.
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        if (Date.now() - lastTs < 140) return;
        arm(computePrefetchRootMargin({ viewportHeight: scroller.clientHeight, velocity: 0 }));
      }, 160);
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.clearTimeout(idleTimer);
      io?.disconnect();
    };
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
      {/* 축2: sticky 날짜 pill — 현재 보는 영역의 날짜를 상단에 고정 표시. */}
      {topDateLabel ? (
        <div className={s.stickyDate} aria-hidden="true">
          <span className={s.stickyDatePill}>{topDateLabel}</span>
        </div>
      ) : null}
      <div ref={topSentinelRef} className={s.scrollSentinel} aria-hidden="true" />
      {/* Top loading / end-of-history affordance (A6). G2: only surfaced when the
          older-page load exceeds 400ms — fast prefetches stay silent. */}
      {showOlderLoading ? (
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
          // 축2: 날짜가 바뀌는 첫 메시지 위에 경계 divider(── 2026년 7월 6일 ──).
          const prev = virtualRow.index > 0 ? messages[virtualRow.index - 1] : undefined;
          const showDateDivider = !prev || dayKey(prev.createdAt) !== dayKey(message.createdAt);
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
              {showDateDivider ? (
                <div className={s.dateDivider} role="separator">
                  <span>{formatDateLabel(message.createdAt)}</span>
                </div>
              ) : null}
              <PersistedRow
                message={message}
                userName={userName}
                busy={busy}
                highlight={highlight}
                onCopy={onCopy}
                onSaveArtifact={onSaveArtifact}
                onRetry={onRetry}
                onChoice={onChoice}
                onOpenAttachment={onOpenAttachment}
                onDeleteAttachment={onDeleteAttachment}
                deletingAttachmentId={deletingAttachmentId}
              />
            </div>
          );
        })}
      </div>

      {/* Bottom loading / end affordance (A6). G2: delayed like the top edge. */}
      {showNewerLoading ? (
        <div className={s.loadEdge}>
          <span className={s.sp} /> 이후 대화 불러오는 중…
        </div>
      ) : newerError ? (
        <button type="button" className={`${s.loadRetry} cwTap`} onClick={() => void loadNewerRef.current()}>
          <Icon name="retry" size="xs" decorative /> 이후 대화를 불러오지 못했어요. 다시 시도
        </button>
      ) : hasNewer && !isLoadingNewer ? (
        <div className={s.loadEdge}>
          <SkeletonMessage />
        </div>
      ) : null}
      <div ref={bottomSentinelRef} className={s.scrollSentinel} aria-hidden="true" />
      {showNewDivider && live.length > 0 ? (
        <div className={s.newDivider} role="separator" aria-label="여기까지 읽음">
          <span>새 메시지</span>
        </div>
      ) : null}
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
          onChoice={onChoice}
          onOpenAttachment={onOpenAttachment}
          onDeleteAttachment={onDeleteAttachment}
          deletingAttachmentId={deletingAttachmentId}
        />
      ))}
      <div ref={bottomRef} />
    </>
  );
}
