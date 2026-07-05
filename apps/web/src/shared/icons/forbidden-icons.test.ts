import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const cwd = process.cwd();

/** Roots to scan, each with a label used to prefix offender paths for readability. */
const scanRoots: { label: string; dir: string; extensions: RegExp }[] = [
  { label: 'src', dir: join(cwd, 'src'), extensions: /\.(tsx|ts)$/ },
  { label: 'public', dir: join(cwd, 'public'), extensions: /\.(svg|html)$/ },
];

/** Files exempt from the policy (the policy definition itself lives here). */
const allowedFiles = new Set<string>([
  'src/shared/icons/forbidden-icons.test.ts',
]);

const knownTextIcons = /[📎📄🧠🌐📁🛠📌🌍👋🌙☀🖥✅❌⚠⭐🚀✨💡🎯✓✔✗]/u;
const emojiPresentation = /\p{Emoji_Presentation}/u;

function walk(dir: string, extensions: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path, extensions);
    // Never scan generated router types or binary/font assets.
    if (entry === 'routeTree.gen.ts') return [];
    if (!extensions.test(entry)) return [];
    return [path];
  });
}

describe('text and emoji icon policy', () => {
  it('keeps UI source and static assets free of text/emoji icons', () => {
    const offenders = scanRoots.flatMap(({ label, dir, extensions }) =>
      walk(dir, extensions)
        .map((path) => {
          const rel = relative(cwd, path).replace(/\\/g, '/');
          if (allowedFiles.has(rel)) return undefined;
          const display = label === 'src' ? rel : `${label}/${relative(dir, path).replace(/\\/g, '/')}`;
          const lines = readFileSync(path, 'utf8').split('\n');
          const matches = lines
            .map((line, index) => ({ line, number: index + 1 }))
            .filter(({ line }) => knownTextIcons.test(line) || emojiPresentation.test(line))
            .map(({ line, number }) => `${display}:${number}: ${line.trim()}`);
          return matches.length > 0 ? matches : undefined;
        })
        .filter(Boolean)
        .flat(),
    );

    expect(offenders).toEqual([]);
  });
});
