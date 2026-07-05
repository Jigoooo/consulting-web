import { useRef, useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/useAuth';
import s from '../thread/ThreadView.module.css';

interface Turn {
  id: number;
  role: 'user' | 'ai';
  text: string;
  runId?: string;
  streaming?: boolean;
  error?: string;
}

/**
 * Live chat for a thread. Each send opens /chat/stream (server-side Hermes
 * proxy) and appends deltas to the AI turn in real time. Cancel aborts the SSE.
 * Transcript is session-local for Phase 1-M (message persistence = Phase 2).
 */
export function ChatThread({ threadId, title }: { threadId: string; title: string }) {
  const { user } = useAuth();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  // Reset transcript when switching threads.
  useEffect(() => {
    setTurns([]);
    abortRef.current?.abort();
    setBusy(false);
  }, [threadId]);

  function patchTurn(id: number, patch: Partial<Turn>) {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);

    const userTurn: Turn = { id: nextId.current++, role: 'user', text: message };
    const aiTurn: Turn = { id: nextId.current++, role: 'ai', text: '', streaming: true };
    setTurns((prev) => [...prev, userTurn, aiTurn]);

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
        }
      }
      patchTurn(aiTurn.id, { streaming: false });
    } catch (err) {
      if (controller.signal.aborted) {
        patchTurn(aiTurn.id, { streaming: false, error: '중단됨' });
      } else {
        patchTurn(aiTurn.id, { streaming: false, error: '응답을 가져오지 못했어요. 다시 시도해주세요.' });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  const userInitial = (user?.displayName ?? '나').slice(0, 1);

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
        {turns.length === 0 ? (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 34, marginBottom: 10 }}>🌍</div>
            <div style={{ fontSize: 14 }}>지구에게 무엇이든 물어보세요</div>
          </div>
        ) : null}
        {turns.map((t) => (
          <div key={t.id} className={s.msg}>
            <div className={`${s.avatar} ${t.role === 'user' ? s.avatarUser : s.avatarAi}`}>
              {t.role === 'user' ? userInitial : '🌍'}
            </div>
            <div className={s.body}>
              <div className={s.meta}>
                <span className={s.who}>{t.role === 'user' ? (user?.displayName ?? '나') : '지구'}</span>
                {t.runId ? <span className={s.runid}>{t.runId.slice(0, 12)}…</span> : null}
              </div>
              <div className={s.text}>
                {t.text}
                {t.streaming ? <span className={s.cursor} /> : null}
              </div>
              {t.error ? (
                <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--red)' }}>{t.error}</div>
              ) : null}
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
              <button className={`${s.btn} ${s.btnPrimary}`} type="button" disabled={busy || !input.trim()} onClick={() => void send()}>
                전송 ↵
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
