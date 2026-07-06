import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../icons/Icon';
import { highlightCode, normalizeLang } from './shikiHighlighter';
import { Mermaid } from './Mermaid';
import s from './CodeBlock.module.css';

/** children(ReactNode)에서 순수 텍스트만 추출 — 복사/다운로드/하이라이트 소스. */
function extractText(node: ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in (node as { props?: { children?: ReactNode } })) {
    return extractText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

const EXT: Record<string, string> = {
  typescript: 'ts', javascript: 'js', tsx: 'tsx', jsx: 'jsx', python: 'py',
  bash: 'sh', json: 'json', sql: 'sql', yaml: 'yaml', markdown: 'md', html: 'html', css: 'css',
};

/**
 * 코드블록 (축1-B, Streamdown 급). 헤더바(언어 라벨 + 복사·다운로드) +
 * Shiki 구문 하이라이트(lazy). 하이라이트 로드 전/실패 시 plain <pre> 폴백이라
 * 스트리밍/미지원 언어에서도 안전.
 */
export function CodeBlock({ className, children, streaming }: { className?: string | undefined; children?: ReactNode; streaming?: boolean }) {
  // react-markdown은 ``` 코드에 `language-xxx` className을 붙인다.
  const langMatch = /language-([\w+-]+)/.exec(className ?? '');
  const rawLang = langMatch?.[1];
  const lang = normalizeLang(rawLang);
  const code = extractText(children).replace(/\n$/, '');
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    // 스트리밍 중에는 하이라이트를 돌리지 않는다 — 매 델타마다 미완 코드에 Shiki를
    // 재실행하면 성능이 나빠지고 결과도 불안정. 완료 후 <Markdown>이 재렌더하며
    // 하이라이트가 입혀진다(성능 저하 없이 최종 품질 확보).
    if (streaming || lang === 'mermaid') return;
    alive.current = true;
    let cancelled = false;
    void highlightCode(code, lang)
      .then((out) => {
        if (!cancelled && alive.current) setHtml(out);
      })
      .catch(() => {
        /* plain 폴백 유지 */
      });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [code, lang]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 클립보드 차단 환경 — 무시 */
    }
  }

  function download() {
    const ext = EXT[lang] ?? 'txt';
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `snippet.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (lang === 'mermaid' && !streaming) {
    return <Mermaid code={code} />;
  }

  return (
    <div className={s.wrap}>
      <div className={s.head}>
        <span className={s.lang}>{rawLang && lang !== 'text' ? lang : '텍스트'}</span>
        <div className={s.actions}>
          <button type="button" className={s.btn} onClick={() => void copy()} aria-label="코드 복사" title="복사">
            <Icon name={copied ? 'check' : 'copy'} size="xs" decorative />
            {copied ? '복사됨' : '복사'}
          </button>
          <button type="button" className={s.btn} onClick={download} aria-label="코드 다운로드" title="다운로드">
            <Icon name="download" size="xs" decorative />
            저장
          </button>
        </div>
      </div>
      {html ? (
        <div className={s.shiki} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className={s.plain}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
