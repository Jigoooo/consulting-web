import { useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../icons/Icon';
import s from './Markdown.module.css';

/** 한 셀의 텍스트를 TSV 안전값으로 정규화 — 탭/개행은 엑셀 셀 경계를 깨므로 공백으로. */
function cellText(cell: Element): string {
  return (cell.textContent ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
}

/**
 * 표 렌더 래퍼 + 우상단 복사 버튼(ChatGPT식). 복사 시 클립보드에 두 포맷을 함께 쓴다:
 *  - text/html : <table> 마크업 → 엑셀·구글시트가 서식/셀 구조를 그대로 인식(우선).
 *  - text/plain: TSV(탭 구분) → HTML 미지원 대상에서도 셀 단위로 붙여넣기.
 * ClipboardItem 미지원 환경은 writeText(TSV)로 폴백. 넓은 표가 가로 스크롤돼도
 * 버튼은 블록 우상단에 고정(스크롤 컨테이너 바깥 relative 래퍼).
 */
export function TableBlock({ children }: { children?: ReactNode }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);

  async function copyTable() {
    const table = tableRef.current;
    if (!table) return;
    const rows = Array.from(table.querySelectorAll('tr'));
    const tsv = rows
      .map((row) => Array.from(row.querySelectorAll('th,td')).map(cellText).join('\t'))
      .join('\n');
    const html = `<table>${table.innerHTML}</table>`;
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([tsv], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(tsv);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 클립보드 차단 환경 — 무시 */
    }
  }

  return (
    <div className={s.tableBlock}>
      <button
        type="button"
        className={s.tableCopyBtn}
        onClick={() => void copyTable()}
        aria-label="표 복사"
        title={copied ? '복사됨 — 엑셀·시트에 붙여넣기' : '표 복사 (엑셀·시트에 바로 붙여넣기)'}
      >
        <Icon name={copied ? 'check' : 'copy'} size="xs" decorative />
      </button>
      <div className={s.tableWrap}>
        <table ref={tableRef}>{children}</table>
      </div>
    </div>
  );
}
