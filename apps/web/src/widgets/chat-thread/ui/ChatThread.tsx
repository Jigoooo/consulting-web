import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/useAuth';
import { useToast } from '../../../shared/ui/toast/Toast';
import { activeThreadStore, hoveredMessageStore } from '../../../lib/threadCtx';
import { useSelectedWorkspace } from '../../../lib/wsStore';
import { useWorkspaceTree } from '../../../lib/spaces';
import {
  collabKeys,
  useAttachments,
  useUploadAttachment,
  fileToBase64,
  saveAttachment,
} from '../../../lib/collab';
import { Markdown } from '../../../shared/ui/markdown/Markdown';
import { ThinkingRibbon } from './ThinkingRibbon';
import { ConvoMinimap, type MinimapEntry } from './ConvoMinimap';
import { Icon } from '../../../shared/icons/Icon';
import { IconButton, Button } from '../../../shared/ui/button/Button';
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
export function ChatThread({ threadId, title }: { threadId: string; title: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const workspaceId = useSelectedWorkspace();
  const { data: tree } = useWorkspaceTree(workspaceId ?? undefined);
  const history = useQuery({
    queryKey: ['messages', threadId],
    queryFn: () => api.listMessages(threadId),
  });
  const attachments = useAttachments(threadId);
  const uploadAttachment = useUploadAttachment(threadId);

  const [live, setLive] = useState<LiveTurn[]>([]);
  const [input, setInput] = useState('');
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
  }, [live, history.data]);

  useEffect(() => {
    setLive([]);
    abortRef.current?.abort();
    setBusy(false);
    setActiveTool(null);
  }, [threadId]);

  function patchTurn(id: number, patch: Partial<LiveTurn>) {
    setLive((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function send(messageOverride?: string) {
    const message = (messageOverride ?? input).trim();
    if (!message || busy) return;
    if (!messageOverride) setInput('');
    lastPromptRef.current = message;
    setBusy(true);
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
        } else if (event.type === 'tool') {
          // Phase 2-A: surface real tool activity in the ribbon.
          setActiveTool(event.phase === 'started' ? event.tool : null);
        } else if (event.type === 'delta') {
          acc += event.text;
          setActiveTool(null);
          patchTurn(aiTurn.id, { text: acc });
        } else if (event.type === 'done') {
          patchTurn(aiTurn.id, { streaming: false });
        } else if (event.type === 'error') {
          patchTurn(aiTurn.id, { streaming: false, error: event.message });
          toast('error', '응답 생성 실패');
        }
      }
      patchTurn(aiTurn.id, { streaming: false });
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
      void qc.invalidateQueries({ queryKey: ['messages', threadId], refetchType: 'none' });
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

  function jumpTo(key: string) {
    const el = streamRef.current?.querySelector(`[data-turn="${key}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const userName = user?.displayName ?? '나';
  const persisted = history.data?.messages ?? [];
  const files = attachments.data?.attachments ?? [];

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
          {busy ? (
            <div className={s.statusChip}>
              <span className={s.pulse} /> 응답 생성 중
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

          {persisted.map((m) => (
            <div
              key={m.id}
              className={`${s.msg} ${s.msgHover}`}
              data-turn={`p-${m.id}`}
              onMouseEnter={() => m.role === 'assistant' && hoveredMessageStore.set(m.id)}
              onMouseLeave={() => m.role === 'assistant' && hoveredMessageStore.set(null)}
            >
              <div className={`${s.avatar} ${m.role === 'user' ? s.avatarUser : s.avatarAi}`}>
                {m.role === 'user' ? (m.authorName ?? userName).slice(0, 1) : <Icon name="bot" size="sm" decorative />}
              </div>
              <div className={s.body}>
                <div className={s.meta}>
                  <span className={s.who}>{m.role === 'user' ? (m.authorName ?? userName) : '지구'}</span>
                  <span className={s.time}>
                    {new Date(m.createdAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                  {m.runId ? <span className={s.runid}>{m.runId.slice(0, 12)}…</span> : null}
                  <span className={s.msgActions}>
                    <IconButton type="button" className={s.msgActionBtn} label="복사" icon="copy" onClick={() => void copyText(m.content)} />
                    {m.role === 'assistant' && m.content ? (
                      <IconButton
                        type="button"
                        className={s.msgActionBtn}
                        label="산출물로 저장"
                        icon="download"
                        onClick={() => void saveAsArtifact(m.content, m.id)}
                      />
                    ) : null}
                    {m.role === 'user' ? (
                      <IconButton
                        type="button"
                        className={s.msgActionBtn}
                        label="다시 질문"
                        icon="retry"
                        disabled={busy}
                        onClick={() => void send(m.content)}
                      />
                    ) : null}
                  </span>
                </div>
                {m.role === 'assistant' ? <Markdown text={m.content} /> : <div className={s.text}>{m.content}</div>}
                {m.finishState === 'error' ? (
                  <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--red)' }}>이 응답은 오류로 중단되었어요.</div>
                ) : null}
                {m.finishState === 'cancelled' ? (
                  <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>중단된 응답</div>
                ) : null}
              </div>
            </div>
          ))}

          {live.map((t) => (
            <div key={`live-${t.id}`} className={`${s.msg} ${s.msgHover}`} data-turn={`l-${t.id}`}>
              <div className={`${s.avatar} ${t.role === 'user' ? s.avatarUser : s.avatarAi}`}>
                {t.role === 'user' ? userName.slice(0, 1) : <Icon name="bot" size="sm" decorative />}
              </div>
              <div className={s.body}>
                <div className={s.meta}>
                  <span className={s.who}>{t.role === 'user' ? userName : '지구'}</span>
                  {t.runId ? <span className={s.runid}>{t.runId.slice(0, 12)}…</span> : null}
                  {!t.streaming && t.text ? (
                    <span className={s.msgActions}>
                      <IconButton type="button" className={s.msgActionBtn} label="복사" icon="copy" onClick={() => void copyText(t.text)} />
                      {t.role === 'ai' ? (
                        <IconButton
                          type="button"
                          className={s.msgActionBtn}
                          label="산출물로 저장"
                          icon="download"
                          onClick={() => void saveAsArtifact(t.text)}
                        />
                      ) : null}
                    </span>
                  ) : null}
                </div>
                {t.role === 'ai' ? (
                  t.text ? (
                    <div>
                      <Markdown text={t.text} />
                      {t.streaming ? <span className={s.cursor} /> : null}
                    </div>
                  ) : t.streaming ? (
                    <ThinkingRibbon tool={activeTool} />
                  ) : null
                ) : (
                  <div className={s.text}>{t.text}</div>
                )}
                {t.error ? (
                  <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--red)', display: 'flex', gap: 10, alignItems: 'center' }}>
                    {t.error}
                    {!busy && lastPromptRef.current ? (
                      <button
                        type="button"
                        className={s.retryBtn}
                        onClick={() => void send(lastPromptRef.current)}
                      >
                        <Icon name="retry" size="xs" decorative /> 다시 시도
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
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
        <div className={s.box}>
          <div className={s.boxTop}>
            <Textarea
              className={s.textarea}
              rows={1}
              value={input}
              placeholder="메시지를 입력하세요…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
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
