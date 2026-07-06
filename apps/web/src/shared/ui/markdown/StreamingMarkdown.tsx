import { memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
import s from './Markdown.module.css';

/**
 * Split markdown into top-level blocks on blank lines, but keep fenced code
 * blocks (``` … ```) intact even when they contain blank lines. 0-dependency
 * (no `marked`) — good enough for block-level memoization during streaming.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^(\s*)(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[2]!;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0]!; // ` or ~
      } else if (marker[0] === fenceMarker) {
        inFence = false;
      }
      current.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/** One markdown block. Memoized on its exact text so unchanged earlier blocks
 *  are never re-parsed while a later block streams in. */
const Block = memo(function Block({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className={s.tableWrap}>
            <table>{children}</table>
          </div>
        ),
        // 스트리밍 중 코드블록 — 헤더바/복사 UI는 나오되 Shiki 하이라이트는
        // streaming 플래그로 스킵(성능). 완료 후 <Markdown>이 하이라이트를 입힌다.
        pre: ({ children }) => {
          const arr: unknown[] = Array.isArray(children) ? (children as unknown[]) : [children];
          const child: unknown = arr[0];
          let codeClass: string | undefined;
          let codeChildren: ReactNode;
          if (child && typeof child === 'object' && 'props' in child) {
            const props = (child as { props: { className?: unknown; children?: unknown } }).props;
            codeClass = typeof props.className === 'string' ? props.className : undefined;
            codeChildren = props.children as ReactNode;
          }
          return <CodeBlock className={codeClass} children={codeChildren} streaming />;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

/**
 * Streaming-optimized markdown (D2). During a stream the document grows every
 * frame; parsing the WHOLE text each time is O(total). Splitting into blocks and
 * memoizing each means only the LAST (growing) block re-parses — the earlier
 * blocks are memo hits. Final output is identical to <Markdown>. Use this ONLY
 * for the live streaming row; persisted messages use <Markdown> (parsed once).
 */
export function StreamingMarkdown({ text }: { text: string }) {
  const blocks = splitMarkdownBlocks(text);
  return (
    <div className={s.md}>
      {blocks.map((block, i) => (
        <Block key={i} text={block} />
      ))}
    </div>
  );
}
