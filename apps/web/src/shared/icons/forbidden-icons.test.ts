import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const srcRoot = join(process.cwd(), 'src');

const allowedFiles = new Set<string>([
  'shared/icons/forbidden-icons.test.ts',
]);

const knownTextIcons = /[📎📄🧠🌐📁🛠📌🌍👋🌙☀🖥✅❌⚠⭐🚀✨💡🎯]/u;
const emojiPresentation = /\p{Emoji_Presentation}/u;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === 'routeTree.gen.ts') return [];
      return walk(path);
    }
    if (!/\.(tsx|ts)$/.test(entry)) return [];
    return [path];
  });
}

describe('text and emoji icon policy', () => {
  it('keeps UI source free of text/emoji icons', () => {
    const offenders = walk(srcRoot)
      .map((path) => {
        const rel = relative(srcRoot, path);
        if (allowedFiles.has(rel)) return undefined;
        const lines = readFileSync(path, 'utf8').split('\n');
        const matches = lines
          .map((line, index) => ({ line, number: index + 1 }))
          .filter(({ line }) => knownTextIcons.test(line) || emojiPresentation.test(line))
          .map(({ line, number }) => `${rel}:${number}: ${line.trim()}`);
        return matches.length > 0 ? matches : undefined;
      })
      .filter(Boolean)
      .flat();

    expect(offenders).toEqual([]);
  });
});
