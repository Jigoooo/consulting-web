/**
 * G11-a — "weak" clarify UI via a markdown convention.
 *
 * Hermes's Runs API does not expose resumable clarify/approval interactions
 * (GitHub issue #2971), so we can't render a native blocking choice card. Instead
 * the agent may emit a fenced choice block in its answer body:
 *
 *   ::choices
 *   1. Option A
 *   2. Option B
 *   ::
 *
 * We parse that block out of the message text and render the options as clickable
 * chips; clicking one sends that option as the next user message (as if typed).
 * The marker is strict — an ordinary numbered list is NOT treated as choices, and
 * an unterminated fence (still streaming) yields null so nothing renders early.
 */
export interface ParsedChoiceBlock {
  /** text before the ::choices fence (rendered as normal markdown) */
  before: string;
  /** the extracted option labels */
  choices: string[];
  /** text after the closing :: fence (rendered as normal markdown) */
  after: string;
}

// Leading list marker: "1." / "2)" / "-" / "*" followed by the label.
const OPTION_RE = /^\s*(?:\d+[.)]|[-*])\s+(.*\S)\s*$/;

/**
 * Extract a single ::choices ... :: block. Returns null when there is no
 * terminated block or the block holds no valid options.
 */
export function parseChoiceBlock(text: string): ParsedChoiceBlock | null {
  const lines = text.split('\n');
  let openIdx = -1;
  let closeIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (openIdx === -1) {
      if (trimmed === '::choices') openIdx = i;
    } else if (trimmed === '::') {
      closeIdx = i;
      break;
    }
  }

  // No opening fence, or an unterminated fence (still streaming) → no chips yet.
  if (openIdx === -1 || closeIdx === -1) return null;

  const choices: string[] = [];
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const m = OPTION_RE.exec(line);
    if (m && m[1]) choices.push(m[1].trim());
  }

  if (choices.length === 0) return null;

  return {
    before: lines.slice(0, openIdx).join('\n'),
    choices,
    after: lines.slice(closeIdx + 1).join('\n'),
  };
}
