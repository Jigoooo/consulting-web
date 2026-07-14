import { useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { ApiClientError } from '@consulting/api-client';
import type { ArtifactExportPreflightResponse, ArtifactReviewWorklistItem } from '@consulting/contracts';
import { useSelectedWorkspace } from '../../lib/wsStore';
import { useLastThread } from '../../lib/threadCtx';
import { useWorkspaceTree } from '../../lib/spaces';
import { useArtifacts, useArtifactDetail, useCreateArtifact, useAddArtifactVersion, useVerifyArtifactVersion, useArtifactExportPreflight, useArtifactContractV2, useArtifactReviewPlan, useArtifactReviewDecision, saveArtifactExport } from '../../lib/collab';
import { Markdown } from '../../shared/ui/markdown/Markdown';
import { useToast } from '../../shared/ui/toast/Toast';
import { Button } from '../../shared/ui/button/Button';
import { Input, Textarea } from '../../shared/ui/input/Input';
import { Select } from '../../shared/ui/select/Select';
import { EmptyState } from '../../shared/ui/feedback/EmptyState';
import { resolveAsyncCollectionState } from '../../shared/lib/asyncCollectionState';
import { formatDateLabel, formatFullDateTime } from '../../shared/lib/formatDate';
import s from './Artifacts.module.css';

type ExportPreflightIssue = {
  tone: 'warn' | 'blocked';
  title: string;
  messages: string[];
};

type VersionBoundExportIssue = {
  versionId: string;
  issue: ExportPreflightIssue;
};

type VersionBoundReviewNote = {
  versionId: string;
  note: string;
};

type ReviewPageState = { projectId: string; offset: number; history: number[] };

export function ArtifactsSurface({
  initialProjectId = '',
  variant = 'page',
}: {
  initialProjectId?: string | undefined;
  variant?: 'page' | 'modal';
}) {
  const workspaceId = useSelectedWorkspace();
  const router = useRouter();
  const lastThreadId = useLastThread();
  const { data: tree } = useWorkspaceTree(workspaceId ?? undefined);
  const [projectFilter, setProjectFilter] = useState<string>(initialProjectId);
  const [reviewFilter, setReviewFilter] = useState('pending');
  const [reviewNoteState, setReviewNoteState] = useState<VersionBoundReviewNote | null>(null);
  const [reviewPage, setReviewPage] = useState<ReviewPageState>({ projectId: '', offset: 0, history: [] });
  const [artifactPage, setArtifactPage] = useState<ReviewPageState>({ projectId: '', offset: 0, history: [] });
  const artifactContractV2 = useArtifactContractV2();
  const artifactPageScope = projectFilter || 'all';
  const artifactOffset = artifactContractV2.data === true && artifactPage.projectId === artifactPageScope
    ? artifactPage.offset
    : 0;
  const artifactOffsetHistory = artifactPage.projectId === artifactPageScope ? artifactPage.history : [];
  const artifactsQuery = useArtifacts(workspaceId ?? undefined, projectFilter || undefined, artifactOffset);
  const { data, isLoading } = artifactsQuery;
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useArtifactDetail(selected ?? undefined);
  const reviewProjectId = projectFilter || detail.data?.projectId || '';
  const reviewOffset = reviewPage.projectId === reviewProjectId ? reviewPage.offset : 0;
  const reviewOffsetHistory = reviewPage.projectId === reviewProjectId ? reviewPage.history : [];
  const structuredMutationsReady = artifactContractV2.data === true;
  const reviewPlan = useArtifactReviewPlan(reviewProjectId || undefined, artifactContractV2.data === true, reviewOffset);
  const reviewDecision = useArtifactReviewDecision(reviewProjectId || undefined);
  const createArtifact = useCreateArtifact(workspaceId ?? undefined);
  const addVersion = useAddArtifactVersion(workspaceId ?? undefined);
  const verifyVersion = useVerifyArtifactVersion();
  const toast = useToast();

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [governingMessage, setGoverningMessage] = useState('');
  const [soWhat, setSoWhat] = useState('');
  const [projectId, setProjectId] = useState('');
  const [versionOpen, setVersionOpen] = useState(false);
  const [vContent, setVContent] = useState('');
  const [vGoverningMessage, setVGoverningMessage] = useState('');
  const [vSoWhat, setVSoWhat] = useState('');
  const [vNote, setVNote] = useState('');
  const [vSource, setVSource] = useState<{ sourceThreadId?: string; sourceMessageId?: string }>({});
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null);
  const [exportIssueState, setExportIssueState] = useState<VersionBoundExportIssue | null>(null);
  const createSubmission = useRef(false);
  const versionSubmission = useRef(false);

  const projects = tree?.projects ?? [];
  const createProjectId = resolveArtifactProjectId(projectId, projectFilter, projects);
  const permissionProjectId = detail.data?.projectId ?? createProjectId;
  const canEdit = projects
    .find((project) => project.id === permissionProjectId)
    ?.permissions?.includes('artifact.create') ?? false;
  const artifacts = data?.artifacts ?? [];
  const collectionState = resolveAsyncCollectionState({
    isLoading,
    isError: artifactsQuery.isError,
    itemCount: artifacts.length,
  });
  const versions = detail.data?.versions ?? [];
  const shown = viewVersion
    ? versions.find((v) => v.versionNo === viewVersion)
    : versions[versions.length - 1];
  const reviewNote = visibleVersionReviewNote(reviewNoteState, shown?.id);
  const setReviewNote = (note: string) => setReviewNoteState(shown ? { versionId: shown.id, note } : null);
  const exportPreflight = useArtifactExportPreflight(selected ?? undefined, shown?.versionNo);
  const currentPreflight = artifactPreflightMatchesVersion(shown?.versionNo, exportPreflight.data)
    ? exportPreflight.data
    : undefined;
  const preflightIssue = currentPreflight ? artifactPreflightIssue(currentPreflight) : null;
  const redTeamDetail = currentPreflight ? artifactRedTeamDetail(currentPreflight.redTeam) : null;
  const exportIssue = visibleVersionExportIssue(exportIssueState, shown?.id);
  const visiblePreflightIssue = exportIssue ?? preflightIssue;
  const exportBlocked = currentPreflight?.canExport === false;
  const currentReviewItem = reviewPlan.data?.worklist.find((item) => item.artifactVersionId === shown?.id);
  const humanReviewReady = isArtifactReviewGateReady(
    artifactContractV2.data,
    reviewPlan.isSuccess,
    currentReviewItem,
  );
  const reviewApprovalReady = isArtifactReviewApprovalReady(currentReviewItem, currentPreflight);
  const exportReady = humanReviewReady && isArtifactExportReady(
    shown?.versionNo,
    exportPreflight.isLoading,
    exportPreflight.isFetching,
    currentPreflight,
  );
  const filteredReviewItems = filterArtifactReviewItems(reviewPlan.data?.worklist ?? [], reviewFilter);
  const preflightChecking = Boolean(shown) && (exportPreflight.isLoading || exportPreflight.isFetching);

  const isModal = variant === 'modal';

  async function submitCreate() {
    if (!canEdit) return;
    if (!structuredMutationsReady) {
      toast('error', '서버 업데이트가 완료된 뒤 산출물을 저장할 수 있습니다.');
      return;
    }
    const pid = createProjectId;
    if (!pid || !title.trim() || !content.trim() || !governingMessage.trim() || !soWhat.trim()) return;
    if (createArtifact.isPending || !claimArtifactSubmission(createSubmission)) return;
    try {
      const res = await createArtifact.mutateAsync({
        projectId: pid,
        title: title.trim(),
        content,
        note: '초판',
        structure: {
          governingMessage: governingMessage.trim(),
          soWhat: soWhat.trim(),
        },
      });
      toast('success', '산출물 등록 완료');
      setCreating(false);
      setTitle('');
      setContent('');
      setGoverningMessage('');
      setSoWhat('');
      setSelected(res.id);
    } catch {
      toast('error', '등록에 실패했어요. 편집 권한이 있는지 확인해주세요.');
    } finally {
      createSubmission.current = false;
    }
  }

  async function submitVersion() {
    if (!canEdit) return;
    if (!structuredMutationsReady) {
      toast('error', '서버 업데이트가 완료된 뒤 새 버전을 저장할 수 있습니다.');
      return;
    }
    if (!selected || !vContent.trim() || !vGoverningMessage.trim() || !vSoWhat.trim()) return;
    if (addVersion.isPending || !claimArtifactSubmission(versionSubmission)) return;
    try {
      await addVersion.mutateAsync({
        id: selected,
        body: {
          content: vContent,
          note: vNote.trim(),
          structure: {
            governingMessage: vGoverningMessage.trim(),
            soWhat: vSoWhat.trim(),
          },
          ...vSource,
        },
      });
      toast('success', '버전 추가 완료');
      setVersionOpen(false);
      setVContent('');
      setVGoverningMessage('');
      setVSoWhat('');
      setVNote('');
      setVSource({});
      setViewVersion(null);
    } catch {
      toast('error', '버전 추가에 실패했어요.');
    } finally {
      versionSubmission.current = false;
    }
  }

  async function verifyCurrentVersion() {
    if (!canEdit) return;
    if (!selected || !shown) return;
    setExportIssueState(null);
    try {
      const result = await verifyVersion.mutateAsync({ id: selected, body: { versionNo: shown.versionNo } });
      const issue = artifactPreflightIssue(result);
      setExportIssueState(issue ? { versionId: shown.id, issue } : null);
      if (result.canExport) toast('success', `v${shown.versionNo} 본문 검증 통과`);
      else toast('error', issue?.title ?? '본문 검증이 차단되었습니다');
    } catch (err) {
      const issue = artifactExportIssue(err);
      setExportIssueState({ versionId: shown.id, issue });
      toast('error', issue.title);
    }
  }


  async function submitReview(action: 'approve' | 'reject') {
    if (!canEdit || !selected || !shown || !currentReviewItem) return;
    if (action === 'reject' && !reviewNote.trim()) {
      toast('error', '반려 사유를 입력해주세요.');
      return;
    }
    try {
      await reviewDecision.mutateAsync({
        id: selected,
        versionNo: shown.versionNo,
        body: { action, ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}) },
      });
      setReviewNoteState(null);
      setExportIssueState(null);
      await Promise.all([reviewPlan.refetch(), exportPreflight.refetch()]);
      toast('success', action === 'approve' ? '현재 버전 검토 승인 완료' : '현재 버전 검토 반려 완료');
    } catch {
      toast('error', action === 'approve' ? '검토 승인에 실패했습니다. 하드 차단 항목을 먼저 해결하세요.' : '검토 반려에 실패했습니다.');
    }
  }

  async function download(format: 'pdf' | 'docx') {
    if (!selected || !detail.data || !shown) return;
    setExporting(format);
    setExportIssueState(null);
    try {
      const preflight = await exportPreflight.refetch();
      if (!artifactPreflightMatchesVersion(shown.versionNo, preflight.data)) {
        const issue = {
          tone: 'blocked',
          title: '현재 버전의 검증 상태를 확인할 수 없습니다',
          messages: ['현재 버전의 검증 결과를 다시 불러온 뒤 내보내기를 시도하세요.'],
        } satisfies ExportPreflightIssue;
        setExportIssueState({ versionId: shown.id, issue });
        toast('error', issue.title);
        return;
      }
      if (!preflight.data.canExport) {
        const issue = artifactPreflightIssue(preflight.data) ?? {
          tone: 'blocked',
          title: '검증 게이트가 내보내기를 차단했습니다',
          messages: ['핵심 주장의 근거를 보강한 뒤 다시 시도하세요.'],
        } satisfies ExportPreflightIssue;
        setExportIssueState({ versionId: shown.id, issue });
        toast('error', issue.title);
        return;
      }
      await saveArtifactExport(selected, detail.data.title, format, shown.versionNo);
      toast('success', `${format.toUpperCase()} 다운로드 완료`);
    } catch (err) {
      const issue = artifactExportIssue(err);
      setExportIssueState({ versionId: shown.id, issue });
      toast('error', issue.title);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className={`${s.page} ${isModal ? s.modalPage : ''}`}>
      <div className={s.list}>
        <div className={s.listHead}>
          <span className={s.listHeadTitle}>
            {isModal ? null : (
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
            )}
            산출물
          </span>
          {canEdit && structuredMutationsReady ? (
            <Button type="button" variant="primary" size="sm" leadingIcon="file-text" onClick={() => setCreating(true)}>
              새 산출물
            </Button>
          ) : null}
          {canEdit && artifactContractV2.isSuccess && !structuredMutationsReady ? (
            <span className={s.muted}>서버 업데이트 중 · 산출물 편집 잠금</span>
          ) : null}
        </div>
        {projects.length > 0 ? (
          <div className={s.filterRow}>
            <Select
              className={s.filterSelect}
              size="sm"
              value={projectFilter}
              onValueChange={(next) => {
                setProjectFilter(next);
                setSelected(null);
                if (!isModal) {
                  void router.navigate({
                    to: '/artifacts',
                    search: next ? { projectId: next } : {},
                    replace: true,
                  });
                }
              }}
              ariaLabel="프로젝트로 산출물 필터"
              options={[
                { value: '', label: '전체 프로젝트' },
                ...projects.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </div>
        ) : null}
        {reviewProjectId && artifactContractV2.data === true ? (
          <section className={s.reviewQueue} aria-labelledby="artifact-review-queue-heading">
            <div className={s.reviewQueueHead}>
              <strong id="artifact-review-queue-heading">사람 검토</strong>
              <span>{reviewPlan.data ? `현재 페이지 · 대기 ${reviewPlan.data.summary.pending} · 반려 ${reviewPlan.data.summary.rejected} · 차단 ${reviewPlan.data.summary.blocked} · 무결성 ${reviewPlan.data.summary.invalid}` : '집계 중'}</span>
            </div>
            <Select
              className={s.filterSelect}
              size="sm"
              value={reviewFilter}
              onValueChange={setReviewFilter}
              ariaLabel="검토 큐 필터"
              options={[
                { value: 'pending', label: '승인 대기' },
                { value: 'critical', label: '긴급' },
                { value: 'high', label: '높음' },
                { value: 'medium', label: '주의' },
                { value: 'approved', label: '승인됨' },
                { value: 'rejected', label: '반려됨' },
                { value: 'all', label: '전체' },
              ]}
            />
            {reviewPlan.isLoading ? <p className={s.reviewEmpty}>검토 큐를 불러오는 중…</p> : null}
            {reviewPlan.isError ? <p className={s.reviewEmpty}>검토 큐를 불러오지 못했습니다. 내보내기는 잠깁니다.</p> : null}
            {reviewPlan.isSuccess && filteredReviewItems.length === 0 ? <p className={s.reviewEmpty}>해당 항목이 없습니다.</p> : null}
            <div className={s.reviewItems}>
              {filteredReviewItems.map((item) => (
                <button
                  type="button"
                  key={item.artifactVersionId}
                  className={s.reviewItem}
                  data-priority={item.priority}
                  onClick={() => {
                    setSelected(item.artifactId);
                    setViewVersion(item.versionNo);
                    setExportIssueState(null);
                  }}
                >
                  <span>{item.title}</span>
                  <small>v{item.versionNo} · {reviewStatusLabel(item.reviewStatus)} · {reviewPriorityLabel(item.priority)}</small>
                </button>
              ))}
            </div>
            {reviewPlan.data && (reviewOffsetHistory.length > 0 || reviewPlan.data.cohort.nextOffset !== null) ? (
              <div className={s.filterRow}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={reviewPlan.isFetching || reviewOffsetHistory.length === 0}
                  onClick={() => setReviewPage(previousArtifactReviewPage(reviewProjectId, reviewOffsetHistory))}
                >
                  이전 페이지
                </Button>
                <span className={s.muted}>
                  {reviewPlan.data.cohort.returned === 0 ? 0 : reviewPlan.data.cohort.offset + 1}
                  –{reviewPlan.data.cohort.offset + reviewPlan.data.cohort.returned}
                  / {reviewPlan.data.cohort.totalCandidates}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={reviewPlan.isFetching || reviewPlan.data.cohort.nextOffset === null}
                  onClick={() => setReviewPage(nextArtifactReviewPage(
                    reviewProjectId,
                    reviewOffset,
                    reviewOffsetHistory,
                    reviewPlan.data.cohort.nextOffset ?? reviewOffset,
                  ))}
                >
                  다음 페이지
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}
        {isLoading ? <div className={s.muted}>불러오는 중…</div> : null}
        {collectionState === 'error' ? (
          <div className={s.muted}>
            산출물을 불러오지 못했어요.
            <br />
            <Button type="button" variant="outline" size="sm" onClick={() => void artifactsQuery.refetch()}>다시 시도</Button>
          </div>
        ) : null}
        {collectionState === 'empty' ? (
          <div className={s.muted}>
            {artifactOffset > 0 ? '다음 페이지에 산출물이 없습니다.' : (
              <>아직 산출물이 없어요.<br />채팅에서 지구 답변을 저장하거나 직접 만들어보세요.</>
            )}
          </div>
        ) : null}
        {artifacts.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`${s.item} ${selected === a.id ? s.itemOn : ''}`}
            onClick={() => {
              setSelected(a.id);
              setViewVersion(null);
              setExportIssueState(null);
            }}
          >
            <span className={s.itemTitle}>{a.title}</span>
            <span className={s.itemMeta}>
              <span>v{a.headVersion}</span>
              <span className={s.dateChip} title={formatFullDateTime(a.updatedAt)}>{formatDateLabel(a.updatedAt)}</span>
            </span>
          </button>
        ))}
        {artifactContractV2.data === true && (artifactOffsetHistory.length > 0 || artifacts.length === 500) ? (
          <div className={s.filterRow}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={artifactsQuery.isFetching || artifactOffsetHistory.length === 0}
              onClick={() => setArtifactPage(previousArtifactReviewPage(artifactPageScope, artifactOffsetHistory))}
            >
              이전 페이지
            </Button>
            <span className={s.muted}>
              {artifacts.length === 0 ? 0 : artifactOffset + 1}–{artifactOffset + artifacts.length}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={artifactsQuery.isFetching || artifacts.length < 500}
              onClick={() => setArtifactPage(nextArtifactReviewPage(
                artifactPageScope,
                artifactOffset,
                artifactOffsetHistory,
                artifactOffset + artifacts.length,
              ))}
            >
              다음 페이지
            </Button>
          </div>
        ) : null}
      </div>

      <div className={s.viewer}>
        {creating && canEdit ? (
          <div className={s.editor}>
            <div className={s.editorTitle}>새 산출물</div>
            <Select
              className={s.input}
              value={createProjectId}
              onValueChange={setProjectId}
              ariaLabel="프로젝트 선택"
              placeholder="프로젝트 선택"
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
            <Input
              className={s.input}
              placeholder="제목 (예: 공공시설 적정성 1차 보고)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <label className={s.field}>
              <span className={s.fieldLabel}>핵심 결론</span>
              <Input
                className={s.input}
                placeholder="이 산출물 전체를 지배하는 한 문장 결론"
                value={governingMessage}
                onChange={(e) => setGoverningMessage(e.target.value)}
                maxLength={500}
              />
            </label>
            <label className={s.field}>
              <span className={s.fieldLabel}>의사결정 의미</span>
              <Input
                className={s.input}
                placeholder="그래서 무엇을 결정하거나 바꿔야 하는지"
                value={soWhat}
                onChange={(e) => setSoWhat(e.target.value)}
                maxLength={1000}
              />
            </label>
            <Textarea
              className={`${s.input} ${s.textarea}`}
              placeholder="마크다운 본문…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <div className={s.formActions}>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                취소
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={createArtifact.isPending || !title.trim() || !content.trim() || !governingMessage.trim() || !soWhat.trim()}
                onClick={() => void submitCreate()}
              >
                등록
              </Button>
            </div>
          </div>
        ) : !selected ? (
          <div className={s.placeholder}>
            <EmptyState icon="file-text" title="산출물을 선택하세요" description="채널 대화에서 확정된 답변·보고서를 보관하고 PDF/DOCX로 내보내는 공간입니다." />
          </div>
        ) : detail.isLoading ? (
          <div className={s.placeholder}>불러오는 중…</div>
        ) : detail.isError ? (
          <div className={s.placeholder}>
            <EmptyState
              icon="info"
              title="산출물 상세를 불러오지 못했어요"
              description="연결 상태를 확인한 뒤 다시 시도해주세요."
              action={<Button type="button" variant="outline" size="sm" onClick={() => void detail.refetch()}>다시 시도</Button>}
            />
          </div>
        ) : detail.data ? (
          <>
            <div className={s.viewHead}>
              <div>
                <div className={s.viewTitle}>{detail.data.title}</div>
                <div className={s.viewSub}>
                  {shown ? `v${shown.versionNo}${shown.note ? ` — ${shown.note}` : ''}` : ''}
                  {shown?.authorName ? ` · ${shown.authorName}` : ''}
                </div>
              </div>
              <div className={s.headActions}>
                {canEdit ? (
                  <Button
                    type="button"
                    variant={exportBlocked ? 'primary' : 'ghost'}
                    size="sm"
                    disabled={verifyVersion.isPending || !shown}
                    onClick={() => void verifyCurrentVersion()}
                  >
                    {verifyVersion.isPending ? '검증 중…' : '본문 검증'}
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" size="sm" disabled={Boolean(exporting) || !exportReady} onClick={() => void download('pdf')}>
                  {exporting === 'pdf' ? 'PDF 생성 중…' : 'PDF'}
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={Boolean(exporting) || !exportReady} onClick={() => void download('docx')}>
                  {exporting === 'docx' ? 'DOCX 생성 중…' : 'DOCX'}
                </Button>
                {canEdit && structuredMutationsReady ? (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    leadingIcon="file-text"
                    onClick={() => {
                      setVContent(shown?.content ?? '');
                      setVGoverningMessage(shown?.governingMessage ?? '');
                      setVSoWhat(shown?.soWhat ?? '');
                      setVSource(createArtifactVersionSourceSnapshot(shown));
                      setVersionOpen(true);
                    }}
                  >
                    새 버전
                  </Button>
                ) : null}
              </div>
            </div>
            <div className={s.timeline}>
              {versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={`${s.vChip} ${
                    (viewVersion ?? detail.data.headVersion) === v.versionNo ? s.vChipOn : ''
                  }`}
                  title={v.note || `버전 ${v.versionNo}`}
                  onClick={() => {
                    setViewVersion(v.versionNo);
                    setExportIssueState(null);
                  }}
                >
                  v{v.versionNo}
                </button>
              ))}
            </div>
            {currentReviewItem ? (
              <section className={s.reviewCard} data-status={currentReviewItem.reviewStatus} aria-labelledby="artifact-review-heading">
                <div className={s.reviewCardHead}>
                  <div>
                    <strong id="artifact-review-heading">사람 검토 · {reviewStatusLabel(currentReviewItem.reviewStatus)}</strong>
                    <p>{reviewPriorityLabel(currentReviewItem.priority)} · {currentReviewItem.reasons.join(' · ')}</p>
                  </div>
                  {currentReviewItem.latestDecision ? <small>{formatFullDateTime(currentReviewItem.latestDecision.decidedAt)}</small> : null}
                </div>
                {currentReviewItem.latestDecision?.note ? <p className={s.reviewDecisionNote}>{currentReviewItem.latestDecision.note}</p> : null}
                {canEdit && currentReviewItem.reviewStatus !== 'blocked' && currentReviewItem.reviewStatus !== 'invalid' && currentReviewItem.reviewStatus !== 'rejected' ? (
                  <div className={s.reviewActions}>
                    <Textarea
                      className={s.reviewNote}
                      placeholder="검토 메모 · 반려 시 사유 필수"
                      value={reviewNote}
                      onChange={(event) => setReviewNote(event.target.value)}
                      maxLength={1000}
                    />
                    <div>
                      <Button type="button" variant="outline" size="sm" disabled={reviewDecision.isPending || !reviewNote.trim()} onClick={() => void submitReview('reject')}>
                        반려
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={reviewDecision.isPending || !reviewApprovalReady}
                        onClick={() => void submitReview('approve')}
                      >
                        승인
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}
            {visiblePreflightIssue ? (
              <div className={s.preflightBanner} data-tone={visiblePreflightIssue.tone} role={visiblePreflightIssue.tone === 'blocked' ? 'alert' : 'status'}>
                <strong>{visiblePreflightIssue.title}</strong>
                <ul>
                  {visiblePreflightIssue.messages.map((message) => <li key={message}>{message}</li>)}
                </ul>
              </div>
            ) : preflightChecking ? (
              <div className={s.preflightBanner} data-tone="neutral" role="status" aria-live="polite">
                <strong>현재 버전의 검증 상태를 확인하고 있습니다</strong>
                <p>확인이 끝날 때까지 PDF와 DOCX 내보내기는 잠깁니다.</p>
              </div>
            ) : exportReady ? (
              <div className={s.preflightBanner} data-tone="passed" role="status">
                <strong>현재 버전 검증 통과</strong>
                <p>정확한 본문과 근거 검증이 일치해 PDF와 DOCX로 내보낼 수 있습니다.</p>
              </div>
            ) : null}
            {redTeamDetail ? (
              <div className={s.preflightBanner} data-tone={redTeamDetail.tone} role="status" data-testid="artifact-red-team-detail">
                <strong>{redTeamDetail.title}</strong>
                <p>{redTeamDetail.meta}</p>
                {redTeamDetail.findings.length > 0 ? (
                  <ul>
                    {redTeamDetail.findings.map((finding) => (
                      <li key={finding.key}>
                        <b>{finding.label}</b> — {finding.message}
                        {finding.defense ? <div>방어: {finding.defense}</div> : null}
                      </li>
                    ))}
                  </ul>
                ) : <p>등록된 공격·방어 항목이 없습니다.</p>}
              </div>
            ) : null}
            {shown ? (
              <div className={s.structureSummary} aria-label="산출물 의사결정 구조">
                <section data-missing={!shown.governingMessage || undefined}>
                  <strong>핵심 결론</strong>
                  <p>{shown.governingMessage || '입력되지 않았습니다.'}</p>
                </section>
                <section data-missing={!shown.soWhat || undefined}>
                  <strong>의사결정 의미</strong>
                  <p>{shown.soWhat || '입력되지 않았습니다.'}</p>
                </section>
              </div>
            ) : null}

            {versionOpen && canEdit ? (
              <div className={s.editor}>
                <Input
                  className={s.input}
                  placeholder="변경 메모 (예: 수치 보강)"
                  value={vNote}
                  onChange={(e) => setVNote(e.target.value)}
                />
                <label className={s.field}>
                  <span className={s.fieldLabel}>핵심 결론</span>
                  <Input
                    className={s.input}
                    value={vGoverningMessage}
                    onChange={(e) => setVGoverningMessage(e.target.value)}
                    maxLength={500}
                  />
                </label>
                <label className={s.field}>
                  <span className={s.fieldLabel}>의사결정 의미</span>
                  <Input
                    className={s.input}
                    value={vSoWhat}
                    onChange={(e) => setVSoWhat(e.target.value)}
                    maxLength={1000}
                  />
                </label>
                <Textarea
                  className={`${s.input} ${s.textarea}`}
                  placeholder="새 버전 마크다운 본문…"
                  value={vContent}
                  onChange={(e) => setVContent(e.target.value)}
                />
                <div className={s.formActions}>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={addVersion.isPending || !vContent.trim() || !vGoverningMessage.trim() || !vSoWhat.trim()}
                    onClick={() => void submitVersion()}
                  >
                    버전 추가
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setVContent(shown?.content ?? '');
                      setVGoverningMessage(shown?.governingMessage ?? '');
                      setVSoWhat(shown?.soWhat ?? '');
                      setVSource(createArtifactVersionSourceSnapshot(shown));
                      toast('info', '현재 버전 불러옴');
                    }}
                  >
                    현재 버전
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setVersionOpen(false)}>
                    닫기
                  </Button>
                </div>
              </div>
            ) : null}
            <div className={s.doc}>{shown ? <Markdown text={shown.content} /> : null}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function reviewStatusLabel(status: 'not_required' | 'pending' | 'approved' | 'rejected' | 'blocked' | 'invalid'): string {
  return ({
    not_required: '검토 불필요',
    pending: '승인 대기',
    approved: '승인됨',
    rejected: '반려됨',
    blocked: '게이트 차단',
    invalid: '원장 무결성 오류',
  })[status];
}

function reviewPriorityLabel(priority: 'critical' | 'high' | 'medium' | 'clear'): string {
  return ({ critical: '긴급', high: '높음', medium: '주의', clear: '정상' })[priority];
}

export function isArtifactHumanReviewReady(item: ArtifactReviewWorklistItem | undefined): boolean {
  if (!item) return true;
  if (item.reviewStatus === 'rejected' || item.reviewStatus === 'blocked' || item.reviewStatus === 'invalid') return false;
  return !item.needsHumanReview || item.reviewStatus === 'approved';
}

export function isArtifactReviewGateReady(
  contractV2: boolean | undefined,
  reviewPlanReady: boolean,
  item: ArtifactReviewWorklistItem | undefined,
): boolean {
  if (contractV2 === false) return true;
  return contractV2 === true && reviewPlanReady && isArtifactHumanReviewReady(item);
}

export function isArtifactReviewApprovalReady(
  item: ArtifactReviewWorklistItem | undefined,
  preflight: Pick<ArtifactExportPreflightResponse, 'canExport' | 'reason' | 'redTeam'> | undefined,
): boolean {
  return Boolean(
    item?.needsHumanReview
    && item.priority === 'medium'
    && item.reviewStatus === 'pending'
    && preflight?.reason === 'HUMAN_REVIEW_REQUIRED'
    && preflight.redTeam.verdict !== 'BLOCKED'
    && (preflight.redTeam.mode !== 'warning' || preflight.redTeam.status === 'completed'),
  );
}

export function filterArtifactReviewItems(items: ArtifactReviewWorklistItem[], filter: string): ArtifactReviewWorklistItem[] {
  return items.filter((item) => {
    if (filter === 'all') return true;
    if (filter === 'critical' || filter === 'high' || filter === 'medium' || filter === 'clear') return item.priority === filter;
    return item.reviewStatus === filter;
  });
}

export function isArtifactExportReady(
  viewedVersionNo: number | undefined,
  isLoading: boolean,
  _isFetching: boolean,
  preflight: Pick<ArtifactExportPreflightResponse, 'versionNo' | 'canExport'> | undefined,
): boolean {
  return !isLoading
    && artifactPreflightMatchesVersion(viewedVersionNo, preflight)
    && preflight.canExport === true;
}

export function artifactPreflightMatchesVersion(
  viewedVersionNo: number | undefined,
  preflight: Pick<ArtifactExportPreflightResponse, 'versionNo'> | undefined,
): preflight is Pick<ArtifactExportPreflightResponse, 'versionNo'> {
  return viewedVersionNo !== undefined && preflight?.versionNo === viewedVersionNo;
}

export function claimArtifactSubmission(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function artifactVersionSource(
  version: { sourceThreadId: string | null; sourceMessageId: string | null } | undefined,
): { sourceThreadId?: string; sourceMessageId?: string } {
  return {
    ...(version?.sourceThreadId ? { sourceThreadId: version.sourceThreadId } : {}),
    ...(version?.sourceMessageId ? { sourceMessageId: version.sourceMessageId } : {}),
  };
}

export function createArtifactVersionSourceSnapshot(
  version: { sourceThreadId: string | null; sourceMessageId: string | null } | undefined,
): { sourceThreadId?: string; sourceMessageId?: string } {
  return artifactVersionSource(version);
}

export function resolveArtifactProjectId(
  explicitProjectId: string,
  filteredProjectId: string,
  projects: Array<{ id: string }>,
): string {
  const validIds = new Set(projects.map((project) => project.id));
  if (explicitProjectId && validIds.has(explicitProjectId)) return explicitProjectId;
  if (filteredProjectId && validIds.has(filteredProjectId)) return filteredProjectId;
  return projects[0]?.id ?? '';
}

export function visibleVersionExportIssue(
  state: VersionBoundExportIssue | null,
  versionId: string | undefined,
): ExportPreflightIssue | null {
  return state && state.versionId === versionId ? state.issue : null;
}

export function visibleVersionReviewNote(
  state: VersionBoundReviewNote | null,
  versionId: string | undefined,
): string {
  return state && state.versionId === versionId ? state.note : '';
}

export function nextArtifactReviewPage(
  projectId: string,
  currentOffset: number,
  history: number[],
  nextOffset: number,
): ReviewPageState {
  return { projectId, offset: nextOffset, history: [...history, currentOffset] };
}

export function previousArtifactReviewPage(projectId: string, history: number[]): ReviewPageState {
  return {
    projectId,
    offset: history.at(-1) ?? 0,
    history: history.slice(0, -1),
  };
}

export function artifactRedTeamDetail(redTeam: ArtifactExportPreflightResponse['redTeam']): {
  tone: 'passed' | 'warn' | 'blocked' | 'neutral';
  title: string;
  meta: string;
  findings: Array<{ key: string; label: string; message: string; defense: string | null }>;
} | null {
  if (redTeam.mode === 'off' || redTeam.status === 'disabled') return null;
  const statusLabels: Record<string, string> = {
    missing: '결과 없음',
    pending: '대기 중',
    processing: '검토 중',
    completed: '검토 완료',
    failed: '검토 실패',
    stale: '재검토 필요',
  };
  const verdictLabel = redTeam.verdict === 'PASS'
    ? '통과'
    : redTeam.verdict === 'PASS_WITH_WARNINGS'
      ? '주의 포함 통과'
      : redTeam.verdict === 'BLOCKED'
        ? '차단'
        : '판정 전';
  const tone = redTeam.verdict === 'BLOCKED'
    ? 'blocked'
    : redTeam.verdict === 'PASS'
      ? 'passed'
      : redTeam.status === 'completed'
        ? 'warn'
        : 'neutral';
  return {
    tone,
    title: `적대 검토 · ${verdictLabel}`,
    meta: [
      statusLabels[redTeam.status] ?? redTeam.status,
      redTeam.policyVersion ? `정책 ${redTeam.policyVersion}` : null,
      redTeam.reviewedAt ? `검토 ${formatFullDateTime(redTeam.reviewedAt)}` : null,
    ].filter(Boolean).join(' · '),
    findings: redTeam.attacks.map((attack, index) => {
      const defense = redTeam.defenses.find((item) => item.attackIndex === index);
      const disposition = defense?.disposition === 'mitigated'
        ? '완화됨'
        : defense?.disposition === 'sustained'
          ? '공격 유지'
          : defense?.disposition === 'unresolved'
            ? '미해결'
            : null;
      return {
        key: `${index}-${attack.persona}-${attack.category}`,
        label: `${attack.persona} · ${attack.severity === 'blocker' ? '차단' : '주의'} · ${attack.category}`,
        message: attack.message,
        defense: defense ? `${defense.response}${disposition ? ` (${disposition})` : ''}` : null,
      };
    }),
  };
}

export function artifactPreflightIssue(preflight: ArtifactExportPreflightResponse): ExportPreflightIssue | null {
  if (preflight.reason === 'OK' && preflight.messages.length === 0) return null;
  const messages = summarizeRepeatedMessages(preflight.messages);
  if (preflight.reason === 'ARTIFACT_VERIFICATION_REQUIRED') {
    return {
      tone: 'blocked',
      title: '현재 버전의 본문 검증이 필요합니다',
      messages,
    };
  }
  if (preflight.reason === 'ARTIFACT_STRUCTURE_REQUIRED') {
    return {
      tone: 'blocked',
      title: '내보내기 전에 의사결정 구조가 필요합니다',
      messages,
    };
  }
  if (preflight.reason === 'VERIFIER_GATE_BLOCKED') {
    return {
      tone: 'blocked',
      title: '검증 게이트가 내보내기를 차단했습니다',
      messages: messages.length > 0 ? messages : ['핵심 주장의 근거를 보강한 뒤 다시 시도하세요.'],
    };
  }
  const redTeamWarning = preflight.redTeam.mode === 'warning'
    && preflight.redTeam.status !== 'disabled'
    && (preflight.redTeam.status !== 'completed' || preflight.redTeam.verdict !== 'PASS');
  return {
    tone: 'warn',
    title: redTeamWarning ? '적대 검토 경고가 있습니다' : '검증 경고가 있습니다',
    messages,
  };
}

function artifactExportIssue(err: unknown): ExportPreflightIssue {
  if (err instanceof ApiClientError && err.code === 'VERIFIER_GATE_BLOCKED') {
    const gateMessages = summarizeRepeatedMessages(extractVerifierGateMessages(err.details));
    const structureBlocked = isRecord(err.details) && err.details.reason === 'ARTIFACT_STRUCTURE_REQUIRED';
    return {
      tone: 'blocked',
      title: structureBlocked ? '내보내기 전에 의사결정 구조가 필요합니다' : '검증 게이트가 내보내기를 차단했습니다',
      messages: gateMessages.length > 0 ? gateMessages : [err.message],
    };
  }
  return {
    tone: 'blocked',
    title: '산출물 내보내기에 실패했습니다',
    messages: [err instanceof Error ? err.message : '권한, 네트워크, 또는 파일 생성 상태를 확인해주세요.'],
  };
}

function summarizeRepeatedMessages(messages: string[]): string[] {
  const counts = new Map<string, number>();
  for (const message of messages) counts.set(message, (counts.get(message) ?? 0) + 1);
  return [...counts].map(([message, count]) => count > 1 ? `${message} (${count}건)` : message);
}

function extractVerifierGateMessages(details: unknown): string[] {
  if (!isRecord(details)) return [];
  const explicitMessages = asArray(details.messages)
    .filter((message): message is string => typeof message === 'string');
  const gate = isRecord(details.gate) ? details.gate : {};
  const rows = [...asArray(gate.blockers), ...asArray(gate.warnings)];
  return [
    ...explicitMessages,
    ...rows
      .map((row) => (isRecord(row) && typeof row.message === 'string' ? row.message : null))
      .filter((message): message is string => Boolean(message)),
  ];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
