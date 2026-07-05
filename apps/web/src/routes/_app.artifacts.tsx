import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useSelectedWorkspace } from '../lib/wsStore';
import { useWorkspaceTree } from '../lib/spaces';
import { useArtifacts, useArtifactDetail, useCreateArtifact, useAddArtifactVersion, saveArtifactExport } from '../lib/collab';
import { Markdown } from '../components/chat/Markdown';
import { useToast } from '../components/ui/Toast';
import s from '../components/artifacts/Artifacts.module.css';

export const Route = createFileRoute('/_app/artifacts')({
  component: ArtifactsPage,
});

/** Phase 2-B A-3 — artifact library + version timeline + markdown viewer. */
function ArtifactsPage() {
  const workspaceId = useSelectedWorkspace();
  const { data: tree } = useWorkspaceTree(workspaceId ?? undefined);
  const { data, isLoading } = useArtifacts(workspaceId ?? undefined);
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

  const projects = tree?.projects ?? [];
  const artifacts = data?.artifacts ?? [];
  const versions = detail.data?.versions ?? [];
  const shown = viewVersion
    ? versions.find((v) => v.versionNo === viewVersion)
    : versions[versions.length - 1];

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
      toast('success', '산출물을 등록했어요.');
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
      toast('success', '새 버전을 추가했어요.');
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
    try {
      await saveArtifactExport(selected, detail.data.title, format, shown.versionNo);
      toast('success', `${format.toUpperCase()} 파일을 내려받았어요.`);
    } catch {
      toast('error', `${format.toUpperCase()} 내보내기에 실패했어요.`);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className={s.page}>
      <div className={s.list}>
        <div className={s.listHead}>
          <span>산출물</span>
          <button type="button" className={s.newBtn} onClick={() => setCreating(true)}>
            + 새 산출물
          </button>
        </div>
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
            }}
          >
            <span className={s.itemTitle}>{a.title}</span>
            <span className={s.itemMeta}>
              v{a.headVersion} · {new Date(a.updatedAt).toLocaleDateString('ko-KR')}
            </span>
          </button>
        ))}
      </div>

      <div className={s.viewer}>
        {creating ? (
          <div className={s.editor}>
            <div className={s.editorTitle}>새 산출물</div>
            <select className={s.input} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              className={s.input}
              placeholder="제목 (예: 공공시설 적정성 1차 보고)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className={`${s.input} ${s.textarea}`}
              placeholder="마크다운 본문…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className={s.primary} disabled={createArtifact.isPending} onClick={() => void submitCreate()}>
                등록
              </button>
              <button type="button" className={s.ghost} onClick={() => setCreating(false)}>
                취소
              </button>
            </div>
          </div>
        ) : !selected ? (
          <div className={s.placeholder}>
            <div style={{ fontSize: 34, marginBottom: 10 }}>📄</div>
            좌측에서 산출물을 선택하거나 새로 만들어보세요
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
                <button type="button" className={s.ghost} disabled={Boolean(exporting)} onClick={() => void download('pdf')}>
                  {exporting === 'pdf' ? 'PDF 생성 중…' : 'PDF'}
                </button>
                <button type="button" className={s.ghost} disabled={Boolean(exporting)} onClick={() => void download('docx')}>
                  {exporting === 'docx' ? 'DOCX 생성 중…' : 'DOCX'}
                </button>
                <button type="button" className={s.newBtn} onClick={() => setVersionOpen(true)}>
                  + 새 버전
                </button>
              </div>
            </div>
            <div className={s.timeline}>
              {versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={`${s.vChip} ${
                    (viewVersion ?? detail.data!.headVersion) === v.versionNo ? s.vChipOn : ''
                  }`}
                  title={v.note || `버전 ${v.versionNo}`}
                  onClick={() => setViewVersion(v.versionNo)}
                >
                  v{v.versionNo}
                </button>
              ))}
            </div>
            {versionOpen ? (
              <div className={s.editor}>
                <input
                  className={s.input}
                  placeholder="변경 메모 (예: 수치 보강)"
                  value={vNote}
                  onChange={(e) => setVNote(e.target.value)}
                />
                <textarea
                  className={`${s.input} ${s.textarea}`}
                  placeholder="새 버전 마크다운 본문…"
                  value={vContent}
                  onChange={(e) => setVContent(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className={s.primary} disabled={addVersion.isPending} onClick={() => void submitVersion()}>
                    버전 추가
                  </button>
                  <button
                    type="button"
                    className={s.ghost}
                    onClick={() => {
                      setVContent(shown?.content ?? '');
                      toast('info', '현재 버전 내용을 편집기에 불러왔어요.');
                    }}
                  >
                    현재 버전 불러오기
                  </button>
                  <button type="button" className={s.ghost} onClick={() => setVersionOpen(false)}>
                    닫기
                  </button>
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
