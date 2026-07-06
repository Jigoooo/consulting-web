import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/useAuth';
import { useToast } from '../../../shared/ui/toast/Toast';
import { activeThreadStore, useTailScrollRequest } from '../../../lib/threadCtx';
import { useSelectedWorkspace } from '../../../lib/wsStore';
import { useWorkspaceTree } from '../../../lib/spaces';
import {
  collabKeys,
  useAttachments,
  useUploadAttachment,
  fileToBase64,
  saveAttachment,
} from '../../../lib/collab';
import { ConvoMinimap, type MinimapEntry } from './ConvoMinimap';
import { messageWindowKeys, useMessageWindow } from '../model/useMessageWindow';
import { searchStore, useSearchState } from '../model/searchStore';
import { VirtualMessageStream, type HighlightState } from './VirtualMessageStream';
import { RunStatusBar, type RunStatusUi } from './RunStatusBar';
import { JumpToLatest } from './JumpToLatest';
import { Icon } from '../../../shared/icons/Icon';
import { Button } from '../../../shared/ui/button/Button';
import { Textarea } from '../../../shared/ui/input/Input';
import { EmptyState, Spinner } from '../../../shared/ui/feedback/EmptyState';
import { SkeletonMessage } from '../../../shared/ui/skeleton/Skeleton';
import { useDelayedFlag } from '../../../shared/lib/useDelayedFlag';
import s from '../../thread-view/ui/ThreadView.module.css';

interface LiveTurn {
  id: number;
  role: 'user' | 'ai';
  text: string;
  runId?: string;
  streaming?: boolean;
  error?: string;
}

interface SlashCommandItem {
  command: string;
  value: string;
  title: string;
  hint: string;
}

interface ThreadBreadcrumb {
  projectName: string;
  channelName: string;
  topicName: string;
}

const HERMES_SLASH_COMMANDS: SlashCommandItem[] = [
  { command: '/help', value: '/help', title: '도움말', hint: 'Hermes가 지원하는 slash 명령 안내' },
  { command: '/commands', value: '/commands', title: '명령 목록', hint: 'gateway/CLI 명령 목록을 조회' },
  { command: '/usage', value: '/usage', title: '사용량', hint: '토큰/사용량 정보가 지원되면 표시' },
  { command: '/status', value: '/status', title: '세션 상태', hint: '현재 Hermes 세션 상태 확인' },
  { command: '/model', value: '/model', title: '모델 확인', hint: '현재 모델 또는 모델 변경 명령' },
  { command: '/reasoning', value: '/reasoning show', title: 'Reasoning 표시', hint: 'reasoning 표시 상태를 확인/변경' },
  { command: '/verbose', value: '/verbose', title: '진행 상세도', hint: '도구/진행 표시 레벨 전환' },
  { command: '/skills', value: '/skills', title: '스킬', hint: '사용 가능한 Hermes skills 조회' },
  { command: '/tools', value: '/tools', title: '도구', hint: '도구/툴셋 상태 조회' },
];

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}


/**
 * Live chat for a thread (persistent). History loads from the API; new sends
 * stream via SSE and are persisted server-side. Craft layer (U-2):
 * ThinkingRibbon fills the start→first-delta gap (now with REAL tool labels,
 * Phase 2-A), ConvoMinimap maps long threads, hover actions add copy/retry,
 * hover on assistant messages glows the linked evidence (E-4), and answers
 * can be saved as artifacts (2-B) with file attachments (2-D G-3).
 */
export function ChatThread({ threadId, title, breadcrumb }: { threadId: string; title: string; breadcrumb?: ThreadBreadcrumb }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const workspaceId = useSelectedWorkspace();
  const { data: tree } = useWorkspaceTree(workspaceId ?? undefined);
  const history = useMessageWindow(threadId);
  const tailScrollRequest = useTailScrollRequest();
  const attachments = useAttachments(threadId);
  const uploadAttachment = useUploadAttachment(threadId);
  const search = useSearchState();

  const [live, setLive] = useState<LiveTurn[]>([]);
  const [input, setInput] = useState('');
  const [slashCursor, setSlashCursor] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatusUi | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const lastPromptRef = useRef<string>('');
  const atBottomRef = useRef(true);
  const deltaBuf = useRef('');
  const rafId = useRef(0);
  const latestJumpRef = useRef<() => Promise<void>>(async () => {});
  const seenTailScrollRequest = useRef(tailScrollRequest);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // G9: paste/newline auto-grow. Height changes are batched in rAF so typing
  // does one layout read/write pair, capped at 10 readable rows.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const id = window.requestAnimationFrame(() => {
      const style = window.getComputedStyle(el);
      const lineHeight = Number.parseFloat(style.lineHeight) || 24;
      const maxHeight = lineHeight * 10;
      el.style.height = 'auto';
      const nextHeight = Math.min(el.scrollHeight, maxHeight);
      el.style.height = `${nextHeight}px`;
      el.style.overflowY = el.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden';
    });
    return () => window.cancelAnimationFrame(id);
  }, [input]);

  // Register this thread as the active context (evidence panel target).
  useEffect(() => {
    activeThreadStore.set(threadId);
    return () => activeThreadStore.set(null);
  }, [threadId]);

  // A1: only follow new live output when the user is already at the tail.
  useEffect(() => {
    if (!atBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [live]);

  useEffect(() => {
    setLive([]);
    abortRef.current?.abort();
    setBusy(false);
    setActiveTool(null);
    setSlashCursor(0);
    setSearchQuery('');
    setSearching(false);
    setTargetMessageId(null);
    setRunStatus(null);
    setUnseen(0);
    setAtBottom(true);
    atBottomRef.current = true;
    searchStore.reset(threadId);
  }, [threadId]);

  function onAtBottomChange(next: boolean) {
    atBottomRef.current = next;
    setAtBottom(next);
    if (next) setUnseen(0);
  }

  // F3: when the focused search result changes (e.g. clicked in the right panel
  // or stepped via the navigator), jump the chat window to that message.
  const lastFocusedId = useRef<string | null>(null);
  // G6: prefer focusMessage — it scrolls in place when the hit is already loaded
  // (no window replacement → no layout shift) and only fetches an 'around' window
  // when the target is outside the loaded range.
  const focusMessageRef = useRef(history.focusMessage);
  focusMessageRef.current = history.focusMessage;
  useEffect(() => {
    if (search.threadId !== threadId) return;
    const hit = search.results[search.focusedIndex];
    if (!hit || hit.id === lastFocusedId.current) return;
    lastFocusedId.current = hit.id;
    void focusMessageRef.current(hit.id).then((target) => setTargetMessageId(target)).catch(() => {});
  }, [search.focusedIndex, search.results, search.threadId, threadId]);

  function patchTurn(id: number, patch: Partial<LiveTurn>) {
    setLive((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function send(messageOverride?: string) {
    const message = (messageOverride ?? input).trim();
    if (!message || busy) return;
    if (!messageOverride) setInput('');
    lastPromptRef.current = message;
    setBusy(true);
    setRunStatus({ startedAt: Date.now(), state: 'running' });
    setActiveTool(null);
    // sending pins us to the tail
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);

    const userTurn: LiveTurn = { id: nextId.current++, role: 'user', text: message };
    const aiTurn: LiveTurn = { id: nextId.current++, role: 'ai', text: '', streaming: true };
    setLive((prev) => [...prev, userTurn, aiTurn]);

    const controller = new AbortController();
    abortRef.current = controller;
    // A4: batch SSE deltas into one patch per animation frame instead of one
    // setState per token (was tens of re-renders/sec on the whole thread).
    let acc = '';
    const flush = () => {
      rafId.current = 0;
      if (!deltaBuf.current) return;
      acc += deltaBuf.current;
      deltaBuf.current = '';
      patchTurn(aiTurn.id, { text: acc });
    };
    const scheduleFlush = () => {
      if (!rafId.current) rafId.current = requestAnimationFrame(flush);
    };
    const cancelFlush = () => {
      if (rafId.current) {
        cancelAnimationFrame(rafId.current);
        rafId.current = 0;
      }
      flush();
    };
    try {
      for await (const event of api.streamChat({ threadId, message }, controller.signal)) {
        if (event.type === 'start') {
          patchTurn(aiTurn.id, { runId: event.runId });
          setRunStatus((prev) => {
            const next: RunStatusUi = {
              ...(prev ?? { startedAt: Date.now(), state: 'running' as const }),
              runId: event.runId,
              state: 'running',
            };
            if (event.model) next.model = event.model;
            if (event.contextLimit) next.contextLimit = event.contextLimit;
            return next;
          });
        } else if (event.type === 'tool') {
          // Phase 2-A: surface real tool activity in the ribbon.
          setActiveTool(event.phase === 'started' ? event.tool : null);
        } else if (event.type === 'reasoning') {
          setRunStatus((prev) => ({
            ...(prev ?? { startedAt: Date.now(), state: 'running' as const }),
            runId: event.runId,
            reasoning: true,
            reasoningText: event.text,
            state: 'running',
          }));
        } else if (event.type === 'delta') {
          deltaBuf.current += event.text;
          setActiveTool(null);
          scheduleFlush();
        } else if (event.type === 'done') {
          cancelFlush();
          patchTurn(aiTurn.id, { streaming: false });
          setRunStatus((prev) => {
            const next: RunStatusUi = {
              ...(prev ?? { startedAt: Date.now(), state: 'done' as const }),
              runId: event.runId,
              finishedAt: Date.now(),
              state: 'done',
            };
            const usage = event.usage ?? prev?.usage;
            if (usage) next.usage = usage;
            return next;
          });
        } else if (event.type === 'error') {
          cancelFlush();
          patchTurn(aiTurn.id, { streaming: false, error: event.message });
          setRunStatus((prev) => ({
            ...(prev ?? { startedAt: Date.now(), state: 'error' as const }),
            finishedAt: Date.now(),
            state: 'error',
          }));
          toast('error', '응답 생성 실패');
        }
      }
      cancelFlush();
      patchTurn(aiTurn.id, { streaming: false });
      setRunStatus((prev) => prev?.state === 'running' ? { ...prev, finishedAt: Date.now(), state: 'done' } : prev);
      // A2: if the user scrolled away during the answer, surface an unseen count.
      if (!atBottomRef.current) setUnseen((n) => n + 1);
    } catch {
      cancelFlush();
      if (controller.signal.aborted) {
        patchTurn(aiTurn.id, { streaming: false, error: '중단됨' });
      } else {
        patchTurn(aiTurn.id, { streaming: false, error: '응답을 가져오지 못했어요. 다시 시도해주세요.' });
        toast('error', '연결에 문제가 있어요. 잠시 후 다시 시도해주세요.');
      }
    } finally {
      setBusy(false);
      setActiveTool(null);
      abortRef.current = null;
      void qc.invalidateQueries({ queryKey: messageWindowKeys.latest(threadId), refetchType: 'none' });
      // Evidence rows settle with the assistant message — refresh the panel.
      void qc.invalidateQueries({ queryKey: collabKeys.evidence(threadId) });
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast('success', '복사 완료');
    } catch {
      toast('error', '복사 실패');
    }
  }

  /** 2-B: save an assistant answer as a v1 artifact in the first project. */
  async function saveAsArtifact(content: string, messageId?: string) {
    const projectId = tree?.projects[0]?.id;
    if (!projectId) {
      toast('error', '산출물을 담을 프로젝트가 없어요. 먼저 프로젝트를 만들어주세요.');
      return;
    }
    const artifactTitle = window.prompt('산출물 제목을 입력하세요', `${title} — 지구 답변`);
    if (!artifactTitle?.trim()) return;
    try {
      const res = await api.createArtifact({
        projectId,
        title: artifactTitle.trim(),
        content,
        note: '채팅에서 저장',
        sourceThreadId: threadId,
        ...(messageId ? { sourceMessageId: messageId } : {}),
      });
      void qc.invalidateQueries({ queryKey: collabKeys.artifacts(workspaceId ?? '') });
      toast('success', '산출물 저장 완료');
      void navigate({ to: '/artifacts' });
      void res;
    } catch {
      toast('error', '저장에 실패했어요. 편집 권한이 있는지 확인해주세요.');
    }
  }

  /** 2-D G-3: attach a file to this thread. */
  async function onPickFile(file: File | null) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast('error', '파일은 10MB 이하만 첨부할 수 있어요.');
      return;
    }
    try {
      const dataBase64 = await fileToBase64(file);
      await uploadAttachment.mutateAsync({
        threadId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
      });
      toast('success', `첨부 완료: ${file.name}`);
    } catch {
      toast('error', '첨부에 실패했어요. 이미지/PDF/텍스트만 지원해요.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function searchTranscript() {
    const q = searchQuery.trim();
    if (!q) {
      searchStore.set({ query: '', results: [], focusedIndex: -1, open: false });
      return;
    }
    setSearching(true);
    try {
      // F2: server does hangul-aware matching; ask for a generous result set so
      // the navigator + right-panel list are complete.
      const res = await api.searchMessages(threadId, { q, limit: 50 });
      // Setting focusedIndex to 0 triggers the focus effect → jumps to first hit.
      lastFocusedId.current = null;
      searchStore.set({ threadId, query: q, results: res.results, focusedIndex: res.results.length > 0 ? 0 : -1, open: true });
    } catch {
      toast('error', '대화 검색에 실패했어요.');
    } finally {
      setSearching(false);
    }
  }

  function jumpToSearchHit(hit: { id: string }, index: number) {
    // Set focus index; the focusedIndex effect performs the actual jumpAround so
    // navigator / panel / this path all funnel through one code path (F3).
    searchStore.focusIndex(index);
    void hit;
  }

  // F3: result navigator — step to previous/next hit, wrapping around.
  function stepSearch(dir: 1 | -1) {
    const st = searchStore.get();
    if (st.results.length === 0) return;
    const nextIndex = st.focusedIndex + dir;
    const hit = st.results[((nextIndex % st.results.length) + st.results.length) % st.results.length];
    if (hit) void jumpToSearchHit(hit, nextIndex);
  }

  function jumpTo(key: string) {
    const el = streamRef.current?.querySelector(`[data-turn="${key}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // A2 / G7-FAB: return to the live tail. From a search-jump ('around') window we
  // replace the window with the latest page in O(1) instead of paging down. A
  // re-entrancy guard makes rapid FAB taps a no-op while a jump is in flight, and
  // any active search state is cleared first so the tail isn't left highlighted.
  const jumpingToLatestRef = useRef(false);
  async function jumpToLatest() {
    if (jumpingToLatestRef.current) return;
    jumpingToLatestRef.current = true;
    try {
      // clear search first so the FAB always lands on the clean live tail
      if (search.query) {
        searchStore.reset(threadId);
        setSearchQuery('');
        setTargetMessageId(null);
      }
      if (history.mode === 'around' || history.hasNewer) {
        await history.resetToLatest();
      }
      atBottomRef.current = true;
      setAtBottom(true);
      setUnseen(0);
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' }));
    } finally {
      jumpingToLatestRef.current = false;
    }
  }
  latestJumpRef.current = jumpToLatest;

  useEffect(() => {
    if (tailScrollRequest === seenTailScrollRequest.current) return;
    seenTailScrollRequest.current = tailScrollRequest;
    void latestJumpRef.current();
  }, [tailScrollRequest]);

  const userName = user?.displayName ?? '나';
  const persisted = history.messages;
  const files = attachments.data?.attachments ?? [];

  const slashQuery = input.startsWith('/') && !input.includes('\n') ? input.slice(1).trim().toLocaleLowerCase() : '';
  const showSlashMenu = input.startsWith('/') && !input.includes('\n');
  // D1: defer the filter query so typing the command never janks the menu.
  const deferredSlashQuery = useDeferredValue(slashQuery);
  const slashItems = !showSlashMenu
    ? []
    : HERMES_SLASH_COMMANDS.filter((item) => {
        if (!deferredSlashQuery) return true;
        return item.command.slice(1).includes(deferredSlashQuery) || item.title.toLocaleLowerCase().includes(deferredSlashQuery);
      }).slice(0, 7);

  useEffect(() => setSlashCursor(0), [slashQuery]);

  // F3: build the highlight set for the stream from the shared search state.
  const highlight: HighlightState | null = search.query && search.threadId === threadId
    ? {
        ids: new Set(search.results.map((r) => r.id)),
        query: search.query,
        focusedId: search.results[search.focusedIndex]?.id ?? null,
      }
    : null;

  // 300ms 이후에도 최초 로딩이면 스켈레톤 노출 — 즉시 로드는 깜빡임 없이 통과.
  const showHistorySkeleton = useDelayedFlag(history.isLoading, 300);
  const hasResults = search.results.length > 0 && search.threadId === threadId;

  const minimapEntries: MinimapEntry[] = [
    ...persisted.map((m) => ({
      key: `p-${m.id}`,
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      preview: m.content.slice(0, 60),
    })),
    ...live.map((t) => ({
      key: `l-${t.id}`,
      role: t.role === 'ai' ? ('assistant' as const) : ('user' as const),
      preview: t.text.slice(0, 60),
    })),
  ];

  return (
    <>
      <div className={s.head}>
        <div className={s.headTitleBlock}>
          {breadcrumb ? (
            <>
              <div className={s.crumb}>{breadcrumb.projectName}</div>
              <div className={s.title}>{breadcrumb.channelName}</div>
              {breadcrumb.topicName &&
                breadcrumb.topicName !== '대화' &&
                breadcrumb.topicName !== breadcrumb.channelName && (
                  <div className={s.subTitle}>{breadcrumb.topicName}</div>
                )}
            </>
          ) : (
            <div className={s.title}>{title}</div>
          )}
        </div>
        <div className={s.right}>
          <div className={s.threadSearch}>
            <Icon name="search" size="xs" decorative />
            <input
              className={s.threadSearchInput}
              value={searchQuery}
              placeholder="대화 검색 (초성·띄어쓰기 무시)"
              onChange={(event) => {
                setSearchQuery(event.target.value);
                if (!event.target.value.trim()) {
                  searchStore.set({ query: '', results: [], focusedIndex: -1, open: false });
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (hasResults && search.query === searchQuery.trim()) {
                    // already searched → Enter steps to next hit (Ctrl+F feel)
                    stepSearch(event.shiftKey ? -1 : 1);
                  } else {
                    void searchTranscript();
                  }
                }
                if (event.key === 'Escape') event.currentTarget.blur();
              }}
            />
            {hasResults ? (
              <div className={s.searchNav}>
                <button type="button" className={`${s.searchNavBtn} cwTap`} aria-label="이전 결과" onClick={() => stepSearch(-1)}>
                  <Icon name="chevron-left" size="xs" decorative />
                </button>
                <span className={s.searchNavCount}>
                  {search.focusedIndex + 1} / {search.results.length}
                </span>
                <button type="button" className={`${s.searchNavBtn} cwTap`} aria-label="다음 결과" onClick={() => stepSearch(1)}>
                  <Icon name="chevron-right" size="xs" decorative />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={`${s.threadSearchBtn} cwTap`}
                disabled={searching || history.isJumping}
                onClick={() => void searchTranscript()}
              >
                {searching ? '검색 중' : '검색'}
              </button>
            )}
            {/* G6: header result dropdown removed — the full result list lives in
                the right context panel's "검색" tab (auto-focused on search), so
                results appear in exactly one place. */}
          </div>
          {runStatus ? <RunStatusBar status={runStatus} /> : null}
          {busy || history.isJumping ? (
            <div className={s.statusChip}>
              <span className={s.pulse} /> {history.isJumping ? '위치 이동 중' : activeTool ? `${activeTool} 실행 중` : '응답 생성 중'}
            </div>
          ) : null}
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className={s.stream} ref={streamRef} style={{ flex: 1 }}>
          {showHistorySkeleton ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
              {[0, 1, 2].map((i) => (
                <SkeletonMessage key={i} />
              ))}
            </div>
          ) : null}

          {!history.isLoading && persisted.length === 0 && live.length === 0 ? (
            <EmptyState icon="bot" title="지구에게 물어보세요" description="필요한 맥락을 짧게 남기면 바로 이어서 작업합니다." />
          ) : null}

          <VirtualMessageStream
            messages={persisted}
            live={live}
            userName={userName}
            busy={busy}
            activeTool={activeTool}
            scrollRef={streamRef}
            bottomRef={bottomRef}
            hasOlder={history.hasOlder}
            hasNewer={history.hasNewer}
            isLoadingOlder={history.isLoadingOlder}
            isLoadingNewer={history.isLoadingNewer}
            olderError={history.olderError}
            newerError={history.newerError}
            targetMessageId={targetMessageId}
            highlight={highlight}
            showNewDivider={!atBottom && unseen > 0}
            onLoadOlder={history.loadOlder}
            onLoadNewer={history.loadNewer}
            onAtBottomChange={onAtBottomChange}
            onCopy={copyText}
            onSaveArtifact={saveAsArtifact}
            onRetry={send}
            onRetryLast={() => send(lastPromptRef.current)}
          />
          <JumpToLatest
            visible={!atBottom || history.hasNewer || history.mode === 'around'}
            unseen={unseen}
            streaming={busy}
            onJump={() => void jumpToLatest()}
          />
        </div>
        <ConvoMinimap entries={minimapEntries} onJump={jumpTo} />
      </div>

      <div className={s.composer}>
        {files.length > 0 ? (
          <div className={s.fileStrip}>
            {files.map((f) => (
              <button
                key={f.id}
                type="button"
                className={s.fileChip}
                title={`다운로드 (${fmtSize(f.sizeBytes)})`}
                onClick={() => void saveAttachment(f.id, f.fileName).catch(() => toast('error', '다운로드에 실패했어요.'))}
              >
                <Icon name="paperclip" size="xs" decorative /> {f.fileName} <span className={s.fileSize}>{fmtSize(f.sizeBytes)}</span>
              </button>
            ))}
          </div>
        ) : null}
        {showSlashMenu && slashItems.length > 0 ? (
          <div className={s.slashMenu} role="listbox" aria-label="Hermes slash commands">
            {slashItems.map((item, index) => (
              <button
                key={item.command}
                type="button"
                role="option"
                aria-selected={index === slashCursor}
                className={`${s.slashItem} ${index === slashCursor ? s.slashItemOn : ''}`}
                onMouseEnter={() => setSlashCursor(index)}
                onClick={() => setInput(item.value)}
              >
                <span className={s.slashCmd}>{item.command}</span>
                <span className={s.slashTitle}>{item.title}</span>
                <span className={s.slashHint}>{item.hint}</span>
              </button>
            ))}
            <div className={s.slashFoot}>↑↓ 선택 · Tab/Enter 채우기 · Enter 한 번 더 실행</div>
          </div>
        ) : null}
        <div className={s.box}>
          <div className={s.boxTop}>
            <Textarea
              ref={textareaRef}
              unstyled
              className={s.textarea}
              rows={1}
              value={input}
              placeholder="메시지를 입력하세요…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (showSlashMenu && slashItems.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSlashCursor((cursor) => Math.min(cursor + 1, slashItems.length - 1));
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSlashCursor((cursor) => Math.max(cursor - 1, 0));
                    return;
                  }
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    setInput(slashItems[slashCursor]?.value ?? input);
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey && slashItems[slashCursor] && input.trim() !== slashItems[slashCursor].value) {
                    e.preventDefault();
                    setInput(slashItems[slashCursor].value);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </div>
          <div className={s.bar}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.pdf,.txt,.md,.csv"
              style={{ display: 'none' }}
              onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              className={s.attachBtn}
              title="파일 첨부 (이미지/PDF/텍스트, 10MB 이하)"
              disabled={uploadAttachment.isPending}
              onClick={() => fileRef.current?.click()}
            >
              {uploadAttachment.isPending ? <Spinner label="첨부 중" /> : <Icon name="paperclip" size="sm" decorative />}
            </button>
            <span className={s.hint}>Enter 전송 · Shift+Enter 줄바꿈 · ⌘K 이동</span>
            <div className={s.sendWrap}>
              {busy ? (
                <Button className={`${s.btn} ${s.btnGhost}`} variant="ghost" type="button" leadingIcon="stop" onClick={cancel}>
                  중단
                </Button>
              ) : null}
              <Button
                className={`${s.btn} ${s.btnPrimary}`}
                variant="primary"
                type="button"
                trailingIcon="send"
                disabled={busy || !input.trim()}
                onClick={() => void send()}
              >
                전송
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
