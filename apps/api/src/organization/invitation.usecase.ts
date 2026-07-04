import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import { ok, err, type Result, domainError, type ScopeType } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { generateToken, hashToken } from '../auth/password.js';

type SpaceRole = 'owner' | 'admin' | 'editor' | 'commenter' | 'viewer';

export interface CreateInvitationCommand {
  workspaceId: string;
  invitedByUserId: string;
  email: string;
  scopeType: ScopeType;
  scopeId: string;
  role: SpaceRole;
  ttlMs?: number;
}

export interface AcceptInvitationCommand {
  token: string;
  userId: string;
}

@Injectable()
export class InvitationUseCase {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Create an invitation. Returns the raw token ONCE; DB stores only the hash. */
  async create(
    cmd: CreateInvitationCommand,
  ): Promise<Result<{ invitationId: string; token: string }>> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + (cmd.ttlMs ?? 7 * 24 * 3600 * 1000));

    const [row] = await this.db
      .insert(schema.invitations)
      .values({
        workspaceId: cmd.workspaceId,
        email: cmd.email.trim().toLowerCase(),
        invitedByUserId: cmd.invitedByUserId,
        scopeType: cmd.scopeType,
        scopeId: cmd.scopeId,
        role: cmd.role,
        tokenHash,
        expiresAt,
      })
      .returning({ id: schema.invitations.id });
    if (!row) return err(domainError('INTERNAL', 'invitation insert failed'));

    return ok({ invitationId: row.id, token });
  }

  /** Accept an invitation: create membership. Rejects reuse/expired (ADR-0009). */
  async accept(cmd: AcceptInvitationCommand): Promise<Result<{ membershipId: string }>> {
    const tokenHash = hashToken(cmd.token);

    return this.db.transaction(async (tx) => {
      const [inv] = await tx
        .select()
        .from(schema.invitations)
        .where(and(eq(schema.invitations.tokenHash, tokenHash), isNull(schema.invitations.acceptedAt)))
        .limit(1);

      if (!inv) return err(domainError('NOT_FOUND', 'invitation not found or already used'));
      if (inv.expiresAt.getTime() < Date.now()) {
        return err(domainError('PRECONDITION', 'invitation expired'));
      }

      const [membership] = await tx
        .insert(schema.memberships)
        .values({
          workspaceId: inv.workspaceId,
          userId: cmd.userId,
          scopeType: inv.scopeType,
          scopeId: inv.scopeId,
          role: inv.role,
        })
        .onConflictDoNothing()
        .returning({ id: schema.memberships.id });

      await tx
        .update(schema.invitations)
        .set({ acceptedByUserId: cmd.userId, acceptedAt: new Date() })
        .where(eq(schema.invitations.id, inv.id));

      await tx.insert(schema.auditEvents).values({
        workspaceId: inv.workspaceId,
        actorUserId: cmd.userId,
        action: 'invitation.accept',
        scopeType: inv.scopeType,
        scopeId: inv.scopeId,
        after: { invitationId: inv.id, role: inv.role },
      });

      if (!membership) {
        // membership already existed — still consumed the invite
        const [existing] = await tx
          .select({ id: schema.memberships.id })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.userId, cmd.userId),
              eq(schema.memberships.scopeType, inv.scopeType),
              eq(schema.memberships.scopeId, inv.scopeId),
            ),
          )
          .limit(1);
        return ok({ membershipId: existing?.id ?? 'existing' });
      }

      return ok({ membershipId: membership.id });
    });
  }
}
