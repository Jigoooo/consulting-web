import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { ok, err, type Result, domainError } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export interface CreateWorkspaceCommand {
  actorUserId: string;
  name: string;
  slug: string;
  requestId?: string;
}

/**
 * Create a shared (non-personal) workspace owned by the actor.
 * Mirrors the sign-up personal-workspace transaction: workspace + owner
 * membership + outbox + audit in one transaction.
 */
@Injectable()
export class CreateWorkspaceUseCase {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async execute(cmd: CreateWorkspaceCommand): Promise<Result<{ workspaceId: string }>> {
    try {
      return await this.db.transaction(async (tx) => {
        const [ws] = await tx
          .insert(schema.workspaces)
          .values({
            name: cmd.name,
            slug: cmd.slug,
            isPersonal: 'false',
            ownerUserId: cmd.actorUserId,
          })
          .onConflictDoNothing()
          .returning({ id: schema.workspaces.id });
        if (!ws) return err(domainError('CONFLICT', 'workspace slug already exists'));

        await tx.insert(schema.memberships).values({
          workspaceId: ws.id,
          userId: cmd.actorUserId,
          scopeType: 'workspace',
          scopeId: ws.id,
          role: 'owner',
        });

        await tx.insert(schema.outboxEvents).values({
          workspaceId: ws.id,
          eventType: 'WorkspaceCreated',
          aggregateType: 'workspace',
          aggregateId: ws.id,
          payload: { kind: 'shared', ownerUserId: cmd.actorUserId },
          idempotencyKey: `workspace-create:${ws.id}`,
          requestId: cmd.requestId ?? null,
        });

        await tx.insert(schema.auditEvents).values({
          workspaceId: ws.id,
          actorUserId: cmd.actorUserId,
          action: 'workspace.create',
          scopeType: 'workspace',
          scopeId: ws.id,
          after: { name: cmd.name, slug: cmd.slug },
          requestId: cmd.requestId ?? null,
        });

        return ok({ workspaceId: ws.id });
      });
    } catch {
      return err(domainError('INTERNAL', 'workspace create failed'));
    }
  }
}
