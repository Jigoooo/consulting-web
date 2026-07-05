import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/useAuth';
import { useToast } from '../ui/Toast';
import { Markdown } from './Markdown';
import s from '../thread/ThreadView.module.css';

interface LiveTurn {
  id: number;
  role: 'user' | 'ai';
  text: string;
  runId?: string;
  streaming?: boolean;
  error?: string;
}

/**
 * Live chat for a thread (N-1 persistent). History loads from
 * GET /chat/threads/:id/messages; new sends stream via SSE and are persisted
 * server-side, so a refresh reproduces the full dialogue.
 */
export function ChatThread({ threadId, title }: { threadId: string; title: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const history = useQuery({
    queryKey: ['messages', threadId],
    queryFn: () => api.listMessages(threadId),
  });

  const [live, setLive] = useState<LiveTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [live, history.data]);

  // Reset the live tail when switching threads.
  useEffect(() => {
    setLive([]);
    abortRef.current?.abort();
    setBusy(false);
  }, [threadId]);

  function patchTurn(id: number, patch: Partial<LiveTurn>) {
    setLive((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);

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
        } else if (event.type === 'delta') {
          acc += event.text;
          patchTurn(aiTurn.id, { text: acc });
        } else if (event.type === 'done') {
          patchTurn(aiTurn.id, { streaming: false });
        } else if (event.type === 'error') {
          patchTurn(aiTurn.id, { streaming: false, error: event.message });
          toast('error', '지구 응답 중 문제가 발생했어요.');
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
      abortRef.current = null;
      // Keep the live tail on screen; refresh history in background so a
      // remount shows the persisted copy.
      void qc.invalidateQueries({ queryKey: ['messages', threadId], refetchType: 'none' });
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  const userName = user?.displayName ?? '나';
  const persisted = history.data?.messages ?? [];

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

      <div className={s.stream}>
        {history.isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[0.9, 0.6, 0.75].map((w, i) => (
              <div key={i} className={s.skelMsg} style={{ width: `${w * 100}%` }} />
            ))}
          </div>
        ) : null}

        {!history.isLoading && persisted.length === 0 && live.length === 0 ? (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 34, marginBottom: 10 }}>🌍</div>
            <div style={{ fontSize: 14 }}>지구에게 무엇이든 물어보세요</div>
          </div>
        ) : null}

        {persisted.map((m) => (
          <div key={m.id} className={s.msg}>
            <div className={`${s.avatar} ${m.role === 'user' ? s.avatarUser : s.avatarAi}`}>
              {m.role === 'user' ? (m.authorName ?? userName).slice(0, 1) : '🌍'}
            </div>
            <div className={s.body}>
              <div className={s.meta}>
                <span className={s.who}>{m.role === 'user' ? (m.authorName ?? userName) : '지구'}</span>
                <span className={s.time}>
                  {new Date(m.createdAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}
                </span>
                {m.runId ? <span className={s.runid}>{m.runId.slice(0, 12)}…</span> : null}
              </div>
              {m.role === 'assistant' ? (
                <Markdown text={m.content} />
              ) : (
                <div className={s.text}>{m.content}</div>
              )}
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
          <div key={`live-${t.id}`} className={s.msg}>
            <div className={`${s.avatar} ${t.role === 'user' ? s.avatarUser : s.avatarAi}`}>
              {t.role === 'user' ? userName.slice(0, 1) : '🌍'}
            </div>
            <div className={s.body}>
              <div className={s.meta}>
                <span className={s.who}>{t.role === 'user' ? userName : '지구'}</span>
                {t.runId ? <span className={s.runid}>{t.runId.slice(0, 12)}…</span> : null}
              </div>
              {t.role === 'ai' ? (
                <div>
                  <Markdown text={t.text} />
                  {t.streaming ? <span className={s.cursor} /> : null}
                </div>
              ) : (
                <div className={s.text}>{t.text}</div>
              )}
              {t.error ? <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--red)' }}>{t.error}</div> : null}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className={s.composer}>
        <div className={s.box}>
          <div className={s.boxTop}>
            <textarea
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
            <span className={s.hint}>Enter 전송 · Shift+Enter 줄바꿈</span>
            <div className={s.sendWrap}>
              {busy ? (
                <button className={`${s.btn} ${s.btnGhost}`} type="button" onClick={cancel}>
                  ■ 중단
                </button>
              ) : null}
              <button
                className={`${s.btn} ${s.btnPrimary}`}
                type="button"
                disabled={busy || !input.trim()}
                onClick={() => void send()}
              >
                전송 ↵
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
