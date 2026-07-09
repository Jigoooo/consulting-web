import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import type { TraceSpanItem, TraceSummary } from '@consulting/contracts';
import { useLastThread } from '../../lib/threadCtx';
import { useSelectedWorkspace } from '../../lib/wsStore';
import { useObservabilityTraces } from '../../lib/collab';
import { Button } from '../../shared/ui/button/Button';
import { Input } from '../../shared/ui/input/Input';
import { EmptyState, Spinner } from '../../shared/ui/feedback/EmptyState';
import { Icon } from '../../shared/icons/Icon';
import { formatFullDateTime } from '../../shared/lib/formatDate';
import { useDelayedFlag } from '../../shared/lib/useDelayedFlag';
import s from './TraceViewerSurface.module.css';

/** P4 Trace Viewer v1 — trace/eval ledger read-only surface.
 * Raw tool I/O is intentionally not rendered; the API contract keeps preview
 * fields null to avoid prompt/tool/PII leakage in the browser.
 */
export function TraceViewerSurface() {
  const workspaceId = useSelectedWorkspace();
  const lastThreadId = useLastThread();
  const router = useRouter();
  const [traceFilter, setTraceFilter] = useState('');
  const [threadFilter, setThreadFilter] = useState('');
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const query = useObservabilityTraces(workspaceId ?? undefined, {
    ...(traceFilter.trim() ? { traceId: traceFilter.trim() } : {}),
    ...(threadFilter.trim() ? { threadId: threadFilter.trim() } : {}),
    limit: 120,
  });
  const showLoading = useDelayedFlag(query.isLoading || query.isFetching, 250, 240);
  const traces = query.data?.traces ?? [];
  const spans = query.data?.spans ?? [];
  const evalCases = query.data?.evalCases ?? [];
  const evalRuns = query.data?.evalRuns ?? [];
  const selectedTrace = traces.find((trace) => trace.traceId === selectedTraceId) ?? traces[0] ?? null;
  const selectedSpans = selectedTrace ? spans.filter((span) => span.traceId === selectedTrace.traceId) : [];

  useEffect(() => {
    if (!selectedTraceId && traces[0]) setSelectedTraceId(traces[0].traceId);
    if (selectedTraceId && traces.length > 0 && !traces.some((trace) => trace.traceId === selectedTraceId)) {
      setSelectedTraceId(traces[0]!.traceId);
    }
  }, [selectedTraceId, traces]);

  return (
    <div className={s.page} data-testid="trace-viewer">
      <aside className={s.sidebar}>
        <div className={s.head}>
          <div className={s.titleRow}>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              leadingIcon="arrow-left"
              className={s.backBtn}
              title={lastThreadId ? '마지막 채널로 돌아가기' : '워크스페이스로 돌아가기'}
              onClick={() => {
                if (lastThreadId) void router.navigate({ to: '/th/$threadId', params: { threadId: lastThreadId } });
                else void router.navigate({ to: '/' });
              }}
              aria-label={lastThreadId ? '마지막 채널로 돌아가기' : '워크스페이스로 돌아가기'}
            />
            <Icon name="monitor" size="sm" decorative />
            <span>Trace Viewer</span>
          </div>
          <p className={s.subtitle}>최근 실행 trace, span, eval ledger를 운영자가 확인합니다.</p>
        </div>
        <div className={s.filters}>
          <Input
            className={s.filterInput}
            value={traceFilter}
            onChange={(event) => setTraceFilter(event.target.value)}
            placeholder="traceId 필터"
            aria-label="traceId 필터"
          />
          <Input
            className={s.filterInput}
            value={threadFilter}
            onChange={(event) => setThreadFilter(event.target.value)}
            placeholder="threadId 필터"
            aria-label="threadId 필터"
          />
        </div>
        {showLoading ? (
          <div className={s.loadingRow}>
            <Spinner label="trace 불러오는 중" /> 불러오는 중…
          </div>
        ) : null}
        {query.isError ? (
          <div className={s.errorBox}>Trace ledger를 불러오지 못했어요. 권한 또는 배포 상태를 확인해주세요.</div>
        ) : null}
        {!query.isLoading && traces.length === 0 ? (
          <div className={s.emptyRail}>아직 trace가 없어요. 새 대화를 실행하면 span ledger가 여기에 쌓입니다.</div>
        ) : null}
        <div className={s.traceList}>
          {traces.map((trace) => (
            <TraceCard
              key={trace.traceId}
              trace={trace}
              active={selectedTrace?.traceId === trace.traceId}
              onClick={() => setSelectedTraceId(trace.traceId)}
            />
          ))}
        </div>
      </aside>

      <main className={s.viewer}>
        {!workspaceId ? (
          <EmptyState icon="database" title="워크스페이스를 선택하세요" description="Trace ledger는 워크스페이스 단위로 격리됩니다." />
        ) : !selectedTrace ? (
          <EmptyState icon="monitor" title="조회할 trace가 없어요" description="Trace span/eval case가 생성되면 실행 흐름과 실패 지점을 여기에서 볼 수 있습니다." />
        ) : (
          <>
            <TraceHeader trace={selectedTrace} />
            <div className={s.section} role="region" aria-labelledby="trace-span-timeline-heading">
              <div className={s.sectionHead}>
                <h2 id="trace-span-timeline-heading">Span timeline</h2>
                <span>{selectedSpans.length}개 span</span>
              </div>
              <div className={s.spanList}>
                {selectedSpans.map((span) => <SpanRow key={span.id} span={span} />)}
              </div>
            </div>
            <div className={s.gridSections}>
              <LedgerPanel title="Eval cases" count={evalCases.length}>
                {evalCases.length === 0 ? <p className={s.muted}>아직 eval case가 없습니다.</p> : evalCases.map((item) => (
                  <div key={item.id} className={s.ledgerItem}>
                    <div className={s.ledgerTitle}>{item.caseKind}</div>
                    <div className={s.ledgerMeta}>{item.status} · {item.sourceRef}</div>
                    <p className={s.muted}>프롬프트 원문은 보안상 비공개입니다.</p>
                  </div>
                ))}
              </LedgerPanel>
              <LedgerPanel title="Eval runs" count={evalRuns.length}>
                {evalRuns.length === 0 ? <p className={s.muted}>아직 eval run이 없습니다.</p> : evalRuns.map((run) => (
                  <div key={run.id} className={s.ledgerItem}>
                    <div className={s.ledgerTitle}>{run.runKind}</div>
                    <div className={s.ledgerMeta}>{run.status} · {formatFullDateTime(run.startedAt)}</div>
                    <pre className={s.preview}>{formatRecord(run.metrics)}</pre>
                  </div>
                ))}
              </LedgerPanel>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function TraceCard({ trace, active, onClick }: { trace: TraceSummary; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`${s.traceCard} ${active ? s.traceCardOn : ''}`} onClick={onClick}>
      <span className={s.traceId}>{shortTrace(trace.traceId)}</span>
      <span className={s.traceMeta} title={formatFullDateTime(trace.lastAt)}>
        {trace.spanCount} spans · {trace.errorCount} warnings · {trace.totalDurationMs}ms
      </span>
      <span className={s.traceNames}>{trace.topSpanNames.join(' → ')}</span>
    </button>
  );
}

function TraceHeader({ trace }: { trace: TraceSummary }) {
  return (
    <div className={s.traceHeader}>
      <div>
        <div className={s.kicker}>선택된 trace</div>
        <h1>{trace.traceId}</h1>
        <p>{formatFullDateTime(trace.startedAt)} 시작 · 마지막 {formatFullDateTime(trace.lastAt)}</p>
      </div>
      <div className={s.stats}>
        <Stat label="span" value={String(trace.spanCount)} />
        <Stat label="warning" value={String(trace.errorCount)} tone={trace.errorCount > 0 ? 'warn' : 'ok'} />
        <Stat label="duration" value={`${trace.totalDurationMs}ms`} />
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'warn' | 'ok' }) {
  return (
    <div className={`${s.stat} ${tone === 'warn' ? s.statWarn : tone === 'ok' ? s.statOk : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SpanRow({ span }: { span: TraceSpanItem }) {
  return (
    <article className={s.spanRow} data-status={span.status}>
      <div className={s.spanTop}>
        <span className={s.kind}>{span.spanKind}</span>
        <strong>{span.name}</strong>
        <span className={`${s.status} ${span.status === 'ok' ? s.statusOk : s.statusWarn}`}>{span.status}</span>
        <span className={s.duration}>{span.durationMs}ms</span>
      </div>
      <div className={s.spanMeta}>
        <span>{formatFullDateTime(span.startedAt)}</span>
        {span.parentSpanId ? <span>parent {shortTrace(span.parentSpanId)}</span> : null}
        {span.threadId ? <span>thread {shortTrace(span.threadId)}</span> : null}
      </div>
      {Object.keys(span.metadata).length > 0 ? <pre className={s.preview}>metadata {formatRecord(span.metadata)}</pre> : null}
    </article>
  );
}

function LedgerPanel({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className={s.ledgerPanel}>
      <div className={s.sectionHead}>
        <h2>{title}</h2>
        <span>{count}개</span>
      </div>
      <div className={s.ledgerList}>{children}</div>
    </section>
  );
}

function shortTrace(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatRecord(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}
