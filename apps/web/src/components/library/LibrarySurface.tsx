import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useSelectedWorkspace } from '../../lib/wsStore';
import { useLastThread } from '../../lib/threadCtx';
import { useWorkspaceTree } from '../../lib/spaces';
import { useLibrarySources } from '../../lib/collab';
import { workspaceModalStore } from '../../lib/workspaceModalStore';
import type { LibrarySourceItem } from '@consulting/contracts';
import { Select } from '../../shared/ui/select/Select';
import { Button } from '../../shared/ui/button/Button';
import { Input } from '../../shared/ui/input/Input';
import { Icon } from '../../shared/icons/Icon';
import type { IconName } from '../../shared/icons/registry';
import { EmptyState, Spinner } from '../../shared/ui/feedback/EmptyState';
import { useDelayedFlag } from '../../shared/lib/useDelayedFlag';
import { formatDateLabel, formatFullDateTime } from '../../shared/lib/formatDate';
import { FileViewer, type FileViewerTarget } from '../../widgets/file-viewer/ui/FileViewer';
import s from './Library.module.css';

const KIND_ICON: Record<string, IconName> = {
  evidence: 'pin',
  attachment: 'files',
};
const TYPE_LABEL: Record<string, string> = {
  gbrain: '지식그래프',
  web: '웹',
  file: '파일',
  tool: '도구',
  manual: '직접 첨부',
  document: '업로드 문서',
};
const TYPE_OPTIONS = [
  { value: '', label: '전체 종류' },
  { value: 'document', label: '업로드 문서' },
  { value: 'gbrain', label: '지식그래프 근거' },
  { value: 'web', label: '웹 근거' },
  { value: 'manual', label: '직접 첨부 근거' },
];

export function LibrarySurface({
  variant = 'page',
}: {
  variant?: 'page' | 'modal';
}) {
  const workspaceId = useSelectedWorkspace();
  const router = useRouter();
  const lastThreadId = useLastThread();
  const { data: tree } = useWorkspaceTree(workspaceId ?? undefined);
  const [projectFilter, setProjectFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [query, setQuery] = useState('');
  const { data, isLoading } = useLibrarySources(workspaceId ?? undefined, {
    ...(projectFilter ? { projectId: projectFilter } : {}),
    ...(typeFilter ? { type: typeFilter } : {}),
    ...(query.trim() ? { q: query.trim() } : {}),
  });
  const [viewer, setViewer] = useState<FileViewerTarget | null>(null);
  const showLoading = useDelayedFlag(isLoading, 300, 260);

  const projects = tree?.projects ?? [];
  // 자료실 = 근거·업로드 문서 참고자료 전용. 산출물(편집·버전·PDF 내보내기가 있는
  // 능동 작업물)은 사이드바 "산출물 보관함"으로 분리했으므로 여기서는 제외한다.
  const sources = (data?.sources ?? []).filter((item) => item.kind !== 'artifact');
  const isModal = variant === 'modal';

  function openItem(item: LibrarySourceItem) {
    if (item.kind === 'attachment') {
      setViewer({ id: item.id, fileName: item.title, mimeType: item.mimeType ?? 'application/octet-stream' });
      return;
    }
    // evidence: 출처 대화로 딥링크(있으면 답변 메시지까지 정밀 점프) 또는 외부 URL.
    if (item.kind === 'evidence') {
      if (item.threadId) {
        workspaceModalStore.close();
        void router.navigate({
          to: '/th/$threadId',
          params: { threadId: item.threadId },
          ...(item.messageId ? { search: { m: item.messageId } } : {}),
        });
      } else if (item.url) {
        window.open(item.url, '_blank', 'noreferrer,noopener');
      }
    }
  }

  return (
    <div className={`${s.page} ${isModal ? s.modalPage : ''}`}>
      <div className={s.main}>
        <div className={s.head}>
          <div className={s.headTitle}>
            {isModal ? null : (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                leadingIcon="arrow-left"
                className={s.backBtn}
                title={lastThreadId ? '마지막 채널로 돌아가기' : '워크스페이스로 돌아가기'}
                aria-label={lastThreadId ? '마지막 채널로 돌아가기' : '워크스페이스로 돌아가기'}
                onClick={() => {
                  if (lastThreadId) void router.navigate({ to: '/th/$threadId', params: { threadId: lastThreadId } });
                  else void router.navigate({ to: '/' });
                }}
              />
            )}
            <Icon name="files" size="sm" decorative />
            자료실
          </div>
          <div className={s.headSub}>대화에서 쌓인 근거와 업로드한 문서를 프로젝트 단위로 모아 봅니다.</div>
        </div>

        <div className={s.filters}>
          <Input
            className={s.search}
            placeholder="자료 검색 (문서 원문·근거 발췌까지)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {projects.length > 0 ? (
            <Select
              size="sm"
              className={s.filterSel}
              value={projectFilter}
              onValueChange={setProjectFilter}
              ariaLabel="프로젝트 필터"
              options={[{ value: '', label: '전체 프로젝트' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          ) : null}
          <Select
            size="sm"
            className={s.filterSel}
            value={typeFilter}
            onValueChange={setTypeFilter}
            ariaLabel="종류 필터"
            options={TYPE_OPTIONS}
          />
        </div>

        {showLoading ? (
          <div className={s.loadingRow}>
            <Spinner label="자료 불러오는 중" /> 불러오는 중…
          </div>
        ) : null}
        {!isLoading && sources.length === 0 ? (
          <EmptyState icon="files" title="자료가 없어요" description="대화에서 근거가 쌓이거나 문서를 업로드하면 여기에 모입니다." />
        ) : null}

        <div className={s.list}>
          {sources.map((item) => (
            <button
              key={`${item.kind}-${item.id}`}
              type="button"
              className={`${s.item} ${viewer?.id === item.id ? s.itemOn : ''}`}
              onClick={() => openItem(item)}
            >
              <span className={s.itemIcon}>
                <Icon name={KIND_ICON[item.kind] ?? 'info'} size="sm" decorative />
              </span>
              <span className={s.itemBody}>
                <span className={s.itemTitle}>{item.title}</span>
                {item.snippet ? <span className={s.itemSnippet}>{item.snippet}</span> : null}
                <span className={s.itemMeta}>
                  <span className={s.itemType}>{TYPE_LABEL[item.sourceType] ?? item.sourceType}</span>
                  {item.channelName ? <span className={s.itemChannel}>{item.channelName}</span> : null}
                  <span className={s.itemDate} title={formatFullDateTime(item.createdAt)}>{formatDateLabel(item.createdAt)}</span>
                  {item.status === 'processing' ? <span className={s.itemProcessing}>분석 중</span> : null}
                  {item.status === 'failed' ? <span className={s.itemFail}>추출 실패</span> : null}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {viewer ? <FileViewer target={viewer} onClose={() => setViewer(null)} /> : null}
    </div>
  );
}
