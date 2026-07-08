import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useVirtualizer, type ReactVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage, ChatMessageAttachment } from '@consulting/contracts';
import { Markdown } from '../../../shared/ui/markdown/Markdown';
import { StreamingMarkdown } from '../../../shared/ui/markdown/StreamingMarkdown';
import { Icon } from '../../../shared/icons/Icon';
import { IconButton } from '../../../shared/ui/button/Button';
import { SkeletonMessage } from '../../../shared/ui/skeleton/Skeleton';
import { useDelayedFlag } from '../../../shared/lib/useDelayedFlag';
import { formatDateLabel, formatFullDateTime, dayKey } from '../../../shared/lib/formatDate';
import { describeVerifierGate } from '../../../shared/lib/verifierGateView';
import { hoveredMessageStore } from '../../../lib/threadCtx';
import { ThinkingRibbon } from './ThinkingRibbon';
import { HighlightedText } from './HighlightedText';
import { computePrefetchRootMargin } from '../model/prefetchMargin';
import {
  shouldAutoPageEdge,
  type ScrollDirection,
} from '../model/scrollPaging';
import s from '../../thread-view/ui/ThreadView.module.css';

type VerificationClaim = NonNullable<ChatMessage['verification']>['claims'][number];
type MessageVirtualizer = ReactVirtualizer<HTMLDivElement, Element>;
interface TailLockState {
  threadId: string;
  startedAt: number;
}

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

function verdictLabel(verdict: VerificationClaim['verdict']): '지지됨' | '반박됨' | '근거부족' {
  if (verdict === 'supports') return '지지됨';
  if (verdict === 'refutes' || verdict === 'mixed') return '반박됨';
  return '근거부족';
}

function rewritePrompt(action: 'rewrite' | 'remove' | 'more', claim: VerificationClaim): string {
  if (action === 'rewrite') return `다음 문장을 현재 근거로 다시 검증하고, 근거가 충분한 표현으로만 재작성해줘: ${claim.claimText}`;
  if (action === 'remove') return `다음 문장이 반박되거나 근거부족이면 답변에서 제거하고, 남은 답변의 흐름을 자연스럽게 정리해줘: ${claim.claimText}`;
  return `다음 판단을 확정하기 위해 어떤 추가 자료가 필요한지 3개 이내로 요청문을 작성해줘: ${claim.claimText}`;
}

function VerificationInlinePanel({ verification, busy, onRetry }: { verification: ChatMessage['verification']; busy: boolean; onRetry: Props['onRetry'] }) {
  if (!verification || verification.claims.length === 0) return null;
  const gateView = verification.gate ? describeVerifierGate(verification.gate) : null;
  return (
    <div className={s.verificationInline} data-testid="assistant-verification-inline">
      <div className={s.verificationInlineHead}>
        <span className={`${s.verificationBadge} ${s[`verificationBadge_${verification.status}`]}`}>{verification.badgeLabel}</span>
        {gateView ? (
          <span className={`${s.verificationGateBadge} ${s[`verificationGateBadge_${gateView.tone}`]}`} data-gate={gateView.tone} title={gateView.title}>
            {gateView.label}
          </span>
        ) : null}
        <span className={s.verificationCounts}>
          지지 {verification.counts.supports} · 반박 {verification.counts.refutes + verification.counts.mixed} · 근거부족 {verification.counts.notEnoughInfo}
        </span>
      </div>
      {verification.claims.map((claim) => {
        const label = verdictLabel(claim.verdict);
        const needsAction = claim.verdict !== 'supports';
        return (
          <div key={claim.claimId} className={s.verificationClaimRow} data-verdict={claim.verdict}>
            <div className={s.verificationClaimText}>{claim.claimText}</div>
            <span className={`${s.verificationMiniBadge} ${s[`verificationMiniBadge_${claim.verdict}`]}`}>{label}</span>
            {needsAction ? (
              <div className={s.verificationActions}>
                <button type="button" disabled={busy} onClick={() => void onRetry(rewritePrompt('rewrite', claim))}>근거 보강 후 재작성</button>
                <button type="button" disabled={busy} onClick={() => void onRetry(rewritePrompt('remove', claim))}>해당 문장 제거</button>
                <button type="button" disabled={busy} onClick={() => void onRetry(rewritePrompt('more', claim))}>추가 자료 요청</button>
              </div>
            ) : null}
          </div>
        );
      })}
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
        {message.role === 'assistant' ? <VerificationInlinePanel verification={message.verification} busy={busy} onRetry={onRetry} /> : null}
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
  const userScrollIntent = useRef(false);
  const scrollDirection = useRef<ScrollDirection>('none');
  const suppressAutoLoadUntil = useRef(0);
  const olderEdgeLoadPending = useRef(false);
  const appliedTargetRef = useRef<string | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const tailLockRef = useRef<TailLockState | null>(null);
  const tailSettleTimerRef = useRef(0);
  const tailReleaseFrameRef = useRef(0);
  const tailReleasePendingRef = useRef(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [topDateLabel, setTopDateLabel] = useState<string>('');
  const [isTailSettling, setIsTailSettling] = useState(true);

  const getItemKey = useCallback((index: number) => messages[index]?.id ?? `missing-${index}`, [messages]);

  const clearTailSettleTimer = useCallback(() => {
    if (!tailSettleTimerRef.current) return;
    window.clearTimeout(tailSettleTimerRef.current);
    tailSettleTimerRef.current = 0;
  }, []);

  const clearTailReleaseFrame = useCallback(() => {
    if (!tailReleaseFrameRef.current) return;
    window.cancelAnimationFrame(tailReleaseFrameRef.current);
    tailReleaseFrameRef.current = 0;
  }, []);

  const finishTailLock = useCallback((instance?: MessageVirtualizer) => {
    const lock = tailLockRef.current;
    if (!lock || lock.threadId !== threadId) return;
    clearTailSettleTimer();
    clearTailReleaseFrame();
    const scroller = scrollRef.current;
    const clampTail = () => {
      if (!instance || !scroller) return;
      instance.scrollToEnd({ behavior: 'auto' });
      scroller.scrollTop = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
    };
    clampTail();
    tailReleaseFrameRef.current = window.requestAnimationFrame(() => {
      clampTail();
      tailReleaseFrameRef.current = window.requestAnimationFrame(() => {
        tailReleaseFrameRef.current = 0;
        const current = tailLockRef.current;
        if (!current || current.threadId !== threadId) return;
        clampTail();
        tailLockRef.current = null;
        tailReleasePendingRef.current = true;
        allowAutoLoad.current = true;
        setIsTailSettling(false);
      });
    });
  }, [clearTailReleaseFrame, clearTailSettleTimer, scrollRef, threadId]);

  const lockTailToEnd = useCallback((instance: MessageVirtualizer) => {
    const lock = tailLockRef.current;
    const scroller = scrollRef.current;
    if (!lock || lock.threadId !== threadId || !scroller || messages.length === 0) return;
    suppressProgrammaticAutoLoad(900);
    instance.scrollToEnd({ behavior: 'auto' });
    scroller.scrollTop = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
  }, [messages.length, scrollRef, threadId]);

  const scheduleTailLockSettle = useCallback((instance: MessageVirtualizer) => {
    const lock = tailLockRef.current;
    if (!lock || lock.threadId !== threadId) return;
    clearTailSettleTimer();
    clearTailReleaseFrame();
    tailSettleTimerRef.current = window.setTimeout(() => {
      tailSettleTimerRef.current = 0;
      const current = tailLockRef.current;
      const scroller = scrollRef.current;
      if (!current || current.threadId !== threadId || !scroller) return;
      lockTailToEnd(instance);
      const distanceFromEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const quietAtEnd = distanceFromEnd < 8;
      const timedOut = performance.now() - current.startedAt > 2_500;
      if (quietAtEnd || timedOut) {
        finishTailLock(instance);
      } else {
        scheduleTailLockSettle(instance);
      }
    }, 480);
  }, [clearTailReleaseFrame, clearTailSettleTimer, finishTailLock, lockTailToEnd, scrollRef, threadId]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 180,
    overscan: 12,
    anchorTo: 'end',
    followOnAppend: 'auto',
    scrollEndThreshold: 48,
    useAnimationFrameWithResizeObserver: false,
    useFlushSync: true,
    onChange: (instance, _sync) => {
      // Event-driven tail lock: row ResizeObserver measurements call
      // resizeItem() -> notify(false) -> onChange(false). Keep the live tail
      // pinned only when real measurements change, instead of guessing a frame
      // count and visibly pushing the list multiple times.
      lockTailToEnd(instance as MessageVirtualizer);
      scheduleTailLockSettle(instance as MessageVirtualizer);
    },
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  function suppressProgrammaticAutoLoad(ms = 650) {
    suppressAutoLoadUntil.current = Date.now() + ms;
    userScrollIntent.current = false;
    scrollDirection.current = 'none';
  }

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
  const showOlderLoading = useDelayedFlag(isLoadingOlder, 400, 260);
  const showNewerLoading = useDelayedFlag(isLoadingNewer, 400, 260);

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
  useLayoutEffect(() => {
    didInitialScroll.current = false;
    allowAutoLoad.current = false;
    olderEdgeLoadPending.current = false;
    clearTailSettleTimer();
    clearTailReleaseFrame();
    tailLockRef.current = { threadId, startedAt: performance.now() };
    setIsTailSettling(true);
    suppressProgrammaticAutoLoad();
    setHighlightedId(null);
    appliedTargetRef.current = null;
    return () => {
      clearTailSettleTimer();
      clearTailReleaseFrame();
    };
  }, [clearTailReleaseFrame, clearTailSettleTimer, threadId]);

  // Initial mount/channel re-entry: pin to the newest message before paint.
  // Subsequent markdown/attachment height changes are handled by the
  // virtualizer's ResizeObserver -> onChange(false) path above, and the lock is
  // released when the bottom sentinel is actually intersecting.
  useLayoutEffect(() => {
    if (messages.length === 0) {
      didInitialScroll.current = false;
      allowAutoLoad.current = false;
      olderEdgeLoadPending.current = false;
      tailLockRef.current = null;
      tailReleasePendingRef.current = false;
      setIsTailSettling(false);
      return;
    }
    if (didInitialScroll.current) return;
    didInitialScroll.current = true;
    allowAutoLoad.current = false;
    suppressProgrammaticAutoLoad();
    if (!tailLockRef.current) {
      tailLockRef.current = { threadId, startedAt: performance.now() };
      setIsTailSettling(true);
    }
    lockTailToEnd(virtualizer);
    scheduleTailLockSettle(virtualizer);
  }, [lockTailToEnd, messages.length, scheduleTailLockSettle, virtualizer]);

  useLayoutEffect(() => {
    if (isTailSettling || !tailReleasePendingRef.current) return;
    tailReleasePendingRef.current = false;
    const scroller = scrollRef.current;
    if (!scroller) return;
    virtualizer.scrollToEnd({ behavior: 'auto' });
    scroller.scrollTop = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
  }, [isTailSettling, scrollRef, virtualizer]);

  useEffect(() => {
    if (!isLoadingOlder) olderEdgeLoadPending.current = false;
  }, [isLoadingOlder, messages.length]);

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
          const g = guards.current;
          // The bottom of the loaded window is only the live tail when no newer
          // page exists. In around/search windows, keep JumpToLatest visible.
          atBottomRef.current(entry.isIntersecting && !g.hasNewer);
          if (entry.isIntersecting && !g.hasNewer && tailLockRef.current) {
            lockTailToEnd(virtualizer);
            scheduleTailLockSettle(virtualizer);
          }
        }
        if (!entry.isIntersecting) continue;
        if (entry.target === topEl) {
          const g = guards.current;
          if (!shouldAutoPageEdge({
            edge: 'older',
            isIntersecting: entry.isIntersecting,
            allowAutoLoad: allowAutoLoad.current,
            hasPage: g.hasOlder,
            isLoading: g.isLoadingOlder,
            userInitiated: userScrollIntent.current,
            direction: scrollDirection.current,
            now: Date.now(),
            suppressUntil: suppressAutoLoadUntil.current,
          })) continue;
          if (olderEdgeLoadPending.current) continue;
          olderEdgeLoadPending.current = true;
          void loadOlderRef.current();
        } else if (entry.target === bottomEl) {
          const g = guards.current;
          if (!shouldAutoPageEdge({
            edge: 'newer',
            isIntersecting: entry.isIntersecting,
            allowAutoLoad: allowAutoLoad.current,
            hasPage: g.hasNewer,
            isLoading: g.isLoadingNewer,
            userInitiated: userScrollIntent.current,
            direction: scrollDirection.current,
            now: Date.now(),
            suppressUntil: suppressAutoLoadUntil.current,
          })) continue;
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
      if (tailLockRef.current) {
        lockTailToEnd(virtualizer);
        scheduleTailLockSettle(virtualizer);
      }
      const now = scroller.scrollTop;
      const delta = now - lastScrollTop;
      velocity = Math.abs(delta);
      lastScrollTop = now;
      if (Date.now() >= suppressAutoLoadUntil.current && delta !== 0) {
        scrollDirection.current = delta > 0 ? 'down' : 'up';
        userScrollIntent.current = true;
      } else if (Date.now() < suppressAutoLoadUntil.current) {
        scrollDirection.current = 'none';
        userScrollIntent.current = false;
      }
      arm(computePrefetchRootMargin({ viewportHeight: scroller.clientHeight, velocity }));
    };

    const onWheel = (event: WheelEvent) => {
      if (Date.now() < suppressAutoLoadUntil.current || event.deltaY === 0) return;
      scrollDirection.current = event.deltaY > 0 ? 'down' : 'up';
      userScrollIntent.current = true;
      // A programmatic jump can leave the top sentinel already intersecting at
      // scrollTop=0; a subsequent upward wheel does not create a new IO crossing.
      // Treat that wheel as the edge intent directly so older history still loads.
      if (event.deltaY >= 0 || scroller.scrollTop > 2 || olderEdgeLoadPending.current) return;
      const g = guards.current;
      if (!shouldAutoPageEdge({
        edge: 'older',
        isIntersecting: true,
        allowAutoLoad: allowAutoLoad.current,
        hasPage: g.hasOlder,
        isLoading: g.isLoadingOlder,
        userInitiated: true,
        direction: 'up',
        now: Date.now(),
        suppressUntil: suppressAutoLoadUntil.current,
      })) return;
      olderEdgeLoadPending.current = true;
      void loadOlderRef.current();
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
    scroller.addEventListener('wheel', onWheel, { passive: true });

    return () => {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onWheel);
      window.clearTimeout(idleTimer);
      io?.disconnect();
    };
  }, [lockTailToEnd, scheduleTailLockSettle, scrollRef, virtualizer]);

  // Jump-to-search-hit: center the target row and pulse-highlight it.
  useEffect(() => {
    if (!targetMessageId) {
      appliedTargetRef.current = null;
      return;
    }
    const index = messages.findIndex((message) => message.id === targetMessageId);
    if (index < 0) return;
    const targetKey = `${threadId}:${targetMessageId}`;
    if (appliedTargetRef.current === targetKey) return;
    appliedTargetRef.current = targetKey;
    setHighlightedId(targetMessageId);
    suppressProgrammaticAutoLoad();
    const centerTarget = () => {
      virtualizer.scrollToIndex(index, { align: 'center' });
      const targetEl = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
        .find((el) => el.dataset.messageId === targetMessageId);
      targetEl?.scrollIntoView({ behavior: 'auto', block: 'center' });
    };
    centerTarget();
    let frame2 = 0;
    const frame1 = requestAnimationFrame(() => {
      centerTarget();
      frame2 = requestAnimationFrame(centerTarget);
    });
    const timer = window.setTimeout(() => setHighlightedId((current) => (current === targetMessageId ? null : current)), 1800);
    return () => {
      cancelAnimationFrame(frame1);
      if (frame2) cancelAnimationFrame(frame2);
      window.clearTimeout(timer);
    };
  }, [messages, targetMessageId, threadId, scrollRef, virtualizer]);

  return (
    <>
      {/* 축2: sticky 날짜 pill — 현재 보는 영역의 날짜를 상단에 고정 표시. */}
      {!isTailSettling && topDateLabel ? (
        <div className={s.stickyDate} aria-hidden="true">
          <span className={s.stickyDatePill}>{topDateLabel}</span>
        </div>
      ) : null}
      <div ref={topSentinelRef} className={s.scrollSentinel} aria-hidden="true" />
      {/* Top loading / end-of-history affordance (A6). G2: only surfaced when the
          older-page load exceeds 400ms — fast prefetches stay silent. */}
      {!isTailSettling && showOlderLoading ? (
        <div className={s.loadEdge}>
          <span className={s.sp} /> 이전 대화 불러오는 중…
        </div>
      ) : !isTailSettling && olderError ? (
        <button type="button" className={`${s.loadRetry} cwTap`} onClick={() => void loadOlderRef.current()}>
          <Icon name="retry" size="xs" decorative /> 이전 대화를 불러오지 못했어요. 다시 시도
        </button>
      ) : !isTailSettling && !hasOlder && messages.length > 0 ? (
        <div className={s.loadEnd}>대화의 시작이에요</div>
      ) : null}

      <div className={`${s.virtualCanvas} ${isTailSettling ? s.tailSettling : ''}`} style={{ height: totalSize }}>
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
              data-message-id={message.id}
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
      {!isTailSettling && showNewerLoading ? (
        <div className={s.loadEdge}>
          <span className={s.sp} /> 이후 대화 불러오는 중…
        </div>
      ) : !isTailSettling && newerError ? (
        <button type="button" className={`${s.loadRetry} cwTap`} onClick={() => void loadNewerRef.current()}>
          <Icon name="retry" size="xs" decorative /> 이후 대화를 불러오지 못했어요. 다시 시도
        </button>
      ) : !isTailSettling && hasNewer && !isLoadingNewer ? (
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
