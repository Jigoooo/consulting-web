import type { Permission, SpaceRole } from './permission.types.js';

/**
 * Role → permission grants (ADR-0010). Higher roles inherit lower-role grants.
 * This is the single source of the base matrix; overrides adjust per-user.
 */
const VIEWER: Permission[] = [
  'workspace.read',
  'project.read',
  'channel.read',
  'message.read',
  'artifact.render',
  'permission.read',
];

const COMMENTER: Permission[] = [...VIEWER, 'message.send', 'bot.invoke'];

const EDITOR: Permission[] = [
  ...COMMENTER,
  'project.create',
  'project.update',
  'channel.create',
  'channel.update',
  'topic.create',
  'artifact.create',
];

const ADMIN: Permission[] = [
  ...EDITOR,
  'workspace.invite',
  'topic.connect_memory',
  'permission.manage',
  'bot.install',
  'bot.configure',
];

const OWNER: Permission[] = [...ADMIN, 'workspace.manage'];

export const ROLE_MATRIX: Readonly<Record<SpaceRole, ReadonlySet<Permission>>> = {
  viewer: new Set(VIEWER),
  commenter: new Set(COMMENTER),
  editor: new Set(EDITOR),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

export function roleGrants(role: SpaceRole, permission: Permission): boolean {
  return ROLE_MATRIX[role].has(permission);
}
