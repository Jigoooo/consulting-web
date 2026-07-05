import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import s from './Markdown.module.css';

/**
 * Markdown renderer for assistant messages (N-2). GFM (tables, strikethrough,
 * task lists) enabled; raw HTML stays DISABLED (react-markdown default) so
 * streamed model output can never inject markup. Memoized — during streaming
 * the same prefix re-renders every delta, so parsing cost matters.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className={s.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
