import { describe, it, expect } from 'vitest';
import { MatrixPolicyEngine } from '../src/permissions/matrix-policy-engine.js';
import type {
  EvaluateInput,
  MembershipRecord,
  OverrideRecord,
  ScopeChainNode,
} from '../src/permissions/permission.types.js';

const engine = new MatrixPolicyEngine();

const WS = { scopeType: 'workspace' as const, scopeId: 'ws1' };
const PROJ = { scopeType: 'project' as const, scopeId: 'p1' };
const CHAN = { scopeType: 'channel' as const, scopeId: 'c1' };
const chain: ScopeChainNode[] = [WS, PROJ, CHAN];

function evalWith(
  permission: EvaluateInput['permission'],
  memberships: MembershipRecord[],
  overrides: OverrideRecord[] = [],
  systemRole: EvaluateInput['systemRole'] = 'user',
) {
  return engine.evaluate({ permission, scopeChain: chain, memberships, overrides, systemRole });
}

describe('MatrixPolicyEngine (ADR-0010)', () => {
  it('owner at workspace can manage workspace', () => {
    const r = evalWith('workspace.manage', [{ ...WS, role: 'owner' }]);
    expect(r.allowed).toBe(true);
    expect(r.source).toBe('role_grant');
  });

  it('viewer cannot send messages', () => {
    const r = evalWith('message.send', [{ ...WS, role: 'viewer' }]);
    expect(r.allowed).toBe(false);
    expect(r.source).toBe('no_grant');
  });

  it('project editor inherits down to channel (channel.create)', () => {
    const r = evalWith('channel.create', [{ ...PROJ, role: 'editor' }]);
    expect(r.allowed).toBe(true);
    expect(r.inheritedFrom?.scopeType).toBe('project');
  });

  it('deny override beats inherited allow (deny wins)', () => {
    const r = evalWith(
      'channel.create',
      [{ ...PROJ, role: 'editor' }],
      [{ ...CHAN, permission: 'channel.create', allow: false }],
    );
    expect(r.allowed).toBe(false);
    expect(r.source).toBe('override_deny');
  });

  it('allow override grants a permission the role lacks', () => {
    const r = evalWith(
      'artifact.create',
      [{ ...CHAN, role: 'viewer' }],
      [{ ...CHAN, permission: 'artifact.create', allow: true }],
    );
    expect(r.allowed).toBe(true);
    expect(r.source).toBe('override_allow');
  });

  it('deny override wins even when an allow override also exists', () => {
    const r = evalWith(
      'message.send',
      [{ ...WS, role: 'admin' }],
      [
        { ...WS, permission: 'message.send', allow: true },
        { ...CHAN, permission: 'message.send', allow: false },
      ],
    );
    expect(r.allowed).toBe(false);
    expect(r.source).toBe('override_deny');
  });

  it('platform_owner is allowed regardless of memberships', () => {
    const r = evalWith('workspace.manage', [], [], 'platform_owner');
    expect(r.allowed).toBe(true);
    expect(r.source).toBe('system_role');
  });

  it('override off the scope chain does not apply', () => {
    const r = evalWith(
      'channel.create',
      [{ ...PROJ, role: 'editor' }],
      [
        {
          scopeType: 'channel',
          scopeId: 'OTHER',
          permission: 'channel.create',
          allow: false,
        },
      ],
    );
    // deny is for a different channel → editor inheritance still grants
    expect(r.allowed).toBe(true);
    expect(r.source).toBe('role_grant');
  });

  it('every result carries a human reason (explain UI)', () => {
    const r = evalWith('message.send', [{ ...WS, role: 'viewer' }]);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});
