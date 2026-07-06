import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatStreamUsage, MessageSearchHit } from '@consulting/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/useAuth';
import { useToast } from '../../../shared/ui/toast/Toast';
import { activeThreadStore } from '../../../lib/threadCtx';
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
import { VirtualMessageStream } from './VirtualMessageStream';
import { Icon } from '../../../shared/icons/Icon';
import { Button } from '../../../shared/ui/button/Button';
import { Textarea } from '../../../shared/ui/input/Input';
import { EmptyState, Spinner } from '../../../shared/ui/feedback/EmptyState';
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

interface RunStatusUi {
  runId?: string;
  model?: string;
  contextLimit?: number;
  usage?: ChatStreamUsage;
  startedAt: number;
  finishedAt?: number;
  state: 'running' | 'done' | 'error';
  reasoning?: boolean;
  reasoningText?: string;
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

function fmtTokens(tokens?: number): string {
  if (tokens === undefined) return 'tok 대기';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function contextPercent(usage?: ChatStreamUsage, contextLimit?: number): number | null {
  if (!usage?.totalTokens || !contextLimit) return null;
  return Math.min(100, Math.round((usage.totalTokens / contextLimit) * 100));
}


/**
 * Live chat for a thread (persistent). History loads from the API; new sends
 * stream via SSE and are persisted server-side. Craft layer (U-2):
 * ThinkingRibbon fills the start→first-delta gap (now with REAL tool labels,
 * Phase 2-A), ConvoMinimap maps long threads, hover actions add copy/retry,
 * hover on assistant messages glows the linked evidence (E-4), and answers
 * can be saved as artifacts (2-B) with file attachments (2-D G-3).
 */
export function ChatThread({ threadId, title }: { threadId: string; title: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const workspaceId = useSelectedWorkspace();
  const { data: tree } = useWorkspaceTree(workspaceId ?? undefined);
  const history = useMessageWindow(threadId);
  const attachments = useAttachments(threadId);
  const uploadAttachment = useUploadAttachment(threadId);

  const [live, setLive] = useState<LiveTurn[]>([]);
  const [input, setInput] = useState('');
  const [slashCursor, setSlashCursor] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MessageSearchHit[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatusUi | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const lastPromptRef = useRef<string>('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Register this thread as the active context (evidence panel target).
  useEffect(() => {
    activeThreadStore.set(threadId);
    return () => activeThreadStore.set(null);
  }, [threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [live]);

  useEffect(() => {
    setLive([]);
    abortRef.current?.abort();
    setBusy(false);
    setActiveTool(null);
    setSlashCursor(0);
    setSearchQuery('');
    setSearchResults([]);
    setSearchOpen(false);
    setSearching(false);
    setTargetMessageId(null);
    setRunStatus(null);
  }, [threadId]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  function patchTurn(id: number, patch: Partial<LiveTurn>) {
    setLive((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function send(messageOverride?: string) {
    const message = (messageOverride ?? input).trim();
    if (!message || busy) return;
    if (!messageOverride) setInput('');
    lastPromptRef.current = message;
    setBusy(true);
    setNowTs(Date.now());
    setRunStatus({ startedAt: Date.now(), state: 'running' });
    setActiveTool(null);

    const userTurn: LiveTurn = { id: nextId.current++, role: 'user', text: message };
    const aiTurn: LiveTurn = { id: nextId.current++, role: 'ai', text: '', streaming: true };
    setLive((prev) => [...prev, userTurn, aiTurn]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let acc = '';
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
          acc += event.text;
          setActiveTool(null);
          patchTurn(aiTurn.id, { text: acc });
        } else if (event.type === 'done') {
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
          patchTurn(aiTurn.id, { streaming: false, error: event.message });
          setRunStatus((prev) => ({
            ...(prev ?? { startedAt: Date.now(), state: 'error' as const }),
            finishedAt: Date.now(),
            state: 'error',
          }));
          toast('error', '응답 생성 실패');
        }
      }
      patchTurn(aiTurn.id, { streaming: false });
      setRunStatus((prev) => prev?.state === 'running' ? { ...prev, finishedAt: Date.now(), state: 'done' } : prev);
    } catch {
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
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }
    setSearching(true);
    try {
      const res = await api.searchMessages(threadId, { q, limit: 8 });
      setSearchResults(res.results);
      setSearchOpen(true);
    } catch {
      toast('error', '대화 검색에 실패했어요.');
    } finally {
      setSearching(false);
    }
  }

  async function jumpToSearchHit(hit: MessageSearchHit) {
    try {
      const target = await history.jumpAround(hit.id);
      setTargetMessageId(target);
      setSearchOpen(false);
    } catch {
      toast('error', '검색 위치로 이동하지 못했어요.');
    }
  }

  function jumpTo(key: string) {
    const el = streamRef.current?.querySelector(`[data-turn="${key}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const userName = user?.displayName ?? '나';
  const persisted = history.messages;
  const files = attachments.data?.attachments ?? [];

  const slashQuery = input.startsWith('/') && !input.includes('\n') ? input.slice(1).trim().toLocaleLowerCase() : '';
  const showSlashMenu = input.startsWith('/') && !input.includes('\n');
  const slashItems = useMemo(() => {
    if (!showSlashMenu) return [];
    const items = HERMES_SLASH_COMMANDS.filter((item) => {
      if (!slashQuery) return true;
      return item.command.slice(1).includes(slashQuery) || item.title.toLocaleLowerCase().includes(slashQuery);
    });
    return items.slice(0, 7);
  }, [showSlashMenu, slashQuery]);

  useEffect(() => setSlashCursor(0), [slashQuery]);

  const currentUsage = runStatus?.usage;
  const currentContextLimit = runStatus?.contextLimit ?? currentUsage?.contextLimit;
  const runPct = contextPercent(currentUsage, currentContextLimit);
  const runMeterWidth = runPct ?? (runStatus?.state === 'running' ? 18 : 0);
  const runElapsedMs = runStatus ? (runStatus.finishedAt ?? nowTs) - runStatus.startedAt : 0;
  const runStateClass = runStatus?.state === 'error'
    ? s.runStatusError
    : runStatus?.state === 'done'
      ? s.runStatusDone
      : s.runStatusRunning;
  const runStateLabel = runStatus?.state === 'error' ? 'error' : runStatus?.state === 'done' ? 'done' : 'running';

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
        <div>
          <div className={s.title}>{title}</div>
        </div>
        <div className={s.right}>
          <div className={s.threadSearch}>
            <Icon name="command" size="xs" decorative />
            <input
              className={s.threadSearchInput}
              value={searchQuery}
              placeholder="대화 검색"
              onChange={(event) => {
                setSearchQuery(event.target.value);
                if (!event.target.value.trim()) {
                  setSearchResults([]);
                  setSearchOpen(false);
                }
              }}
              onFocus={() => searchResults.length > 0 && setSearchOpen(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void searchTranscript();
                }
                if (event.key === 'Escape') setSearchOpen(false);
              }}
            />
            <button
              type="button"
              className={s.threadSearchBtn}
              disabled={searching || history.isJumping}
              onClick={() => void searchTranscript()}
            >
              {searching ? '검색 중' : '검색'}
            </button>
            {searchOpen ? (
              <div className={s.searchResults}>
                {searchResults.length === 0 ? (
                  <div className={s.searchEmpty}>검색 결과가 없어요</div>
                ) : searchResults.map((hit) => (
                  <button key={hit.id} type="button" className={s.searchHit} onClick={() => void jumpToSearchHit(hit)}>
                    <span className={s.searchHitRole}>{hit.role === 'assistant' ? '지구' : userName}</span>
                    <span className={s.searchHitText}>{hit.snippet}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {runStatus ? (
            <div className={`${s.runStatus} ${runStateClass}`} title={runStatus.runId ?? 'Hermes run'}>
              <span className={s.runStateDot} />
              <span className={s.runModel}>{runStatus.model ?? 'Hermes'}</span>
              <span className={s.runSep}>│</span>
              <span>{fmtTokens(currentUsage?.totalTokens)} / {currentContextLimit ? fmtTokens(currentContextLimit) : 'limit n/a'}</span>
              <span className={s.runMeter} aria-label="context usage">
                <span style={{ width: `${runMeterWidth}%` }} />
              </span>
              <span>{runPct === null ? 'n/a' : `${runPct}%`}</span>
              <span className={s.runSep}>│</span>
              <span>⏱ {fmtElapsed(runElapsedMs)}</span>
              <span className={s.runSep}>│</span>
              <span>{runStatus.reasoning ? 'reasoning on' : 'reasoning 대기'}</span>
              <span className={s.runSep}>│</span>
              <span>{runStateLabel}</span>
            </div>
          ) : null}
          {busy || history.isJumping ? (
            <div className={s.statusChip}>
              <span className={s.pulse} /> {history.isJumping ? '검색 위치 이동 중' : activeTool ? `${activeTool} 실행 중` : '응답 생성 중'}
            </div>
          ) : null}
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className={s.stream} ref={streamRef} style={{ flex: 1 }}>
          {history.isLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[0.9, 0.6, 0.75].map((w, i) => (
                <div key={i} className={s.skelMsg} style={{ width: `${w * 100}%` }} />
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
            targetMessageId={targetMessageId}
            onLoadOlder={history.loadOlder}
            onLoadNewer={history.loadNewer}
            onCopy={copyText}
            onSaveArtifact={saveAsArtifact}
            onRetry={send}
            onRetryLast={() => send(lastPromptRef.current)}
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
