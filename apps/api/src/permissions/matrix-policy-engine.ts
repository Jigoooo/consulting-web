import { Injectable } from '@nestjs/common';
import type {
  EvaluateInput,
  EvaluateResult,
  ScopeChainNode,
} from './permission.types.js';
import { roleGrants } from './role-matrix.js';

export const POLICY_ENGINE = Symbol('POLICY_ENGINE');

export interface PolicyEnginePort {
  evaluate(input: EvaluateInput): EvaluateResult;
}

/**
 * Matrix + inheritance policy engine (ADR-0010).
 * Rules, in order:
 *  1. platform_owner/platform_admin → allow (system_role).
 *  2. any deny override on the scope chain → deny (deny wins).
 *  3. any allow override on the scope chain → allow.
 *  4. any role membership on the chain that grants the permission → allow (inherited).
 *  5. otherwise → deny.
 * The scope chain is ordered root→target; a grant at an ancestor inherits down.
 */
@Injectable()
export class MatrixPolicyEngine implements PolicyEnginePort {
  evaluate(input: EvaluateInput): EvaluateResult {
    const { permission, scopeChain, memberships, overrides, systemRole } = input;

    if (systemRole === 'platform_owner' || systemRole === 'platform_admin') {
      return { allowed: true, reason: `system role ${systemRole}`, source: 'system_role' };
    }

    const chainIds = new Set(scopeChain.map((n) => `${n.scopeType}:${n.scopeId}`));
    const onChain = (scopeType: string, scopeId: string): boolean =>
      chainIds.has(`${scopeType}:${scopeId}`);

    // 2. deny override wins
    const deny = overrides.find(
      (o) =>
        o.permission === permission &&
        !o.allow &&
        onChain(o.scopeType, o.scopeId),
    );
    if (deny) {
      return {
        allowed: false,
        reason: `explicit deny at ${deny.scopeType}`,
        source: 'override_deny',
        inheritedFrom: { scopeType: deny.scopeType, scopeId: deny.scopeId },
      };
    }

    // 3. allow override
    const allow = overrides.find(
      (o) => o.permission === permission && o.allow && onChain(o.scopeType, o.scopeId),
    );
    if (allow) {
      return {
        allowed: true,
        reason: `explicit allow at ${allow.scopeType}`,
        source: 'override_allow',
        inheritedFrom: { scopeType: allow.scopeType, scopeId: allow.scopeId },
      };
    }

    // 4. role grant on the chain (nearest ancestor first for a nicer explanation)
    const ordered: ScopeChainNode[] = [...scopeChain].reverse();
    for (const node of ordered) {
      const m = memberships.find(
        (mem) => mem.scopeType === node.scopeType && mem.scopeId === node.scopeId,
      );
      if (m && roleGrants(m.role, permission)) {
        return {
          allowed: true,
          reason: `role ${m.role} grants ${permission} at ${node.scopeType}`,
          source: 'role_grant',
          inheritedFrom: node,
        };
      }
    }

    return { allowed: false, reason: `no grant for ${permission}`, source: 'no_grant' };
  }
}
