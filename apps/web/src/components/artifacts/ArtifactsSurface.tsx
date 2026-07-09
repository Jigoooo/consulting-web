import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { ApiClientError } from '@consulting/api-client';
import type { ArtifactExportPreflightResponse } from '@consulting/contracts';
import { useSelectedWorkspace } from '../../lib/wsStore';
import { useLastThread } from '../../lib/threadCtx';
import { useWorkspaceTree } from '../../lib/spaces';
import { useArtifacts, useArtifactDetail, useCreateArtifact, useAddArtifactVersion, useArtifactExportPreflight, saveArtifactExport } from '../../lib/collab';
import { Markdown } from '../../shared/ui/markdown/Markdown';
import { useToast } from '../../shared/ui/toast/Toast';
import { Button } from '../../shared/ui/button/Button';
import { Input, Textarea } from '../../shared/ui/input/Input';
import { Select } from '../../shared/ui/select/Select';
import { EmptyState } from '../../shared/ui/feedback/EmptyState';
import { formatDateLabel, formatFullDateTime } from '../../shared/lib/formatDate';
import s from './Artifacts.module.css';

type ExportPreflightIssue = {
  tone: 'warn' | 'blocked';
  title: string;
  messages: string[];
};

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
  const { data, isLoading } = useArtifacts(workspaceId ?? undefined, projectFilter || undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useArtifactDetail(selected ?? undefined);
  const createArtifact = useCreateArtifact(workspaceId ?? undefined);
  const addVersion = useAddArtifactVersion(workspaceId ?? undefined);
  const toast = useToast();

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [projectId, setProjectId] = useState('');
  const [versionOpen, setVersionOpen] = useState(false);
  const [vContent, setVContent] = useState('');
  const [vNote, setVNote] = useState('');
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null);
  const [exportIssue, setExportIssue] = useState<ExportPreflightIssue | null>(null);

  const projects = tree?.projects ?? [];
  const artifacts = data?.artifacts ?? [];
  const versions = detail.data?.versions ?? [];
  const shown = viewVersion
    ? versions.find((v) => v.versionNo === viewVersion)
    : versions[versions.length - 1];
  const exportPreflight = useArtifactExportPreflight(selected ?? undefined, shown?.versionNo);
  const preflightIssue = exportPreflight.data ? artifactPreflightIssue(exportPreflight.data) : null;
  const sourceWarning = shown && !shown.sourceMessageId ? artifactSourceWarning() : null;
  const visiblePreflightIssue = exportIssue ?? preflightIssue ?? sourceWarning;
  const exportBlocked = exportPreflight.data?.canExport === false;

  const isModal = variant === 'modal';

  async function submitCreate() {
    const pid = projectId || projects[0]?.id;
    if (!pid || !title.trim() || !content.trim()) return;
    try {
      const res = await createArtifact.mutateAsync({
        projectId: pid,
        title: title.trim(),
        content,
        note: '초판',
      });
      toast('success', '산출물 등록 완료');
      setCreating(false);
      setTitle('');
      setContent('');
      setSelected(res.id);
    } catch {
      toast('error', '등록에 실패했어요. 편집 권한이 있는지 확인해주세요.');
    }
  }

  async function submitVersion() {
    if (!selected || !vContent.trim()) return;
    try {
      await addVersion.mutateAsync({ id: selected, body: { content: vContent, note: vNote.trim() } });
      toast('success', '버전 추가 완료');
      setVersionOpen(false);
      setVContent('');
      setVNote('');
      setViewVersion(null);
    } catch {
      toast('error', '버전 추가에 실패했어요.');
    }
  }

  async function download(format: 'pdf' | 'docx') {
    if (!selected || !detail.data || !shown) return;
    setExporting(format);
    setExportIssue(null);
    try {
      const preflight = await exportPreflight.refetch();
      if (preflight.data && !preflight.data.canExport) {
        const issue = artifactPreflightIssue(preflight.data) ?? {
          tone: 'blocked',
          title: '검증 게이트가 내보내기를 차단했습니다',
          messages: ['핵심 주장의 근거를 보강한 뒤 다시 시도하세요.'],
        } satisfies ExportPreflightIssue;
        setExportIssue(issue);
        toast('error', issue.title);
        return;
      }
      await saveArtifactExport(selected, detail.data.title, format, shown.versionNo);
      toast('success', `${format.toUpperCase()} 다운로드 완료`);
    } catch (err) {
      const issue = artifactExportIssue(err);
      setExportIssue(issue);
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
          <Button type="button" variant="primary" size="sm" leadingIcon="file-text" onClick={() => setCreating(true)}>
            새 산출물
          </Button>
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
        {isLoading ? <div className={s.muted}>불러오는 중…</div> : null}
        {!isLoading && artifacts.length === 0 ? (
          <div className={s.muted}>
            아직 산출물이 없어요.
            <br />
            채팅에서 지구 답변을 저장하거나 직접 만들어보세요.
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
              setExportIssue(null);
            }}
          >
            <span className={s.itemTitle}>{a.title}</span>
            <span className={s.itemMeta}>
              <span>v{a.headVersion}</span>
              <span className={s.dateChip} title={formatFullDateTime(a.updatedAt)}>{formatDateLabel(a.updatedAt)}</span>
            </span>
          </button>
        ))}
      </div>

      <div className={s.viewer}>
        {creating ? (
          <div className={s.editor}>
            <div className={s.editorTitle}>새 산출물</div>
            <Select
              className={s.input}
              value={projectId || (projects[0]?.id ?? '')}
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
              <Button type="button" variant="primary" disabled={createArtifact.isPending} onClick={() => void submitCreate()}>
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
                <Button type="button" variant="ghost" size="sm" disabled={Boolean(exporting) || exportBlocked} onClick={() => void download('pdf')}>
                  {exporting === 'pdf' ? 'PDF 생성 중…' : 'PDF'}
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={Boolean(exporting) || exportBlocked} onClick={() => void download('docx')}>
                  {exporting === 'docx' ? 'DOCX 생성 중…' : 'DOCX'}
                </Button>
                <Button type="button" variant="primary" size="sm" leadingIcon="file-text" onClick={() => setVersionOpen(true)}>
                  새 버전
                </Button>
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
                    setExportIssue(null);
                  }}
                >
                  v{v.versionNo}
                </button>
              ))}
            </div>
            {visiblePreflightIssue ? (
              <div className={s.preflightBanner} data-tone={visiblePreflightIssue.tone} role={visiblePreflightIssue.tone === 'blocked' ? 'alert' : 'status'}>
                <strong>{visiblePreflightIssue.title}</strong>
                <ul>
                  {visiblePreflightIssue.messages.map((message) => <li key={message}>{message}</li>)}
                </ul>
              </div>
            ) : null}
            {versionOpen ? (
              <div className={s.editor}>
                <Input
                  className={s.input}
                  placeholder="변경 메모 (예: 수치 보강)"
                  value={vNote}
                  onChange={(e) => setVNote(e.target.value)}
                />
                <Textarea
                  className={`${s.input} ${s.textarea}`}
                  placeholder="새 버전 마크다운 본문…"
                  value={vContent}
                  onChange={(e) => setVContent(e.target.value)}
                />
                <div className={s.formActions}>
                  <Button type="button" variant="primary" disabled={addVersion.isPending} onClick={() => void submitVersion()}>
                    버전 추가
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setVContent(shown?.content ?? '');
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

function artifactPreflightIssue(preflight: ArtifactExportPreflightResponse): ExportPreflightIssue | null {
  if (preflight.reason === 'OK' && preflight.messages.length === 0) return null;
  if (preflight.reason === 'VERIFIER_GATE_BLOCKED') {
    return {
      tone: 'blocked',
      title: '검증 게이트가 내보내기를 차단했습니다',
      messages: preflight.messages.length > 0 ? preflight.messages : ['핵심 주장의 근거를 보강한 뒤 다시 시도하세요.'],
    };
  }
  if (preflight.reason === 'NO_SOURCE_MESSAGE') {
    return {
      tone: 'warn',
      title: '검증 연결이 없는 산출물입니다',
      messages: preflight.messages,
    };
  }
  return {
    tone: 'warn',
    title: '검증 경고가 있습니다',
    messages: preflight.messages,
  };
}

function artifactSourceWarning(): ExportPreflightIssue {
  return {
    tone: 'warn',
    title: '검증 연결이 없는 산출물입니다',
    messages: [
      '이 버전은 원본 답변(sourceMessageId)과 연결되지 않아 내보내기 전 검증 게이트가 문장별 판정을 확인할 수 없습니다.',
      '외부 제출 전에는 검증된 채팅 답변에서 다시 저장하거나, 근거검증 패널에서 차단 사유가 없는지 확인하세요.',
    ],
  };
}

function artifactExportIssue(err: unknown): ExportPreflightIssue {
  if (err instanceof ApiClientError && err.code === 'VERIFIER_GATE_BLOCKED') {
    const gateMessages = extractVerifierGateMessages(err.details);
    return {
      tone: 'blocked',
      title: '검증 게이트가 내보내기를 차단했습니다',
      messages: gateMessages.length > 0 ? gateMessages : [err.message],
    };
  }
  return {
    tone: 'blocked',
    title: '산출물 내보내기에 실패했습니다',
    messages: [err instanceof Error ? err.message : '권한, 네트워크, 또는 파일 생성 상태를 확인해주세요.'],
  };
}

function extractVerifierGateMessages(details: unknown): string[] {
  if (!isRecord(details) || !isRecord(details.gate)) return [];
  const rows = [...asArray(details.gate.blockers), ...asArray(details.gate.warnings)];
  return rows
    .map((row) => (isRecord(row) && typeof row.message === 'string' ? row.message : null))
    .filter((message): message is string => Boolean(message));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
