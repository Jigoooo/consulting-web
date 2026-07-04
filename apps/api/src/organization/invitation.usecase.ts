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
  /** Optional display/notification hint only. Share-link access is NOT email-bound. */
  email?: string;
  scopeType: ScopeType;
  scopeId: string;
  role: SpaceRole;
  ttlMs?: number;
}

export interface AcceptInvitationCommand {
  token: string;
  userId: string;
}

export interface PreviewInvitationCommand {
  token: string;
}

export interface InvitationPreview {
  workspaceId: string;
  scopeType: ScopeType;
  scopeId: string;
  role: SpaceRole;
  expiresAt: Date;
  accepted: boolean;
  emailHint: string | null;
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

    if (!(await this.scopeBelongsToWorkspace(cmd.scopeType, cmd.scopeId, cmd.workspaceId))) {
      return err(domainError('PRECONDITION', 'invitation scope does not belong to workspace'));
    }
    if (!(await this.actorCanCreateInvitation(cmd.invitedByUserId, cmd.workspaceId))) {
      return err(domainError('FORBIDDEN', 'only owner/admin can create invitations'));
    }

    const [row] = await this.db
      .insert(schema.invitations)
      .values({
        workspaceId: cmd.workspaceId,
        email: cmd.email?.trim().toLowerCase() || null,
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

  /**
   * Non-consuming share-link preview for the invitation landing page.
   * UI uses this to branch: already signed in → accept; not signed in → sign up/login then accept.
   * Does not return raw token/hash and does not create membership.
   */
  async preview(cmd: PreviewInvitationCommand): Promise<Result<InvitationPreview>> {
    const tokenHash = hashToken(cmd.token);
    const [inv] = await this.db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.tokenHash, tokenHash))
      .limit(1);

    if (!inv) return err(domainError('NOT_FOUND', 'invitation not found'));
    if (inv.expiresAt.getTime() < Date.now()) {
      return err(domainError('PRECONDITION', 'invitation expired'));
    }

    return ok({
      workspaceId: inv.workspaceId,
      scopeType: inv.scopeType,
      scopeId: inv.scopeId,
      role: inv.role,
      expiresAt: inv.expiresAt,
      accepted: inv.acceptedAt !== null,
      emailHint: inv.email,
    });
  }

  /** Accept an invitation: create membership. Rejects reuse/expired (ADR-0009/0020). */
  async accept(cmd: AcceptInvitationCommand): Promise<Result<{ membershipId: string }>> {
    const tokenHash = hashToken(cmd.token);

    return this.db.transaction(async (tx) => {
      // Atomic single-use claim: only ONE concurrent accept wins the row
      // (UPDATE ... WHERE acceptedAt IS NULL RETURNING). Prevents the
      // SELECT-then-UPDATE TOCTOU double-accept window (ADR-0020).
      const [inv] = await tx
        .update(schema.invitations)
        .set({ acceptedByUserId: cmd.userId, acceptedAt: new Date() })
        .where(and(eq(schema.invitations.tokenHash, tokenHash), isNull(schema.invitations.acceptedAt)))
        .returning();

      if (!inv) return err(domainError('NOT_FOUND', 'invitation not found or already used'));
      if (inv.expiresAt.getTime() < Date.now()) {
        // expired: roll back the claim so the row is not falsely marked accepted
        throw new InvitationExpiredError();
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
    }).catch((e): Result<{ membershipId: string }> => {
      if (e instanceof InvitationExpiredError) {
        return err(domainError('PRECONDITION', 'invitation expired'));
      }
      throw e;
    });
  }

  /**
   * Phase 0 minimum invitation policy: only workspace owner/admin may mint
   * share-link invitations. Controllers may later add finer project/channel
   * delegation, but the use-case itself must not trust caller-side gating.
   */
  private async actorCanCreateInvitation(userId: string, workspaceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, userId),
          eq(schema.memberships.workspaceId, workspaceId),
          eq(schema.memberships.scopeType, 'workspace'),
          eq(schema.memberships.scopeId, workspaceId),
        ),
      )
      .limit(1);
    return row?.role === 'owner' || row?.role === 'admin';
  }

  /**
   * Polymorphic scope_id has no FK target, so workspace ownership is an
   * application invariant. Enforce it at invitation creation to prevent
   * cross-tenant membership rows such as workspace A + project B.
   */
  private async scopeBelongsToWorkspace(
    scopeType: ScopeType,
    scopeId: string,
    workspaceId: string,
  ): Promise<boolean> {
    if (scopeType === 'workspace') {
      const [row] = await this.db
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(and(eq(schema.workspaces.id, scopeId), eq(schema.workspaces.id, workspaceId)))
        .limit(1);
      return Boolean(row);
    }
    if (scopeType === 'project') {
      const [row] = await this.db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(and(eq(schema.projects.id, scopeId), eq(schema.projects.workspaceId, workspaceId)))
        .limit(1);
      return Boolean(row);
    }
    if (scopeType === 'channel') {
      const [row] = await this.db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(and(eq(schema.channels.id, scopeId), eq(schema.channels.workspaceId, workspaceId)))
        .limit(1);
      return Boolean(row);
    }
    if (scopeType === 'topic') {
      const [row] = await this.db
        .select({ id: schema.topics.id })
        .from(schema.topics)
        .where(and(eq(schema.topics.id, scopeId), eq(schema.topics.workspaceId, workspaceId)))
        .limit(1);
      return Boolean(row);
    }
    if (scopeType === 'thread') {
      const [row] = await this.db
        .select({ id: schema.threads.id })
        .from(schema.threads)
        .where(and(eq(schema.threads.id, scopeId), eq(schema.threads.workspaceId, workspaceId)))
        .limit(1);
      return Boolean(row);
    }
    return false;
  }
}

/** Internal sentinel used to force a transaction rollback on expiry. */
class InvitationExpiredError extends Error {}
