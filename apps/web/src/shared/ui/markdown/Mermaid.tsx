import { useEffect, useId, useRef, useState } from 'react';
import type mermaid from 'mermaid';
import s from './CodeBlock.module.css';

let mermaidPromise: Promise<typeof mermaid> | null = null;

async function getMermaid(): Promise<typeof mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
      return m.default;
    });
  }
  return mermaidPromise;
}

/**
 * Mermaid 다이어그램 렌더(축1-B). lazy import + securityLevel:strict(스크립트/HTML
 * 라벨 차단). 파싱 실패 시 원본 코드 폴백. 컨설팅 플로우/조직도용.
 */
export function Mermaid({ code }: { code: string }) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setFailed(false);
    setSvg(null);
    void (async () => {
      try {
        const mermaid = await getMermaid();
        const { svg: out } = await mermaid.render(`mmd-${rawId}`, code);
        if (alive.current) setSvg(out);
      } catch {
        if (alive.current) setFailed(true);
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [code, rawId]);

  if (failed) {
    return (
      <pre className={s.plain}>
        <code>{code}</code>
      </pre>
    );
  }
  if (!svg) {
    return <div className={s.mermaidLoading}>다이어그램 렌더링 중…</div>;
  }
  return <div className={s.mermaid} dangerouslySetInnerHTML={{ __html: svg }} />;
}
