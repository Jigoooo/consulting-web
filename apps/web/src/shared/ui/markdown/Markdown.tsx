import { memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { parseChoiceBlock } from './parseChoices';
import { mdSanitizeSchema } from './sanitizeSchema';
import { CodeBlock } from './CodeBlock';
import s from './Markdown.module.css';

function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      // HTML rendering with a strict sanitize boundary (축 A). rehype-raw parses
      // embedded HTML; rehype-sanitize immediately strips anything dangerous.
      // rehype-katex renders $…$/$$…$$ math (remark-math parses it). Order:
      // raw → sanitize → katex (katex output is trusted math markup).
      rehypePlugins={[rehypeRaw, [rehypeSanitize, mdSanitizeSchema], rehypeKatex]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
        // 넓은 표는 가로 스크롤 래퍼로 감싸 레이아웃이 터지지 않게(ChatGPT식).
        table: ({ children }) => (
          <div className={s.tableWrap}>
            <table>{children}</table>
          </div>
        ),
        // 코드블록(축1-B): 헤더바 + Shiki 하이라이트 + 복사/다운로드.
        // react-markdown은 fenced code를 <pre><code>로 낸다 → pre를 CodeBlock으로.
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
          return <CodeBlock className={codeClass} children={codeChildren} />;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/**
 * Markdown renderer for assistant messages (N-2). GFM (tables, strikethrough,
 * task lists) enabled; raw HTML stays DISABLED (react-markdown default) so
 * streamed model output can never inject markup. Memoized — during streaming
 * the same prefix re-renders every delta, so parsing cost matters.
 *
 * G11-a: when `onChoice` is provided and the body contains a terminated
 * `::choices … ::` fence, the options render as clickable chips; clicking one
 * sends that label as the next user message (as if typed).
 */
export const Markdown = memo(function Markdown({
  text,
  onChoice,
}: {
  text: string;
  onChoice?: (choice: string) => void;
}) {
  const block = onChoice ? parseChoiceBlock(text) : null;

  if (block) {
    return (
      <div className={s.md}>
        {block.before.trim() ? <MarkdownBody text={block.before} /> : null}
        <div className={s.choices} role="group" aria-label="선택지">
          {block.choices.map((choice, i) => (
            <button
              key={`${i}-${choice}`}
              type="button"
              className={`${s.choiceChip} cwTap`}
              onClick={() => onChoice?.(choice)}
            >
              {choice}
            </button>
          ))}
        </div>
        {block.after.trim() ? <MarkdownBody text={block.after} /> : null}
      </div>
    );
  }

  return (
    <div className={s.md}>
      <MarkdownBody text={text} />
    </div>
  );
});
