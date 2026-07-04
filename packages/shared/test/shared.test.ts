import { describe, it, expect } from 'vitest';
import {
  ok,
  err,
  isOk,
  isErr,
  domainError,
  parentScopeType,
  scopeDepth,
  SCOPE_TYPES,
  RISK_LEVELS,
} from '../src/index.js';

describe('Result', () => {
  it('ok carries value', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  it('err carries error', () => {
    const r = err(domainError('NOT_FOUND', 'missing'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('NOT_FOUND');
  });
});

describe('scope vocabulary (ADR-0002)', () => {
  it('has exactly the locked 5 levels in order', () => {
    expect([...SCOPE_TYPES]).toEqual([
      'workspace',
      'project',
      'channel',
      'topic',
      'thread',
    ]);
  });

  it('parentScopeType walks up the tree', () => {
    expect(parentScopeType('thread')).toBe('topic');
    expect(parentScopeType('channel')).toBe('project');
    expect(parentScopeType('workspace')).toBeNull();
  });

  it('scopeDepth increases down the tree', () => {
    expect(scopeDepth('workspace')).toBe(0);
    expect(scopeDepth('thread')).toBe(4);
  });
});

describe('risk levels (ADR-0004)', () => {
  it('locks the 4-tier ladder', () => {
    expect([...RISK_LEVELS]).toEqual(['low', 'medium', 'high', 'critical']);
  });
});
