/**
 * Korean-aware fuzzy search primitives — shared by the web command palette,
 * chat-transcript search (server), and any future search surface. Pure TS, no
 * dependencies, so both `apps/web` and `apps/api` import the identical logic.
 *
 * Supported query modes (all handled by `hangulMatch`):
 *  - whitespace-insensitive substring   ("창원 예산" → "창원예산서")
 *  - 초성 (leading-consonant) search     ("ㅊㅇㅅ"   → "창원시")
 *  - partial-jamo / composition search   ("차"       → "창원시")
 *  - plain latin substring               ("world"    → "Hello World")
 */

const HANGUL_BASE = 0xac00;
const HANGUL_END = 0xd7a3;
const JUNG_COUNT = 21;
const JONG_COUNT = 28;

// 초성 (leading consonants), index 0..18
const CHO = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];
// 중성 (vowels), index 0..20
const JUNG = [
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
  'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
];
// 종성 (final consonants), index 0..27 (0 = none)
const JONG = [
  '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ',
  'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];

const CHO_SET = new Set(CHO);

function isSyllable(code: number): boolean {
  return code >= HANGUL_BASE && code <= HANGUL_END;
}

/** Decompose each hangul syllable into its constituent jamo; pass others through. */
export function decomposeJamo(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (isSyllable(code)) {
      const s = code - HANGUL_BASE;
      const cho = Math.floor(s / (JUNG_COUNT * JONG_COUNT));
      const jung = Math.floor((s % (JUNG_COUNT * JONG_COUNT)) / JONG_COUNT);
      const jong = s % JONG_COUNT;
      out += CHO[cho]! + JUNG[jung]! + JONG[jong]!; // JONG[0] === '' → no-op
    } else {
      out += ch;
    }
  }
  return out;
}

/** Leading consonant of every syllable; non-syllables pass through. */
export function chosung(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (isSyllable(code)) {
      const s = code - HANGUL_BASE;
      out += CHO[Math.floor(s / (JUNG_COUNT * JONG_COUNT))]!;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Lowercase + remove all Unicode whitespace. */
export function normalizeSearch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

/** True when the query is entirely leading-consonant jamo (ㄱ..ㅎ). */
export function isChosungQuery(query: string): boolean {
  const q = query.replace(/\s+/g, '');
  if (!q) return false;
  for (const ch of q) {
    if (!CHO_SET.has(ch)) return false;
  }
  return true;
}

/** Ordered-subsequence test: does every char of `needle` appear in `hay` in order. */
function isSubsequence(hay: string, needle: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (const ch of needle) {
    i = hay.indexOf(ch, i);
    if (i < 0) return false;
    i += 1;
  }
  return true;
}

/**
 * Korean-aware match. Returns true if ANY strategy matches:
 *  (1) whitespace-insensitive substring, (2) 초성 subsequence when the query is
 *  all leading consonants, (3) decomposed-jamo subsequence (composition).
 */
export function hangulMatch(text: string, query: string): boolean {
  const q = query.trim();
  if (!q) return true;

  // (1) whitespace-insensitive substring — covers latin + spaced hangul
  if (normalizeSearch(text).includes(normalizeSearch(q))) return true;

  // (2) 초성 search
  if (isChosungQuery(q)) {
    const qCho = q.replace(/\s+/g, '');
    if (isSubsequence(chosung(text).toLowerCase(), qCho.toLowerCase())) return true;
  }

  // (3) partial-jamo / composition (ordered subsequence of decomposed jamo)
  const textJamo = decomposeJamo(normalizeSearch(text));
  const queryJamo = decomposeJamo(normalizeSearch(q));
  if (queryJamo && isSubsequence(textJamo, queryJamo)) return true;

  return false;
}

/**
 * Character ranges (in ORIGINAL text indices) to highlight for a whitespace-
 * insensitive substring hit. Returns [] for 초성/jamo-only matches — callers
 * should fall back to bubble-level highlighting in that case.
 */
export function highlightRanges(text: string, query: string): Array<[number, number]> {
  const q = query.trim();
  if (!q) return [];
  const normQuery = normalizeSearch(q);
  if (!normQuery) return [];

  // Map each non-whitespace char of `text` to its original index.
  const chars: string[] = [];
  const origIndex: number[] = [];
  let idx = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) {
      chars.push(ch.toLowerCase());
      origIndex.push(idx);
    }
    idx += ch.length;
  }
  const normText = chars.join('');
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const hit = normText.indexOf(normQuery, from);
    if (hit < 0) break;
    const startOrig = origIndex[hit]!;
    const lastCharOrig = origIndex[hit + normQuery.length - 1]!;
    // end = original index just past the last matched char (surrogate-aware)
    const endOrig = lastCharOrig + charWidthAt(text, lastCharOrig);
    ranges.push([startOrig, endOrig]);
    from = hit + normQuery.length;
  }
  return ranges;
}

/** Width (in UTF-16 code units) of the character starting at `index`. */
function charWidthAt(text: string, index: number): number {
  const cp = text.codePointAt(index);
  return cp !== undefined && cp > 0xffff ? 2 : 1;
}
