import { useState, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { Icon } from '../../../shared/icons/Icon';
import s from './FileViewer.module.css';

// pdf.js worker — vite가 번들하도록 URL import(외부 CDN 의존 제거, 오프라인 안전).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

/**
 * PDF 뷰어(축3, pdf.js/react-pdf). 커스텀 툴바(페이지 이동·줌). worker는 vite
 * 번들. 이 파일은 lazy chunk(FileViewer가 dynamic import)라 초기 로드 무영향.
 */
export default function PdfView({ url }: { url: string }) {
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.1);
  const [failed, setFailed] = useState(false);

  const onLoad = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setPage((p) => Math.min(p, n));
  }, []);

  if (failed) {
    return <div className={s.viewerError}>PDF를 표시할 수 없어요. 아래 다운로드로 확인해주세요.</div>;
  }

  return (
    <div className={s.pdfWrap}>
      <div className={s.pdfToolbar}>
        <div className={s.pdfNav}>
          <button
            type="button"
            className={s.pdfBtn}
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label="이전 페이지"
          >
            <Icon name="chevron-left" size="xs" decorative />
          </button>
          <span className={s.pdfPageLabel}>
            {page} / {numPages || '–'}
          </span>
          <button
            type="button"
            className={s.pdfBtn}
            disabled={page >= numPages}
            onClick={() => setPage((p) => Math.min(numPages, p + 1))}
            aria-label="다음 페이지"
          >
            <Icon name="chevron-right" size="xs" decorative />
          </button>
        </div>
        <div className={s.pdfZoom}>
          <button type="button" className={s.pdfBtn} onClick={() => setScale((z) => Math.max(0.5, z - 0.15))} aria-label="축소">
            −
          </button>
          <span className={s.pdfZoomLabel}>{Math.round(scale * 100)}%</span>
          <button type="button" className={s.pdfBtn} onClick={() => setScale((z) => Math.min(2.5, z + 0.15))} aria-label="확대">
            +
          </button>
        </div>
      </div>
      <div className={s.pdfScroll}>
        <Document
          file={url}
          onLoadSuccess={onLoad}
          onLoadError={() => setFailed(true)}
          loading={<div className={s.viewerLoading}>PDF 불러오는 중…</div>}
          error={<div className={s.viewerError}>PDF를 표시할 수 없어요.</div>}
        >
          <Page
            pageNumber={page}
            scale={scale}
            renderTextLayer
            renderAnnotationLayer={false}
            loading={<div className={s.viewerLoading}>페이지 렌더링 중…</div>}
          />
        </Document>
      </div>
    </div>
  );
}
