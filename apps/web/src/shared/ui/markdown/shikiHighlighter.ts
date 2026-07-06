import type { Highlighter } from 'shiki';

/**
 * Shiki highlighter 싱글톤 로더(축1-B). 무거운 엔진이므로 lazy dynamic import +
 * 필요한 언어만 점진 로드. 초기 번들에 포함되지 않도록 이 모듈 전체가 lazy chunk.
 */
let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

// 컨설팅/개발 답변에서 실제로 나올 법한 언어만. 나머지는 plaintext 폴백.
const PRELOAD_LANGS = ['typescript', 'javascript', 'tsx', 'jsx', 'json', 'bash', 'shell', 'python', 'sql', 'yaml', 'markdown', 'html', 'css', 'diff'];

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
};

export function normalizeLang(raw: string | undefined): string {
  if (!raw) return 'text';
  const lower = raw.toLowerCase().trim();
  return LANG_ALIASES[lower] ?? lower;
}

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['github-light', 'github-dark'],
        langs: PRELOAD_LANGS,
      }),
    );
    PRELOAD_LANGS.forEach((l) => loadedLangs.add(l));
  }
  return highlighterPromise;
}

/**
 * 코드 → 하이라이트된 HTML(라이트/다크 dual). 미지원 언어는 안전하게 plaintext로.
 * 반환 HTML은 Shiki가 생성한 <pre class="shiki">…</pre>.
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter();
  const normalized = normalizeLang(lang);
  let useLang = 'text';
  if (loadedLangs.has(normalized)) {
    useLang = normalized;
  } else {
    // 요청 언어를 아직 안 실었으면 동적 로드 시도(실패 시 plaintext).
    try {
      const bundled = await import('shiki');
      const available = bundled.bundledLanguages as Record<string, unknown>;
      if (normalized in available) {
        await hl.loadLanguage(normalized as never);
        loadedLangs.add(normalized);
        useLang = normalized;
      }
    } catch {
      useLang = 'text';
    }
  }
  return hl.codeToHtml(code, {
    lang: useLang,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
}
