import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
