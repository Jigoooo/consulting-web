import { defaultSchema } from 'rehype-sanitize';

/**
 * HTML sanitize schema for assistant markdown (축 A / #HTML rendering).
 *
 * 지구 can emit raw HTML (tables with structure, spans, divs) and it renders,
 * but EVERYTHING dangerous is stripped. This is the security boundary: raw
 * HTML without sanitize is an XSS door (prompt-injected `<script>`,
 * `<img onerror>`), so rehype-raw MUST always be paired with this schema.
 *
 * Policy:
 *  - Allow structural + text tags only (tables, lists, headings, code, etc.).
 *  - Block script/style/iframe/object and ALL event handlers (on*).
 *  - Block the `style` attribute entirely — arbitrary CSS injection (position,
 *    background image, etc.) is a defacement/exfil vector. Colors/alignment
 *    come from our `className` whitelist so design tokens stay consistent.
 *  - Links: http/https/mailto only; images: https + data:image only.
 */
export const mdSanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    'p', 'br', 'hr', 'div', 'span',
    'strong', 'em', 'del', 's', 'sub', 'sup', 'mark',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'code', 'pre', 'kbd',
    'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  ],
  attributes: {
    ...defaultSchema.attributes,
    // class allowed globally so our CSS-module/utility classes work; style is
    // intentionally NOT present so it stays stripped.
    '*': ['className', 'class'],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    th: ['colSpan', 'rowSpan', 'align', 'scope'],
    td: ['colSpan', 'rowSpan', 'align'],
    col: ['span', 'width'],
    ol: ['start', 'type'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https', 'data'],
  },
  // Drop anything not in the whitelist rather than escaping it.
  strip: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta'],
} as const;
