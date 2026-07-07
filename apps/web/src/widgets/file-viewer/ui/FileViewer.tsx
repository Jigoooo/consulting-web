import { lazy, Suspense, useEffect } from 'react';
import { Markdown } from '../../../shared/ui/markdown/Markdown';
import { Icon } from '../../../shared/icons/Icon';
import { useAttachmentExtraction, saveAttachment } from '../../../lib/collab';
import { useAttachmentBlobUrl } from '../model/useAttachmentBlobUrl';
import { useToast } from '../../../shared/ui/toast/Toast';
import s from './FileViewer.module.css';

const PdfView = lazy(() => import('./PdfView'));

export interface FileViewerTarget {
  id: string;
  fileName: string;
  mimeType: string;
}

type Kind = 'pdf' | 'image' | 'markdown' | 'html' | 'text' | 'doc';

function classify(mime: string, name: string): Kind {
  const lower = name.toLowerCase();
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'text/markdown' || lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (mime === 'text/html' || lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (mime.startsWith('text/')) return 'text';
  // HWP/HWPX 및 기타 — 인라인 렌더 불가 → 추출 텍스트 표시.
  return 'doc';
}

/**
 * 파일 뷰어(축3). 우측 슬라이드 패널로 파일을 미리보기 + 다운로드.
 * mime별 라우팅: pdf=pdf.js, 이미지=img, md=Markdown, html=sanitize Markdown,
 * text/코드=pre, hwp/hwpx 등=추출 텍스트. 보안: HTML은 반드시 sanitize 경로.
 */
export function FileViewer({ target, onClose }: { target: FileViewerTarget; onClose: () => void }) {
  const kind = classify(target.mimeType, target.fileName);
  const needsBlob = kind === 'pdf' || kind === 'image';
  const needsText = kind === 'markdown' || kind === 'html' || kind === 'text' || kind === 'doc';
  const blob = useAttachmentBlobUrl(target.id, needsBlob);
  const extraction = useAttachmentExtraction(target.id, needsText);
  const toast = useToast();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <div className={s.overlay} role="presentation">
      <button type="button" className={s.scrim} aria-label="파일 미리보기 닫기" onClick={onClose} />
      <aside className={s.panel} role="dialog" aria-label={`${target.fileName} 미리보기`}>
        <header className={s.head}>
          <div className={s.headTitle} title={target.fileName}>
            <Icon name="files" size="sm" decorative />
            <span className={s.fileName}>{target.fileName}</span>
          </div>
          <div className={s.headActions}>
            <button
              type="button"
              className={s.headBtn}
              title="다운로드"
              onClick={() => void saveAttachment(target.id, target.fileName).catch(() => toast('error', '다운로드에 실패했어요.'))}
            >
              <Icon name="download" size="sm" decorative />
            </button>
            <button type="button" className={s.headBtn} title="닫기" aria-label="닫기" onClick={onClose}>
              <Icon name="x" size="sm" decorative />
            </button>
          </div>
        </header>

        <div className={s.body}>
          {kind === 'pdf' ? (
            blob.loading ? (
              <div className={s.viewerLoading}>불러오는 중…</div>
            ) : blob.error || !blob.url ? (
              <div className={s.viewerError}>파일을 불러오지 못했어요.</div>
            ) : (
              <Suspense fallback={<div className={s.viewerLoading}>뷰어 로딩 중…</div>}>
                <PdfView url={blob.url} />
              </Suspense>
            )
          ) : kind === 'image' ? (
            blob.loading ? (
              <div className={s.viewerLoading}>불러오는 중…</div>
            ) : blob.error || !blob.url ? (
              <div className={s.viewerError}>이미지를 불러오지 못했어요.</div>
            ) : (
              <div className={s.imageWrap}>
                <img src={blob.url} alt={target.fileName} className={s.image} />
              </div>
            )
          ) : extraction.isLoading ? (
            <div className={s.viewerLoading}>불러오는 중…</div>
          ) : extraction.isError ? (
            <div className={s.viewerError}>내용을 불러오지 못했어요.</div>
          ) : (
            <ExtractedContent
              kind={kind}
              fileName={target.fileName}
              content={extraction.data?.textContent ?? ''}
              status={extraction.data?.status ?? null}
              warnings={extraction.data?.warnings ?? []}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

function ExtractedContent({
  kind,
  fileName,
  content,
  status,
  warnings,
}: {
  kind: Kind;
  fileName: string;
  content: string;
  status: 'processing' | 'indexed' | 'skipped' | 'failed' | null;
  warnings: string[];
}) {
  if (status === 'processing') {
    return (
      <div className={s.viewerLoading}>
        문서를 분석하고 있어요…
        <br />
        레이아웃·표·텍스트를 추출하는 중입니다. 잠시만 기다려주세요.
      </div>
    );
  }
  if (status === 'failed' || (!content.trim() && status !== 'indexed')) {
    return (
      <div className={s.viewerError}>
        이 파일에서 텍스트를 추출하지 못했어요{warnings.length ? ` (${warnings.join(', ')})` : ''}.
        <br />
        상단 다운로드로 원본을 확인해주세요.
      </div>
    );
  }
  if (kind === 'markdown') {
    return (
      <div className={s.docBody}>
        <Markdown text={content} />
      </div>
    );
  }
  if (kind === 'html') {
    // 업로드 HTML은 Markdown의 sanitize(rehype-raw+sanitize) 경로로 안전 렌더.
    return (
      <div className={s.docBody}>
        <Markdown text={content} />
      </div>
    );
  }
  // text / doc(hwp/hwpx 추출본) — 코드 아닌 원문은 pre-wrap로 가독성 유지.
  return (
    <div className={s.textBody}>
      {kind === 'doc' ? <div className={s.docNote}>원본 문서에서 추출한 텍스트예요. 서식은 원본 다운로드로 확인하세요 — {fileName}</div> : null}
      <pre className={s.textPre}>{content}</pre>
    </div>
  );
}
