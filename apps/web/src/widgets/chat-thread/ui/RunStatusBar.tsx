import { useEffect, useState } from 'react';
import type { ChatStreamUsage } from '@consulting/contracts';
import { Icon } from '../../../shared/icons/Icon';
import s from '../../thread-view/ui/ThreadView.module.css';

export interface RunStatusUi {
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

function fmtTokens(tokens?: number): string {
  if (tokens === undefined) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function contextPercent(usage?: ChatStreamUsage, contextLimit?: number): number | null {
  if (!usage?.totalTokens || !contextLimit) return null;
  return Math.min(100, Math.round((usage.totalTokens / contextLimit) * 100));
}

/**
 * Runtime status affordance (A5). The 1-second elapsed timer lives HERE so that
 * ticking re-renders are scoped to this component, not the whole ChatThread (F3).
 * Summary pill shows model · % · elapsed; clicking opens a detail popover with
 * the full breakdown. The raw run id is tucked into a "기술 정보" line, never in
 * the message metadata (issue 5).
 */
export function RunStatusBar({ status }: { status: RunStatusUi }) {
  const [open, setOpen] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    if (status.state !== 'running') return;
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status.state]);

  const usage = status.usage;
  const limit = status.contextLimit ?? usage?.contextLimit;
  const pct = contextPercent(usage, limit);
  const elapsedMs = (status.finishedAt ?? nowTs) - status.startedAt;
  const stateClass =
    status.state === 'error' ? s.runStatusError : status.state === 'done' ? s.runStatusDone : s.runStatusRunning;
  const stateLabel = status.state === 'error' ? '오류' : status.state === 'done' ? '완료' : '작업 중';

  return (
    <div className={s.runStatusWrap}>
      <button
        type="button"
        className={`${s.runStatus} ${stateClass} cwTap`}
        title="실행 상세 보기"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={s.runStateDot} />
        <span className={s.runModel}>{status.model ?? 'Hermes'}</span>
        <span className={s.runSep}>·</span>
        <span>{pct === null ? '—' : `${pct}%`}</span>
        <span className={s.runSep}>·</span>
        <span>{fmtElapsed(elapsedMs)}</span>
      </button>

      {open ? (
        <>
          <div className={s.runPopScrim} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={s.runPop} role="dialog" aria-label="실행 상세">
            <div className={s.runPopRow}>
              <span className={s.runPopKey}>모델</span>
              <span className={s.runPopVal}>{status.model ?? 'Hermes'}</span>
            </div>
            <div className={s.runPopRow}>
              <span className={s.runPopKey}>상태</span>
              <span className={s.runPopVal}>
                <span className={`${s.runStateDot} ${stateClass}`} /> {stateLabel}
              </span>
            </div>
            <div className={s.runPopRow}>
              <span className={s.runPopKey}>토큰</span>
              <span className={s.runPopVal}>
                입력 {fmtTokens(usage?.inputTokens)} · 출력 {fmtTokens(usage?.outputTokens)} · 합계{' '}
                {fmtTokens(usage?.totalTokens)}
                {limit ? ` / ${fmtTokens(limit)}` : ''}
              </span>
            </div>
            {pct !== null ? (
              <div className={s.runPopRow}>
                <span className={s.runPopKey}>컨텍스트</span>
                <span className={s.runPopVal}>
                  <span className={s.runPopMeter}>
                    <span style={{ width: `${pct}%` }} />
                  </span>
                  {pct}%
                </span>
              </div>
            ) : null}
            <div className={s.runPopRow}>
              <span className={s.runPopKey}>reasoning</span>
              <span className={s.runPopVal}>{status.reasoning ? '켜짐' : '없음'}</span>
            </div>
            {status.reasoning && status.reasoningText ? (
              <div className={s.runPopReasoning}>{status.reasoningText.slice(-240)}</div>
            ) : null}
            <div className={s.runPopRow}>
              <span className={s.runPopKey}>경과</span>
              <span className={s.runPopVal}>{fmtElapsed(elapsedMs)}</span>
            </div>
            {status.runId ? (
              <details className={s.runPopTech}>
                <summary>기술 정보</summary>
                <div className={s.runPopId}>
                  <code>{status.runId}</code>
                  <button
                    type="button"
                    className={`${s.runPopCopy} cwTap`}
                    onClick={() => void navigator.clipboard?.writeText(status.runId ?? '')}
                    aria-label="실행 ID 복사"
                  >
                    <Icon name="copy" size="xs" decorative />
                  </button>
                </div>
              </details>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
