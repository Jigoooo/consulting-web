import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEvidence, useProjectEvidence, useAddEvidence, useEvidenceDecisionSummary, useRunDecisionAnalytics, useRetrievalHits, useRetrievalHitFeedback, useReviewQueue, useReviewQueueDecision } from '../../../lib/collab';
import { composerDraftRequestStore, useHoveredMessage } from '../../../lib/threadCtx';
import { useToast } from '../../../shared/ui/toast/Toast';
import { Icon } from '../../../shared/icons/Icon';
import type { EvidenceDecisionSummaryV3Response, ListRetrievalHitFeedbackResponse, RecordRetrievalHitFeedbackRequest, RetrievalFailureType, ReviewQueueFilter, ReviewQueueResponse, RunDecisionAnalyticsRequestInput } from '@consulting/contracts';
import type { IconName } from '../../../shared/icons/registry';
import { Button } from '../../../shared/ui/button/Button';
import { Input, Textarea } from '../../../shared/ui/input/Input';
import { EmptyState, Spinner } from '../../../shared/ui/feedback/EmptyState';
import { useDelayedFlag } from '../../../shared/lib/useDelayedFlag';
import { describeVerifierGate } from '../../../shared/lib/verifierGateView';
import { searchStore } from '../../chat-thread/model/searchStore';
import { evidenceAddErrorMessage } from './evidenceAddError';
import { evidencePanelLoadState } from './evidencePanelState';
import { nextRovingIndex } from '../../../shared/lib/rovingTablist';
import { buildImpactRequest, formatKrw, type ImpactDriverDraft } from './decisionAnalyticsForm';
import { useWorkspaceTree } from '../../../lib/spaces';
import { useSelectedWorkspace } from '../../../lib/wsStore';
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

const retrievalFailureActions: readonly { failureType: RetrievalFailureType; label: string }[] = [
  { failureType: 'semantic_false_positive', label: '무관' },
  { failureType: 'wrong_project', label: '다른 프로젝트' },
  { failureType: 'raw_over_selected', label: '원문 과다' },
  { failureType: 'stale_source', label: '오래된 자료' },
  { failureType: 'duplicate_chunk', label: '중복' },
];

type EvidenceScope = 'channel' | 'project';
type EvidenceMode = 'sources' | 'verification' | 'scorecard' | 'review';

const modeTabs: readonly { id: EvidenceMode; label: string }[] = [
  { id: 'sources', label: '근거자료' },
  { id: 'verification', label: '근거검증' },
  { id: 'scorecard', label: '결정표' },
  { id: 'review', label: '검토큐' },
];

const reviewFilters: readonly { id: ReviewQueueFilter; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'refuted_claim', label: '반박' },
  { id: 'unsupported_claim', label: '근거부족' },
];

export function isDecisionAnalyticsRunPending(
  isPending: boolean,
  variables: RunDecisionAnalyticsRequestInput | undefined,
  scorecardId: string | undefined,
): boolean {
  return Boolean(isPending && scorecardId && variables?.scorecardId === scorecardId);
}

export function decisionAnalyticsRunForScorecard<T extends { scorecardId: string }>(
  run: T | null | undefined,
  scorecardId: string | undefined,
): T | null {
  return run && scorecardId && run.scorecardId === scorecardId ? run : null;
}

function modeIndex(mode: EvidenceMode) {
  return modeTabs.findIndex((item) => item.id === mode);
}

/**
 * Phase 2-A E-4 — evidence tab in the context panel. Auto items come from
 * Hermes tool events; the accent rail highlights evidence rows tied to the
 * assistant message the user is hovering in the thread (E-4 창조 패턴 실현).
 * B4/B5: flat rows (no card chrome), EmptyState/Spinner reuse, and the add
 * form swaps instantly to avoid curtain-like right-panel motion.
 */
export function EvidencePanel({ threadId, projectId, topicId }: { threadId: string; projectId?: string; topicId?: string }) {
  const workspaceId = useSelectedWorkspace();
  const { data: tree } = useWorkspaceTree(workspaceId ?? undefined);
  const activeProject = tree?.projects.find((project) => project.id === projectId);
  const activeTopic = activeProject?.channels
    .flatMap((channel) => channel.topics)
    .find((topic) => topic.id === topicId || topic.defaultThreadId === threadId);
  const canMutateEvidence = activeTopic?.permissions?.includes('message.send') ?? false;
  const [scope, setScope] = useState<EvidenceScope>('channel');
  const [mode, setMode] = useState<EvidenceMode>('sources');
  const [reviewFilter, setReviewFilter] = useState<ReviewQueueFilter>('all');
  const [modeDirection, setModeDirection] = useState<'forward' | 'back'>('forward');
  const channelEv = useEvidence(threadId);
  // Preload project-wide evidence so the first scope toggle moves the thumb
  // without flashing a cold query state.
  const projectEv = useProjectEvidence(projectId, Boolean(projectId));
  const decision = useEvidenceDecisionSummary(threadId);
  const decisionAnalytics = useRunDecisionAnalytics(threadId);
  const retrieval = useRetrievalHits(threadId);
  const retrievalFeedback = useRetrievalHitFeedback(threadId);
  const review = useReviewQueue(threadId, reviewFilter);
  const reviewDecision = useReviewQueueDecision(threadId);
  const sourceQuery = scope === 'project' ? projectEv : channelEv;
  const data = sourceQuery.data;
  const isLoading = sourceQuery.isLoading;
  const hovered = useHoveredMessage();
  const addEvidence = useAddEvidence(threadId);
  const toast = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [ref, setRef] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [url, setUrl] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingRetrievalHitId, setPendingRetrievalHitId] = useState<string | null>(null);
  const [pendingReviewItemId, setPendingReviewItemId] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const showLoading = useDelayedFlag(isLoading, 300, 260);

  // Focus the first field after the visible state lands. The form intentionally
  // has no height animation; delayed transition-focus felt laggy and noisy.
  useEffect(() => {
    if (!formOpen) return;
    const frame = window.requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [formOpen]);

  useEffect(() => {
    if (canMutateEvidence) return;
    setFormOpen(false);
    setRef('');
    setExcerpt('');
    setUrl('');
  }, [canMutateEvidence]);

  async function submit() {
    if (!canMutateEvidence) return;
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
    } catch (error) {
      toast('error', evidenceAddErrorMessage(error));
    }
  }

  function closeForm() {
    setRef('');
    setExcerpt('');
    setUrl('');
    setFormOpen(false);
  }

  const activeModeIndex = Math.max(0, modeIndex(mode));
  const modeMotionStyle = { '--mode-index': String(activeModeIndex) } as CSSProperties;
  const scopeMotionStyle = { '--scope-index': scope === 'project' ? '1' : '0' } as CSSProperties;
  const modeTabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function onModeTabsKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = nextRovingIndex(event.key, activeModeIndex, modeTabs.length);
    if (target === null) return;
    event.preventDefault();
    const nextTab = modeTabs[target];
    if (!nextTab) return;
    selectMode(nextTab.id);
    modeTabRefs.current[target]?.focus();
  }

  function selectMode(next: EvidenceMode) {
    if (next === mode) return;
    setModeDirection(modeIndex(next) > activeModeIndex ? 'forward' : 'back');
    setMode(next);
    setSelectedId(null);
    if (next !== 'sources') closeForm();
  }

  function selectScope(next: EvidenceScope) {
    if (next === scope) return;
    setScope(next);
    setSelectedId(null);
    closeForm();
  }

  function queueReviewPrompt(prompt: string) {
    if (!canMutateEvidence) return;
    composerDraftRequestStore.request(threadId, prompt);
    toast('info', '작성창에 검토 요청을 넣었어요. 확인 후 전송해주세요.');
  }

  async function decideReviewItem(itemId: string, action: 'resolve' | 'ignore') {
    if (!canMutateEvidence) return;
    setPendingReviewItemId(itemId);
    try {
      await reviewDecision.mutateAsync({ itemId, body: { action } });
      toast('success', action === 'resolve' ? '검토 항목을 완료 처리했어요.' : '검토 항목을 숨겼어요.');
    } catch {
      toast('error', '검토 항목 처리 실패. 다시 시도해주세요.');
    } finally {
      setPendingReviewItemId(null);
    }
  }

  async function labelRetrievalHit(hitId: string, body: RecordRetrievalHitFeedbackRequest) {
    if (!canMutateEvidence) return;
    setPendingRetrievalHitId(hitId);
    try {
      await retrievalFeedback.mutateAsync({ hitId, body });
      toast('success', body.judgedRelevant ? '유효한 검색 근거로 기록했어요.' : '검색 실패 사유를 기록했어요.');
    } catch {
      toast('error', '검색 근거 평가 저장에 실패했어요. 다시 시도해주세요.');
    } finally {
      setPendingRetrievalHitId(null);
    }
  }

  const items = data?.evidence ?? [];
  const sourceState = evidencePanelLoadState(sourceQuery.isLoading, sourceQuery.isError, items.length);
  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;

  return (
    <div className={s.wrap}>
      <div className={s.modeTabs} role="tablist" aria-label="근거 지능 패널" style={modeMotionStyle} onKeyDown={onModeTabsKeyDown}>
        {modeTabs.map(({ id, label }, tabIndex) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            tabIndex={mode === id ? 0 : -1}
            ref={(node) => { modeTabRefs.current[tabIndex] = node; }}
            className={`${s.modeTab} ${mode === id ? s.modeTabOn : ''}`}
            onClick={() => selectMode(id)}
          >
            {id === 'review' && review.data?.items.length ? `${label} ${review.data.items.length}` : label}
          </button>
        ))}
      </div>
      {projectId ? (
        <div className={s.scopeSwitch} role="radiogroup" aria-label="근거 범위" style={scopeMotionStyle}>
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

      <div key={mode} className={s.modePanel} data-direction={modeDirection} data-mode={mode}>
        {mode === 'verification' ? (
        <div className={s.decisionStack}>
          <VerificationView
            isLoading={decision.isLoading}
            isError={decision.isError}
            summary={decision.data}
            onRetry={() => void decision.refetch()}
          />
          <RetrievalFeedbackView
            isLoading={retrieval.isLoading}
            isError={retrieval.isError}
            hits={retrieval.data?.hits ?? []}
            pendingHitId={pendingRetrievalHitId}
            canMutate={canMutateEvidence}
            onRetry={() => void retrieval.refetch()}
            onFeedback={(hitId, body) => void labelRetrievalHit(hitId, body)}
          />
        </div>
      ) : null}

      {mode === 'scorecard' ? (
        <ScorecardView
          key={decision.data?.latestScorecard?.id ?? 'empty-scorecard'}
          isLoading={decision.isLoading}
          isError={decision.isError}
          summary={decision.data}
          canMutate={canMutateEvidence}
          isRunning={isDecisionAnalyticsRunPending(
            decisionAnalytics.isPending,
            decisionAnalytics.variables,
            decision.data?.latestScorecard?.id,
          )}
          onRun={(body) => decisionAnalytics.mutateAsync(body)}
          onRetry={() => void decision.refetch()}
        />
      ) : null}

      {mode === 'review' ? (
        <div className={s.decisionStack}>
          <div className={s.reviewFilters} aria-label="검토큐 필터">
            {reviewFilters.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className={s.reviewFilterButton}
                aria-pressed={reviewFilter === filter.id}
                onClick={() => setReviewFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <ReviewQueueView
            isLoading={review.isLoading}
            isError={review.isError}
            items={review.data?.items ?? []}
            filter={reviewFilter}
            pendingItemId={pendingReviewItemId}
            canMutate={canMutateEvidence}
            onRetry={() => void review.refetch()}
            onPrompt={queueReviewPrompt}
            onResolve={(itemId) => void decideReviewItem(itemId, 'resolve')}
            onIgnore={(itemId) => void decideReviewItem(itemId, 'ignore')}
          />
        </div>
      ) : null}

      {mode === 'sources' && sourceState === 'loading' && showLoading ? (
        <div className={s.loadingRow}>
          <Spinner label="근거 불러오는 중" /> 근거 불러오는 중…
        </div>
      ) : null}
      {mode === 'sources' && sourceState === 'error' && !formOpen ? (
        <PanelError
          title="근거를 불러오지 못했어요"
          description="연결 상태를 확인한 뒤 다시 시도해주세요. 근거가 없는 상태와는 다릅니다."
          onRetry={() => void sourceQuery.refetch()}
        />
      ) : null}
      {mode === 'sources' && sourceState === 'stale' ? (
        <PanelError
          tone="warn"
          title="최신 근거를 확인하지 못했어요"
          description="아래에는 마지막으로 불러온 자료를 표시합니다."
          onRetry={() => void sourceQuery.refetch()}
        />
      ) : null}
      {mode === 'sources' && sourceState === 'empty' && !formOpen ? (
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

      {/* Add form: always mounted for stable focus, but no height transition. */}
      <div className={`${s.formShell} ${mode === 'sources' && formOpen && canMutateEvidence ? s.formShellOpen : ''}`} aria-hidden={mode !== 'sources' || !formOpen || !canMutateEvidence} inert={mode !== 'sources' || !formOpen || !canMutateEvidence ? true : undefined}>
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

      {/* Add button: instant mutual-exclusive swap with the form. No upward slide. */}
      {canMutateEvidence ? (
        <div
          className={`${s.addBtnShell} ${mode !== 'sources' || formOpen ? s.addBtnShellHidden : ''}`}
          aria-hidden={mode !== 'sources' || formOpen}
          inert={mode !== 'sources' || formOpen ? true : undefined}
        >
          <button type="button" className={`${s.addBtn} cwTap`} onClick={() => setFormOpen(true)}>
            <Icon name="plus" size="xs" decorative /> 근거 추가
          </button>
        </div>
      ) : null}
      </div>
    </div>
  );
}

type DecisionSummary = EvidenceDecisionSummaryV3Response;
type RetrievalHit = ListRetrievalHitFeedbackResponse['hits'][number];
type ReviewItem = ReviewQueueResponse['items'][number];

function VerificationView({
  isLoading,
  isError,
  summary,
  onRetry,
}: {
  isLoading: boolean;
  isError: boolean;
  summary: DecisionSummary | undefined;
  onRetry: () => void;
}) {
  if (isLoading && !summary) return <PanelLoading label="근거검증 계산 중" />;
  if (isError && !summary) {
    return <PanelError title="근거검증을 불러오지 못했어요" description="검증 결과가 없는 상태와는 다릅니다." onRetry={onRetry} />;
  }
  if (!summary || summary.verdictSummary.claimCount === 0) {
    return <EmptyState icon="info" title="검증된 답변이 아직 없어요" description="답변이 생성되면 문장별 지지/반박/근거부족 판정이 여기에 쌓입니다." />;
  }
  const v = summary.verdictSummary;
  const exactness = summary.exactness.latestRun;
  const judgment = summary.judgment.latestRun;
  const gateView = describeVerifierGate(summary.postAnswerVerification.gate);
  const gateIssues = [...summary.postAnswerVerification.gate.blockers, ...summary.postAnswerVerification.gate.warnings];
  return (
    <>
      {isError ? (
        <PanelError tone="warn" title="최신 근거검증을 확인하지 못했어요" description="아래에는 마지막으로 불러온 검증 결과를 표시합니다." onRetry={onRetry} />
      ) : null}
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
      {judgment ? (
        <>
          <div className={s.verdictRow} data-verdict={judgment.status === 'blocked' ? 'refutes' : judgment.status === 'warnings' ? 'not_enough_info' : 'supports'}>
            <span className={s.verdictBadge}>판단안전</span>
            <span className={s.verdictText}>{judgmentStatusLabel(judgment.status)} · {judgment.issueSummary}</span>
            <span className={s.verdictMeta}>이슈 {judgment.issues.length}건</span>
          </div>
          {judgment.issues.slice(0, 3).map((issue) => (
            <div key={issue.code} className={s.reviewRow} data-verdict={issue.severity === 'blocker' ? 'refutes' : 'not_enough_info'}>
              <div className={s.reviewTop}>
                <span>{judgmentIssueLabel(issue.code)}</span>
                <b>{issue.severity === 'blocker' ? '차단' : '주의'}</b>
              </div>
              <div className={s.reviewTitle}>{issue.message}</div>
              <div className={s.reviewReasons}>필수조치: {issue.requiredAction}</div>
            </div>
          ))}
        </>
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
    </>
  );
}

function RetrievalFeedbackView({
  isLoading,
  isError,
  hits,
  pendingHitId,
  canMutate,
  onRetry,
  onFeedback,
}: {
  isLoading: boolean;
  isError: boolean;
  hits: RetrievalHit[];
  pendingHitId: string | null;
  canMutate: boolean;
  onRetry: () => void;
  onFeedback: (hitId: string, body: RecordRetrievalHitFeedbackRequest) => void;
}) {
  const state = evidencePanelLoadState(isLoading, isError, hits.length);
  return (
    <div className={s.retrievalFeedback} data-testid="retrieval-hit-feedback-panel">
      <div className={s.sectionLabel}>검색 근거 품질</div>
      {state === 'loading' ? <PanelLoading label="검색 근거 불러오는 중" /> : null}
      {state === 'error' ? <PanelError title="검색 근거를 불러오지 못했어요" description="평가할 근거가 없는 상태와는 다릅니다." onRetry={onRetry} /> : null}
      {state === 'stale' ? <PanelError tone="warn" title="최신 검색 근거를 확인하지 못했어요" description="마지막으로 불러온 결과를 표시합니다." onRetry={onRetry} /> : null}
      {state === 'empty' ? <div className={s.gateDetail}>이 채널에서 평가할 검색 근거가 아직 없어요.</div> : null}
      {hits.slice(0, 8).map((hit) => {
        const disabled = pendingHitId !== null;
        return (
          <div key={hit.id} className={s.reviewRow} data-feedback={hit.judgedRelevant === null ? 'unlabeled' : hit.judgedRelevant ? 'relevant' : 'failure'}>
            <div className={s.reviewTop}>
              <span>{hit.docTitle ?? hit.hitKind}</span>
              <b>#{hit.rank}</b>
            </div>
            <div className={s.reviewTitle}>{hit.textPreview}</div>
            <div className={s.reviewReasons}>질의: {hit.queryText}{hit.sourceTopicSlug ? ` · ${hit.sourceTopicSlug}` : ''}</div>
            {canMutate ? (
              <div className={s.reviewPromptActions} aria-label="검색 근거 평가">
                <button
                  type="button"
                  className={`${s.reviewPromptButton} cwTap`}
                  aria-pressed={hit.judgedRelevant === true}
                  disabled={disabled}
                  onClick={() => onFeedback(hit.id, { judgedRelevant: true })}
                >
                  <Icon name="check" size="xs" decorative />
                  유효
                </button>
                {retrievalFailureActions.map((action) => (
                  <button
                    key={action.failureType}
                    type="button"
                    className={`${s.reviewPromptButton} cwTap`}
                    aria-pressed={hit.failureType === action.failureType}
                    disabled={disabled}
                    onClick={() => onFeedback(hit.id, { judgedRelevant: false, failureType: action.failureType })}
                  >
                    <Icon name="x" size="xs" decorative />
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ScorecardView({
  isLoading,
  isError,
  summary,
  canMutate,
  isRunning,
  onRun,
  onRetry,
}: {
  isLoading: boolean;
  isError: boolean;
  summary: DecisionSummary | undefined;
  canMutate: boolean;
  isRunning: boolean;
  onRun: (body: RunDecisionAnalyticsRequestInput) => Promise<unknown>;
  onRetry: () => void;
}) {
  const toast = useToast();
  const driverSerial = useRef(1);
  const [impactOpen, setImpactOpen] = useState(false);
  const [fixedMultiplier, setFixedMultiplier] = useState('');
  const [drivers, setDrivers] = useState<ImpactDriverDraft[]>([
    { id: 'driver_1', label: '', min: '', mode: '', max: '' },
  ]);
  const [impactError, setImpactError] = useState<string | null>(null);

  function updateDriver(id: string, field: keyof Omit<ImpactDriverDraft, 'id'>, value: string) {
    setDrivers((current) => current.map((driver) => driver.id === id ? { ...driver, [field]: value } : driver));
  }

  function addDriver() {
    if (drivers.length >= 6) return;
    driverSerial.current += 1;
    setDrivers((current) => [...current, {
      id: `driver_${driverSerial.current}`,
      label: '',
      min: '',
      mode: '',
      max: '',
    }]);
  }

  async function submitImpact(scorecardId: string) {
    const result = buildImpactRequest(fixedMultiplier, drivers);
    if (!result.ok) {
      setImpactError(result.message);
      return;
    }
    setImpactError(null);
    try {
      await onRun({ scorecardId, impact: result.impact });
      toast('success', '영향 추정이 감사 원장에 기록됐어요.');
    } catch {
      setImpactError('영향 추정 저장에 실패했습니다. 입력값은 유지되므로 잠시 후 다시 시도해주세요.');
    }
  }

  if (isLoading && !summary) return <PanelLoading label="결정표 불러오는 중" />;
  if (isError && !summary) {
    return <PanelError title="결정표를 불러오지 못했어요" description="결정표가 생성되지 않은 상태와는 다릅니다." onRetry={onRetry} />;
  }
  const scorecard = summary?.latestScorecard;
  if (!scorecard) return <EmptyState icon="info" title="결정표가 아직 없어요" description="답변 검증 뒤 유지/보강 같은 선택지가 점수표로 정리됩니다." />;
  const analytics = summary.analytics;
  const run = decisionAnalyticsRunForScorecard(analytics.latestRun, scorecard.id);

  return (
    <>
      {isError ? <PanelError tone="warn" title="최신 결정표를 확인하지 못했어요" description="마지막으로 불러온 결정표를 표시합니다." onRetry={onRetry} /> : null}
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

        {!analytics.supported ? (
          <div className={s.analyticsNotice} role="status">
            <b>결정 분석 서버 업데이트 대기</b>
            <span>결정표는 볼 수 있지만 안정성·영향 분석은 서버 업데이트 뒤 사용할 수 있습니다.</span>
          </div>
        ) : run ? (
          <section className={s.analyticsSection} data-testid="decision-analytics-audit" aria-labelledby="decision-analytics-heading">
            <div className={s.analyticsHead}>
              <div>
                <span className={s.sectionLabel}>결정 분석</span>
                <h3 id="decision-analytics-heading">승자 안정성 {Math.round(run.sensitivity.winnerStability * 100)}%</h3>
              </div>
              <span>{run.sensitivity.scenarios.toLocaleString('ko-KR')}개 시나리오</span>
            </div>
            <div className={s.stabilityTrack} aria-label={`승자 안정성 ${Math.round(run.sensitivity.winnerStability * 100)}%`}>
              <span style={{ width: `${Math.round(run.sensitivity.winnerStability * 100)}%` }} />
            </div>
            <p className={s.analyticsAssumption}>기준 가중치를 축별 ±{Math.round(run.sensitivity.perturbationPct * 100)}% 범위에서 변동한 결과입니다.</p>
            <div className={s.analyticsSubhead}>순위 역전 임계축</div>
            <div className={s.thresholdList}>
              {run.sensitivity.criticalCriteria.map((criterion) => (
                <div key={criterion.criterionId} className={s.thresholdRow} data-flips={criterion.flipsWinner || undefined}>
                  <span>{criterion.label}</span>
                  <b>{criterion.thresholdPct === null ? '범위 내 안정' : `가중치 ${criterion.thresholdPct > 0 ? '+' : ''}${Math.round(criterion.thresholdPct * 100)}%`}</b>
                  <small>{criterion.challengerId ? `도전자 ${criterion.challengerId}` : '순위 유지'}</small>
                </div>
              ))}
            </div>
            {run.impact ? (
              <>
                <div className={s.analyticsSubhead}>재정 영향 범위 · {run.impact.unit}</div>
                <div className={s.impactGrid}>
                  <div><span>P10 · 하위 10% 분위</span><b>{formatKrw(run.impact.interval.p10)}</b></div>
                  <div><span>P50 · 중앙 분위</span><b>{formatKrw(run.impact.interval.p50)}</b></div>
                  <div><span>P90 · 상위 10% 분위</span><b>{formatKrw(run.impact.interval.p90)}</b></div>
                </div>
                <div className={s.thresholdList} aria-label="재정 영향 입력 가정">
                  {run.impact.drivers.map((driver) => (
                    <div key={driver.id} className={s.thresholdRow}>
                      <span>{driver.label}</span>
                      <b>{driver.min.toLocaleString('ko-KR')} / {driver.mode.toLocaleString('ko-KR')} / {driver.max.toLocaleString('ko-KR')}</b>
                      <small>최솟값 / 기준값 / 최댓값</small>
                    </div>
                  ))}
                </div>
                <p className={s.analyticsAssumption}>입력값을 곱하는 모델 · 고정 배수 {run.impact.fixedMultiplier.toLocaleString('ko-KR')} · 삼각분포 · {run.impact.iterations.toLocaleString('ko-KR')}회 · seed {run.impact.seed}. P10/P50/P90은 입력 가정 기반 분위값이며 신뢰구간·보장액·확정 예산이 아닙니다.</p>
              </>
            ) : (
              <p className={s.analyticsAssumption}>현재 기록은 순위 민감도만 포함합니다. 재정 영향은 사용자가 입력한 값으로만 계산합니다.</p>
            )}
            <div className={s.auditMeta}>
              <span>{run.methodVersion} · {run.actorKind === 'system' ? '자동 실행' : '사용자 실행'} · {new Date(run.createdAt).toLocaleString('ko-KR')}</span>
              <code title={run.inputHash}>{run.inputHash.slice(0, 16)}…</code>
            </div>
          </section>
        ) : (
          <div className={s.analyticsNotice} role="status">
            <b>아직 분석 기록이 없습니다</b>
            <span>다음 답변 후검증에서 순위 민감도가 자동 계산됩니다.</span>
          </div>
        )}

        {analytics.supported && canMutate ? (
          <section className={s.impactForm} aria-labelledby="impact-form-heading">
            <div className={s.impactFormHead}>
              <div>
                <h3 id="impact-form-heading">재정 영향 직접 입력</h3>
                <p>입력값을 곱하는 모델이며 모든 금액은 원(KRW), 각 축은 삼각분포로 계산합니다.</p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setImpactOpen((open) => !open); setImpactError(null); }}>
                {impactOpen ? '접기' : '입력 열기'}
              </Button>
            </div>
            {impactOpen ? (
              <fieldset disabled={isRunning} aria-busy={isRunning}>
                <div className={s.impactFormBody}>
                <label className={s.analyticsField}>
                  <span>고정 배수</span>
                  <Input type="number" inputMode="decimal" min="0" max="1000000" value={fixedMultiplier} onChange={(event) => setFixedMultiplier(event.target.value)} placeholder="예: 적용 개월 수" />
                </label>
                {drivers.map((driver, index) => (
                  <div key={driver.id} className={s.driverGroup}>
                    <div className={s.driverHead}>
                      <b>영향 축 {index + 1}</b>
                      {drivers.length > 1 ? <button type="button" className={s.driverRemove} onClick={() => setDrivers((current) => current.filter((item) => item.id !== driver.id))}>축 삭제</button> : null}
                    </div>
                    <Input aria-label={`영향 축 ${index + 1} 이름`} value={driver.label} onChange={(event) => updateDriver(driver.id, 'label', event.target.value)} placeholder="축 이름" />
                    <div className={s.driverNumbers}>
                      <Input aria-label={`영향 축 ${index + 1} 최솟값`} type="number" inputMode="decimal" min="0" value={driver.min} onChange={(event) => updateDriver(driver.id, 'min', event.target.value)} placeholder="최솟값" />
                      <Input aria-label={`영향 축 ${index + 1} 기준값`} type="number" inputMode="decimal" min="0" value={driver.mode} onChange={(event) => updateDriver(driver.id, 'mode', event.target.value)} placeholder="기준값" />
                      <Input aria-label={`영향 축 ${index + 1} 최댓값`} type="number" inputMode="decimal" min="0" value={driver.max} onChange={(event) => updateDriver(driver.id, 'max', event.target.value)} placeholder="최댓값" />
                    </div>
                  </div>
                ))}
                <div className={s.impactActions}>
                  <Button type="button" variant="ghost" size="sm" disabled={drivers.length >= 6 || isRunning} onClick={addDriver}>영향 축 추가</Button>
                  <Button type="button" variant="primary" size="sm" disabled={isRunning} onClick={() => void submitImpact(scorecard.id)}>
                    {isRunning ? '계산 중…' : '영향 추정 실행'}
                  </Button>
                </div>
                {impactError ? <p className={s.impactError} role="alert">{impactError}</p> : null}
                  <p className={s.analyticsAssumption}>시나리오 2,000개와 영향 추정 10,000회를 사용합니다. 결과는 입력 가정의 범위이며 확정 예산이 아닙니다.</p>
                </div>
              </fieldset>
            ) : null}
          </section>
        ) : null}
      </div>
    </>
  );
}

function ReviewQueueView({
  isLoading,
  isError,
  items,
  filter,
  pendingItemId,
  canMutate,
  onRetry,
  onPrompt,
  onResolve,
  onIgnore,
}: {
  isLoading: boolean;
  isError: boolean;
  items: ReviewItem[];
  filter: ReviewQueueFilter;
  pendingItemId: string | null;
  canMutate: boolean;
  onRetry: () => void;
  onPrompt: (prompt: string) => void;
  onResolve: (itemId: string) => void;
  onIgnore: (itemId: string) => void;
}) {
  const state = evidencePanelLoadState(isLoading, isError, items.length);
  if (state === 'loading') return <PanelLoading label="검토큐 불러오는 중" />;
  if (state === 'error') {
    return <PanelError title="검토큐를 불러오지 못했어요" description="열린 항목이 없는 상태와는 다릅니다." onRetry={onRetry} />;
  }
  if (state === 'empty') {
    const title = filter === 'refuted_claim'
      ? '반박 검토 항목이 없어요'
      : filter === 'unsupported_claim'
        ? '근거부족 검토 항목이 없어요'
        : '열린 검토 항목이 없어요';
    const description = filter === 'all'
      ? '반박되었거나 근거가 부족한 주장이 생기면 우선순위순으로 표시됩니다.'
      : '다른 필터를 선택하면 남아 있는 검토 항목을 확인할 수 있습니다.';
    return <EmptyState icon="check" title={title} description={description} />;
  }
  return (
    <>
      {state === 'stale' ? <PanelError tone="warn" title="최신 검토큐를 확인하지 못했어요" description="마지막으로 불러온 항목을 표시합니다." onRetry={onRetry} /> : null}
      <div className={s.decisionStack} data-testid="active-review-queue-panel">
      {items.map((item) => {
        const disabled = pendingItemId === item.id;
        return (
          <div key={item.id} className={s.reviewRow}>
            <div className={s.reviewTop}>
              <span>{item.itemKind === 'refuted_claim' ? '반박 확인' : '근거 보강'}</span>
              <b>{item.priorityScore.toFixed(2)}</b>
            </div>
            <div className={s.reviewTitle}>{item.title}</div>
            <div className={s.reviewReasons}>{item.reasons.join(' · ')}</div>
            {canMutate ? (
              <>
                <div className={s.reviewPromptActions} aria-label="검토 작업 작성">
                  {item.actions.map((action) => (
                    <button key={action.id} type="button" className={`${s.reviewPromptButton} cwTap`} onClick={() => onPrompt(action.prompt)}>
                      {action.label}
                    </button>
                  ))}
                </div>
                <div className={s.reviewDecisionActions} aria-label="검토 항목 처리">
                  <button type="button" className={`${s.reviewDecisionButton} cwTap`} disabled={disabled} onClick={() => onResolve(item.id)}>
                    완료 처리
                  </button>
                  <button type="button" className={`${s.reviewDecisionButton} ${s.reviewDecisionButtonMuted} cwTap`} disabled={disabled} onClick={() => onIgnore(item.id)}>
                    나중에 보기
                  </button>
                </div>
              </>
            ) : null}
          </div>
        );
      })}
      </div>
    </>
  );
}

function PanelError({
  title,
  description,
  onRetry,
  tone = 'error',
}: {
  title: string;
  description: string;
  onRetry: () => void;
  tone?: 'error' | 'warn';
}) {
  return (
    <div className={s.errorState} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      <span>{description}</span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>다시 시도</Button>
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

function judgmentStatusLabel(status: string): string {
  if (status === 'blocked') return '판단 차단';
  if (status === 'warnings') return '주의 필요';
  return '판단 점검 생략';
}

function judgmentIssueLabel(code: string): string {
  const labels: Record<string, string> = {
    source_intake_parse_failure: '원문 파싱 실패',
    stale_source_warning: '기준일 누락',
    applicability_map_required: '적용대상 구분 필요',
    decision_gate_order_required: '판단 순서 필요',
    latest_authority_required: '최신 권위자료 필요',
    comparator_consistency_required: '비교기준 일관성 필요',
    counterargument_required: '반대논거 검토 필요',
    user_correction_pattern: '사용자 정정 재검토',
    overclaim_strength_risk: '과도한 단정 위험',
  };
  return labels[code] ?? '판단 점검';
}

function actionLabel(action: string): string {
  if (action === 'recommend') return '유지 가능';
  if (action === 'collect_more_evidence') return '근거 보강';
  return '보류';
}
