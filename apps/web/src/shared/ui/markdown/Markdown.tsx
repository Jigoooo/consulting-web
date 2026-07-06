import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseChoiceBlock } from './parseChoices';
import s from './Markdown.module.css';

function MarkdownBody({ text }: { text: string }) {
  return (
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
