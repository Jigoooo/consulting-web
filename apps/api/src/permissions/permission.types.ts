import type { ScopeType } from '@consulting/shared';

/**
 * Permission atoms (ADR-0010, design §8). Extend as features land.
 * Format: '<resource>.<action>'.
 */
export const PERMISSIONS = [
  'workspace.read',
  'workspace.manage',
  'workspace.invite',
  'project.create',
  'project.read',
  'project.update',
  'channel.create',
  'channel.read',
  'channel.update',
  'topic.create',
  'topic.connect_memory',
  'message.send',
  'message.read',
  'artifact.create',
  'artifact.render',
  'permission.read',
  'permission.manage',
  'bot.install',
  'bot.configure',
  'bot.invoke',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const SPACE_ROLES = ['owner', 'admin', 'editor', 'commenter', 'viewer'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

/** A membership as seen by the engine: user has `role` at (scopeType, scopeId). */
export interface MembershipRecord {
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly role: SpaceRole;
}

/** A direct override (ADR-0010): deny wins over allow. */
export interface OverrideRecord {
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly permission: Permission;
  readonly allow: boolean;
}

/** One node of the scope chain from workspace (root) down to the target. */
export interface ScopeChainNode {
  readonly scopeType: ScopeType;
  readonly scopeId: string;
}

export interface EvaluateInput {
  readonly permission: Permission;
  /** Ordered root→target. e.g. [workspace, project, channel]. */
  readonly scopeChain: readonly ScopeChainNode[];
  readonly memberships: readonly MembershipRecord[];
  readonly overrides: readonly OverrideRecord[];
  readonly systemRole?: 'platform_owner' | 'platform_admin' | 'user';
}

export interface EvaluateResult {
  readonly allowed: boolean;
  readonly reason: string;
  /** Where the deciding grant/deny came from, for the explain UI. */
  readonly source:
    | 'system_role'
    | 'override_deny'
    | 'override_allow'
    | 'role_grant'
    | 'no_grant';
  readonly inheritedFrom?: ScopeChainNode;
}
