import { useEffect, useRef, useState } from 'react';
import { useEvidence, useProjectEvidence, useAddEvidence, useEvidenceDecisionSummary, useReviewQueue } from '../../../lib/collab';
import { useHoveredMessage } from '../../../lib/threadCtx';
import { useToast } from '../../../shared/ui/toast/Toast';
import { Icon } from '../../../shared/icons/Icon';
import type { EvidenceDecisionSummaryResponse, ReviewQueueResponse } from '@consulting/contracts';
import type { IconName } from '../../../shared/icons/registry';
import { Button } from '../../../shared/ui/button/Button';
import { Input, Textarea } from '../../../shared/ui/input/Input';
import { EmptyState, Spinner } from '../../../shared/ui/feedback/EmptyState';
import { useDelayedFlag } from '../../../shared/lib/useDelayedFlag';
import { describeVerifierGate } from '../../../shared/lib/verifierGateView';
import { searchStore } from '../../chat-thread/model/searchStore';
import s from './EvidencePanel.module.css';

const sourceLabel: Record<string, string> = {
  gbrain: '지식그래프',
  web: '웹',
  file: '파일',
  tool: '도구',
  manual: '직접 첨부',
};
const sourceIcon: Record<string, IconName> = {
  gbrain: 'brain',
  web: 'globe',
  file: 'files',
  tool: 'wrench',
  manual: 'pin',
};

/**
 * Phase 2-A E-4 — evidence tab in the context panel. Auto items come from
 * Hermes tool events; the accent rail highlights evidence rows tied to the
 * assistant message the user is hovering in the thread (E-4 창조 패턴 실현).
 * B4/B5: flat rows (no card chrome), EmptyState/Spinner reuse, and the add
 * form is a grid accordion (0fr→1fr) that expands/collapses smoothly.
 */
export function EvidencePanel({ threadId, projectId }: { threadId: string; projectId?: string }) {
  const [scope, setScope] = useState<'channel' | 'project'>('channel');
  const [mode, setMode] = useState<'sources' | 'verification' | 'scorecard' | 'review'>('sources');
  const channelEv = useEvidence(threadId);
  const projectEv = useProjectEvidence(projectId, scope === 'project');
  const decision = useEvidenceDecisionSummary(threadId);
  const review = useReviewQueue(threadId);
  const data = scope === 'project' ? projectEv.data : channelEv.data;
  const isLoading = scope === 'project' ? projectEv.isLoading : channelEv.isLoading;
  const hovered = useHoveredMessage();
  const addEvidence = useAddEvidence(threadId);
  const toast = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [ref, setRef] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [url, setUrl] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const showLoading = useDelayedFlag(isLoading, 300, 260);

  // Focus the first field once the expand transition settles (avoids scroll jump).
  useEffect(() => {
    if (!formOpen) return;
    const t = window.setTimeout(() => firstFieldRef.current?.focus(), 210);
    return () => window.clearTimeout(t);
  }, [formOpen]);

  async function submit() {
    if (!ref.trim() || !excerpt.trim()) return;
    try {
      await addEvidence.mutateAsync({
        threadId,
        sourceType: 'manual',
        ref: ref.trim(),
        excerpt: excerpt.trim(),
        ...(url.trim() ? { url: url.trim() } : {}),
      });
      toast('success', '근거 추가 완료');
      setRef('');
      setExcerpt('');
      setUrl('');
      setFormOpen(false);
    } catch {
      toast('error', '근거 추가 실패. URL을 확인해주세요.');
    }
  }

  function closeForm() {
    setRef('');
    setExcerpt('');
    setUrl('');
    setFormOpen(false);
  }

  function selectMode(next: typeof mode) {
    setMode(next);
    setSelectedId(null);
    if (next !== 'sources') closeForm();
  }

  function selectScope(next: typeof scope) {
    setScope(next);
    setSelectedId(null);
    closeForm();
  }

  const items = data?.evidence ?? [];
  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;

  return (
    <div className={s.wrap}>
      <div className={s.modeTabs} role="tablist" aria-label="근거 지능 패널">
        {([
          ['sources', '근거자료'],
          ['verification', '근거검증'],
          ['scorecard', '결정표'],
          ['review', `검토큐${review.data?.items.length ? ` ${review.data.items.length}` : ''}`],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            className={`${s.modeTab} ${mode === id ? s.modeTabOn : ''}`}
            onClick={() => selectMode(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {projectId ? (
        <div className={s.scopeSwitch} role="radiogroup" aria-label="근거 범위">
          <button
            type="button"
            role="radio"
            aria-checked={scope === 'channel'}
            className={`${s.scopeBtn} ${scope === 'channel' ? s.scopeBtnOn : ''}`}
            onClick={() => selectScope('channel')}
          >
            이 채널
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={scope === 'project'}
            className={`${s.scopeBtn} ${scope === 'project' ? s.scopeBtnOn : ''}`}
            onClick={() => selectScope('project')}
          >
            프로젝트 전체
          </button>
        </div>
      ) : null}

      {mode === 'verification' ? (
        <VerificationView isLoading={decision.isLoading} summary={decision.data} />
      ) : null}

      {mode === 'scorecard' ? (
        <ScorecardView isLoading={decision.isLoading} summary={decision.data} />
      ) : null}

      {mode === 'review' ? (
        <ReviewQueueView isLoading={review.isLoading} items={review.data?.items ?? []} />
      ) : null}

      {mode === 'sources' && showLoading ? (
        <div className={s.loadingRow}>
          <Spinner label="근거 불러오는 중" /> 근거 불러오는 중…
        </div>
      ) : null}
      {mode === 'sources' && !isLoading && items.length === 0 && !formOpen ? (
        <EmptyState
          icon="pin"
          title="아직 수집된 근거가 없어요"
          description="지구가 도구를 사용하면 자동으로 쌓이고, 직접 추가할 수도 있어요."
        />
      ) : null}

      {mode === 'sources' && items.length > 0 ? (
        <div className={s.rows}>
          {items.map((e) => (
            <div
              key={e.id}
              role="button"
              tabIndex={0}
              className={`${s.row} ${hovered && e.messageId === hovered ? s.rowGlow : ''} ${selectedId === e.id ? s.rowSelected : ''}`}
              onClick={() => setSelectedId((prev) => (prev === e.id ? null : e.id))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelectedId((prev) => (prev === e.id ? null : e.id));
                }
              }}
            >
              <span className={s.rowIcon}>
                <Icon name={sourceIcon[e.sourceType] ?? 'info'} size="sm" decorative />
              </span>
              <div className={s.rowBody}>
                <div className={s.rowHead}>
                  <span className={s.srcType}>{sourceLabel[e.sourceType] ?? e.sourceType}</span>
                  <span className={s.ref} title={e.ref}>{e.ref}</span>
                </div>
                <div className={s.excerpt}>{e.excerpt}</div>
                {e.url ? (
                  <a className={s.link} href={e.url} target="_blank" rel="noreferrer noopener">
                    출처 열기 <Icon name="globe" size="xs" decorative />
                  </a>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {mode === 'sources' && selected ? (
        <div className={s.detail}>
          <div className={s.detailHead}>
            <span>{sourceLabel[selected.sourceType] ?? selected.sourceType}</span>
            <button type="button" className={s.detailClose} onClick={() => setSelectedId(null)} aria-label="근거 상세 닫기">
              <Icon name="x" size="xs" decorative />
            </button>
          </div>
          <div className={s.detailRef}>{selected.ref}</div>
          <div className={s.detailExcerpt}>{selected.excerpt}</div>
          <div className={s.detailMeta}>
            {selected.qualityScore !== null ? <span>품질 {selected.qualityScore}</span> : null}
            {selected.runId ? <span>run {selected.runId}</span> : null}
            <span>{new Date(selected.createdAt).toLocaleString('ko-KR')}</span>
          </div>
          {selected.qualitySignals.length > 0 ? (
            <div className={s.detailSignals}>{selected.qualitySignals.map((signal) => <span key={signal}>{signal}</span>)}</div>
          ) : null}
          <div className={s.detailActions}>
            {selected.messageId ? (
              <button type="button" className={`${s.detailAction} cwTap`} onClick={() => searchStore.jumpMessage(selected.messageId!, threadId)}>
                메시지로 이동
              </button>
            ) : null}
            {selected.url ? (
              <a className={s.detailAction} href={selected.url} target="_blank" rel="noreferrer noopener">
                출처 열기
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* B5: grid-accordion add form — always mounted, animates on open */}
      <div className={`${s.formShell} ${mode === 'sources' && formOpen ? s.formShellOpen : ''}`} aria-hidden={mode !== 'sources' || !formOpen} inert={mode !== 'sources' || !formOpen ? true : undefined}>
        <div className={s.formInner}>
          <Input
            ref={firstFieldRef}
            className={s.input}
            placeholder="출처 이름 (예: 창원시 예산서)"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
          <Textarea
            className={s.input}
            rows={3}
            placeholder="핵심 내용 발췌"
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
          />
          <Input
            className={s.input}
            placeholder="URL (선택)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <div className={s.formActions}>
            <Button type="button" variant="primary" size="sm" className={s.btnPrimary} disabled={addEvidence.isPending} onClick={() => void submit()}>
              추가
            </Button>
            <Button type="button" variant="ghost" size="sm" className={s.btnGhost} onClick={closeForm}>
              취소
            </Button>
          </div>
        </div>
      </div>

      {/* G3: the add button is always mounted and collapses via its own grid
          accordion when the form opens — mutually-exclusive but never unmounted,
          so canceling the form causes zero height jump. */}
      <div
        className={`${s.addBtnShell} ${mode !== 'sources' || formOpen ? s.addBtnShellHidden : ''}`}
        aria-hidden={mode !== 'sources' || formOpen}
        inert={mode !== 'sources' || formOpen ? true : undefined}
      >
        <button type="button" className={`${s.addBtn} cwTap`} onClick={() => setFormOpen(true)}>
          <Icon name="plus" size="xs" decorative /> 근거 추가
        </button>
      </div>
    </div>
  );
}

type DecisionSummary = EvidenceDecisionSummaryResponse;
type ReviewItem = ReviewQueueResponse['items'][number];

function VerificationView({ isLoading, summary }: { isLoading: boolean; summary: DecisionSummary | undefined }) {
  if (isLoading) return <PanelLoading label="근거검증 계산 중" />;
  if (!summary || summary.verdictSummary.claimCount === 0) {
    return <EmptyState icon="info" title="검증된 답변이 아직 없어요" description="답변이 생성되면 문장별 지지/반박/근거부족 판정이 여기에 쌓입니다." />;
  }
  const v = summary.verdictSummary;
  const exactness = summary.exactness.latestRun;
  const gateView = describeVerifierGate(summary.postAnswerVerification.gate);
  const gateIssues = [...summary.postAnswerVerification.gate.blockers, ...summary.postAnswerVerification.gate.warnings];
  return (
    <div className={s.decisionStack} data-testid="evidence-verification-panel">
      <div className={s.gateCard} data-gate={gateView.tone} data-testid="verifier-release-gate" title={gateView.title}>
        <div className={s.gateTop}>
          <span className={s.gateLabel}>{gateView.label}</span>
          <span className={s.gateDecision}>{summary.postAnswerVerification.gate.decision}</span>
        </div>
        <div className={s.gateDetail}>{gateView.detail}</div>
        {gateIssues[0] ? <div className={s.gateIssue}>{gateIssues[0].message}</div> : null}
      </div>
      <div className={s.metricGrid}>
        <Metric label="지지" value={v.supports} tone="good" />
        <Metric label="반박" value={v.refutes + v.mixed} tone="bad" />
        <Metric label="근거부족" value={v.notEnoughInfo} tone="warn" />
        <Metric label="검증문장" value={v.claimCount} />
      </div>
      {exactness ? (
        <div className={s.verdictRow} data-verdict={exactness.status === 'blocked' ? 'refutes' : exactness.status === 'passed' ? 'supports' : 'not_enough_info'}>
          <span className={s.verdictBadge}>정확성</span>
          <span className={s.verdictText}>{exactnessLabel(exactness.status)} · {exactness.summary}</span>
          <span className={s.verdictMeta}>검산 {exactness.checks.length}건</span>
        </div>
      ) : null}
      <div className={s.sectionLabel}>최근 판정</div>
      {summary.latestVerdicts.slice(0, 6).map((row) => (
        <div key={row.id} className={s.verdictRow} data-verdict={row.verdict}>
          <span className={s.verdictBadge}>{verdictLabel(row.verdict)}</span>
          <span className={s.verdictText}>{row.claimText}</span>
          <span className={s.verdictMeta}>신뢰 {Math.round(row.confidence * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

function ScorecardView({ isLoading, summary }: { isLoading: boolean; summary: DecisionSummary | undefined }) {
  if (isLoading) return <PanelLoading label="결정표 불러오는 중" />;
  const scorecard = summary?.latestScorecard;
  if (!scorecard) return <EmptyState icon="info" title="결정표가 아직 없어요" description="답변 검증 뒤 유지/보강 같은 선택지가 점수표로 정리됩니다." />;
  return (
    <div className={s.decisionStack} data-testid="decision-scorecard-panel">
      <div className={s.scorecardHead}>
        <span>{scorecard.question === 'post_answer_verification' ? '답변 후검증 결정표' : scorecard.question}</span>
        <b>{scorecard.recommendedAlternativeId ? '추천 있음' : '보류'}</b>
      </div>
      {scorecard.ranked.map((item) => (
        <div key={item.id} className={s.scoreRow}>
          <div className={s.scoreTop}>
            <span>{item.alternativeLabel}</span>
            <b>{Math.round(item.weightedScore * 100)}점</b>
          </div>
          <div className={s.scoreMeta}>근거충족 {Math.round(item.evidenceCoverage * 100)}% · 불확실성 {Math.round(item.uncertainty * 100)}% · {actionLabel(item.requiredAction)}</div>
          <div className={s.scoreBar}><span style={{ width: `${Math.round(item.weightedScore * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function ReviewQueueView({ isLoading, items }: { isLoading: boolean; items: ReviewItem[] }) {
  if (isLoading) return <PanelLoading label="검토큐 불러오는 중" />;
  if (items.length === 0) return <EmptyState icon="check" title="열린 검토 항목이 없어요" description="반박되었거나 근거가 부족한 주장이 생기면 우선순위순으로 표시됩니다." />;
  return (
    <div className={s.decisionStack} data-testid="active-review-queue-panel">
      {items.map((item) => (
        <div key={item.id} className={s.reviewRow}>
          <div className={s.reviewTop}>
            <span>{item.itemKind === 'refuted_claim' ? '반박 확인' : '근거 보강'}</span>
            <b>{item.priorityScore.toFixed(2)}</b>
          </div>
          <div className={s.reviewTitle}>{item.title}</div>
          <div className={s.reviewReasons}>{item.reasons.join(' · ')}</div>
        </div>
      ))}
    </div>
  );
}

function PanelLoading({ label }: { label: string }) {
  return <div className={s.loadingRow}><Spinner label={label} /> {label}…</div>;
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  return <div className={s.metric} data-tone={tone}><b>{value}</b><span>{label}</span></div>;
}

function verdictLabel(verdict: string): string {
  if (verdict === 'supports') return '지지';
  if (verdict === 'refutes') return '반박';
  if (verdict === 'mixed') return '혼재';
  return '근거부족';
}

function exactnessLabel(status: string): string {
  if (status === 'passed') return '검산 통과';
  if (status === 'blocked') return '검산 차단';
  return '검산 생략';
}

function actionLabel(action: string): string {
  if (action === 'recommend') return '유지 가능';
  if (action === 'collect_more_evidence') return '근거 보강';
  return '보류';
}
