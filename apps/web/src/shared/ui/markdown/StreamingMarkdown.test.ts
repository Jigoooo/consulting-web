import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from './StreamingMarkdown';

describe('splitMarkdownBlocks', () => {
  it('splits on blank lines', () => {
    expect(splitMarkdownBlocks('para one\n\npara two')).toEqual(['para one', 'para two']);
  });

  it('keeps fenced code blocks intact (blank lines inside preserved)', () => {
    const md = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toBe('```ts\nconst a = 1;\n\nconst b = 2;\n```');
    expect(blocks[2]).toBe('after');
  });

  it('handles an unterminated (mid-stream) fence as one trailing block', () => {
    const md = 'text\n\n```py\nprint(1)';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toBe('```py\nprint(1)');
  });

  it('does not split ~~~ tilde fences', () => {
    const md = '~~~\na\n\nb\n~~~';
    expect(splitMarkdownBlocks(md)).toEqual(['~~~\na\n\nb\n~~~']);
  });

  it('returns empty array for empty input', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
  });
});
