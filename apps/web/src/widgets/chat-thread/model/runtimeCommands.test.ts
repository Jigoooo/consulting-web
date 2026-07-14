import { describe, expect, it } from 'vitest';
import type { ChatRuntimeModel } from '@consulting/contracts';
import { RUNTIME_COMMANDS, describeRuntimeCommand, parseRuntimeCommand, resolveModelCommand, resolveRuntimeModelLabel } from './runtimeCommands';

const models: ChatRuntimeModel[] = [
  {
    id: 'Hermes Agent',
    route: 'openai-codex/gpt-5.5',
    label: 'gpt-5.5 · openai-codex',
    provider: 'openai-codex',
    modelName: 'gpt-5.5',
    root: 'openai-codex/gpt-5.5',
  },
  {
    id: 'anthropic/claude-sonnet-4',
    route: 'anthropic/claude-sonnet-4',
    label: 'claude-sonnet-4 · anthropic',
    provider: 'anthropic',
    modelName: 'claude-sonnet-4',
  },
];

describe('runtimeCommands', () => {
  it('advertises only web-supported commands with parameter hints', () => {
    expect(RUNTIME_COMMANDS.map((c) => c.command)).toEqual(['/model', '/status', '/usage', '/stop', '/help', '/commands']);
    expect(RUNTIME_COMMANDS.find((c) => c.command === '/model')).toMatchObject({ args: '<모델 route>', example: '/model openai-codex/gpt-5.5' });
    expect(RUNTIME_COMMANDS.map((c) => c.command)).not.toContain('/config');
    expect(RUNTIME_COMMANDS.map((c) => c.command)).not.toContain('/tools');
    expect(RUNTIME_COMMANDS.map((c) => c.command)).not.toContain('/cron');
  });

  it('parses command and argument separately', () => {
    expect(parseRuntimeCommand('/model openai-codex/gpt-5.5')).toEqual({ command: '/model', arg: 'openai-codex/gpt-5.5' });
    expect(parseRuntimeCommand('  /usage  ')).toEqual({ command: '/usage', arg: '' });
    expect(parseRuntimeCommand('hello')).toBeNull();
  });

  it('resolves model command by route, modelName, or label without using the Hermes Agent brand', () => {
    expect(resolveModelCommand('/model openai-codex/gpt-5.5', models)).toEqual({ action: 'select', route: 'openai-codex/gpt-5.5' });
    expect(resolveModelCommand('/model gpt-5.5', models)).toEqual({ action: 'select', route: 'openai-codex/gpt-5.5' });
    expect(resolveModelCommand('/model claude', models)).toEqual({ action: 'select', route: 'anthropic/claude-sonnet-4' });
    expect(resolveModelCommand('/model Hermes Agent', models)).toEqual({ action: 'open-picker', query: 'Hermes Agent' });
  });

  it('renders command-specific help text', () => {
    expect(describeRuntimeCommand('/model')).toContain('/model <모델 route>');
    expect(describeRuntimeCommand('/model')).toContain('예: /model openai-codex/gpt-5.5');
    expect(describeRuntimeCommand('/unknown')).toContain('지원하지 않는 명령');
  });

  it('does not present empty optional model metadata as an endless loading state', () => {
    expect(resolveRuntimeModelLabel({ loaded: false, loading: true, activeRoute: '', models: [] })).toBe('모델 확인 중');
    expect(resolveRuntimeModelLabel({ loaded: true, loading: false, activeRoute: '', models: [] })).toBe('기본 모델');
    expect(resolveRuntimeModelLabel({ loaded: true, loading: false, activeRoute: models[0]!.route, models })).toBe(models[0]!.label);
  });
});
