import type { ChatRuntimeModel } from '@consulting/contracts';

export interface RuntimeCommandItem {
  command: '/model' | '/status' | '/usage' | '/stop' | '/help' | '/commands';
  args: string;
  title: string;
  hint: string;
  example?: string;
}

export interface ParsedRuntimeCommand {
  command: RuntimeCommandItem['command'];
  arg: string;
}

export type ModelCommandResolution =
  | { action: 'select'; route: string }
  | { action: 'open-picker'; query: string };

export const RUNTIME_COMMANDS: RuntimeCommandItem[] = [
  { command: '/model', args: '<모델 route>', title: '모델 변경', hint: '예: /model openai-codex/gpt-5.5', example: '/model openai-codex/gpt-5.5' },
  { command: '/status', args: '', title: '실행 상태', hint: '현재 run의 모델·토큰·경과시간 확인' },
  { command: '/usage', args: '', title: '사용량', hint: '마지막 run의 토큰/컨텍스트 사용량 확인' },
  { command: '/stop', args: '', title: '중단', hint: '진행 중인 Hermes run을 안전하게 중단' },
  { command: '/help', args: '[명령어]', title: '도움말', hint: '예: /help /model' },
  { command: '/commands', args: '', title: '명령 목록', hint: '현재 웹에서 실행 가능한 명령만 표시' },
];

const COMMANDS = new Map(RUNTIME_COMMANDS.map((item) => [item.command, item]));
const AGENT_BRAND_RE = /^hermes(?:\s+agent)?$/i;

export function parseRuntimeCommand(raw: string): ParsedRuntimeCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  const command = head?.toLocaleLowerCase() as RuntimeCommandItem['command'] | undefined;
  if (!command || !COMMANDS.has(command)) return null;
  return { command, arg: rest.join(' ').trim() };
}

export function describeRuntimeCommand(commandName?: string): string {
  if (!commandName) {
    return RUNTIME_COMMANDS
      .map((item) => `${item.command}${item.args ? ` ${item.args}` : ''} — ${item.hint}`)
      .join('\n');
  }
  const normalized = commandName.trim().toLocaleLowerCase() as RuntimeCommandItem['command'];
  const item = COMMANDS.get(normalized);
  if (!item) return `지원하지 않는 명령입니다. /commands 로 가능한 명령을 확인하세요.`;
  const signature = `${item.command}${item.args ? ` ${item.args}` : ''}`;
  return [signature, item.hint, item.example ? `예: ${item.example}` : null].filter(Boolean).join('\n');
}

export function resolveModelCommand(raw: string, models: ChatRuntimeModel[]): ModelCommandResolution {
  const parsed = parseRuntimeCommand(raw);
  const query = parsed?.arg.trim() ?? '';
  if (!query) return { action: 'open-picker', query: '' };
  if (AGENT_BRAND_RE.test(query)) return { action: 'open-picker', query };
  const needle = query.toLocaleLowerCase();
  const match = models.find((model) => {
    const haystack = [model.route, model.modelName, model.provider, model.label, model.root]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLocaleLowerCase());
    return haystack.some((v) => v === needle) || haystack.some((v) => v.includes(needle));
  });
  return match ? { action: 'select', route: match.route } : { action: 'open-picker', query };
}
