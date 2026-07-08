import { useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../icons/Icon';
import s from './Markdown.module.css';

/** 한 셀의 텍스트를 TSV 안전값으로 정규화 — 탭/개행은 엑셀 셀 경계를 깨므로 공백으로. */
function cellText(cell: Element): string {
  return (cell.textContent ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
}

/** HTML 클립보드에 넣기 전 값 이스케이프 — 셀 내용의 <, >, & 가 마크업을 깨지 않게. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 셀이 숫자(수량·금액 등)인지 판별. 통화기호/콤마/퍼센트/괄호/부호/단위(원·달러)를
 * 걷어낸 뒤 남은 게 순수 숫자면 숫자로 본다. "4,500원"→"4500"(숫자), "사과"→아님.
 */
function isNumericCell(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const stripped = t.replace(/[\s,.\-+()%₩$]|원|달러|USD|KRW|EUR|JPY|엔/g, '');
  return stripped.length > 0 && /^\d+$/.test(stripped);
}

/**
 * 표 DOM에서 서식이 유지되는 HTML 표를 재구성한다. react-markdown이 낸 순수
 * <th>/<td>에는 인라인 스타일이 없어 엑셀에 무서식으로 붙는다. 여기서 헤더 음영·굵기,
 * 셀 테두리, 컬럼별 정렬(숫자열 우측), nowrap 을 인라인 스타일로 주입 → 엑셀·구글시트가
 * text/html 클립보드를 읽을 때 서식을 그대로 인식한다.
 */
function buildStyledHtml(table: HTMLTableElement): string {
  const headRow = table.querySelector('thead tr');
  const headCells = headRow ? Array.from(headRow.children) : [];
  const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
  const colCount = headCells.length || bodyRows[0]?.children.length || 0;

  // 컬럼별 숫자 여부: 본문 셀의 60% 이상이 숫자면 그 컬럼은 우측정렬.
  const numericCol: boolean[] = [];
  for (let c = 0; c < colCount; c++) {
    let numeric = 0;
    let total = 0;
    for (const row of bodyRows) {
      const cell = row.children[c];
      if (!cell) continue;
      const text = cell.textContent ?? '';
      if (text.trim()) {
        total += 1;
        if (isNumericCell(text)) numeric += 1;
      }
    }
    numericCol[c] = total > 0 && numeric / total >= 0.6;
  }

  const border = '1px solid #d0d7de';
  const thStyle = (align: string) =>
    `border:${border};padding:6px 12px;background:#f3f4f6;font-weight:700;white-space:nowrap;text-align:${align};`;
  const tdStyle = (align: string) => `border:${border};padding:6px 12px;text-align:${align};`;

  let html = '<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">';
  if (headCells.length) {
    html += '<thead><tr>';
    headCells.forEach((cell, c) => {
      html += `<th style="${thStyle(numericCol[c] ? 'right' : 'left')}">${escapeHtml(cellText(cell))}</th>`;
    });
    html += '</tr></thead>';
  }
  html += '<tbody>';
  for (const row of bodyRows) {
    html += '<tr>';
    Array.from(row.children).forEach((cell, c) => {
      html += `<td style="${tdStyle(numericCol[c] ? 'right' : 'left')}">${escapeHtml(cellText(cell))}</td>`;
    });
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

/**
 * 표 렌더 래퍼 + 우상단 복사 버튼(ChatGPT식). 복사 시 클립보드에 두 포맷을 함께 쓴다:
 *  - text/html : 서식(헤더 음영·굵기, 테두리, 숫자열 우측정렬, nowrap)이 주입된 <table>
 *    → 엑셀·구글시트가 셀 구조 + 서식을 그대로 인식(우선).
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
    const html = buildStyledHtml(table);
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
        title={copied ? '복사됨 — 엑셀·시트에 붙여넣기(서식 유지)' : '표 복사 (엑셀·시트에 서식 그대로 붙여넣기)'}
      >
        <Icon name={copied ? 'check' : 'copy'} size="xs" decorative />
      </button>
      <div className={s.tableWrap}>
        <table ref={tableRef}>{children}</table>
      </div>
    </div>
  );
}
