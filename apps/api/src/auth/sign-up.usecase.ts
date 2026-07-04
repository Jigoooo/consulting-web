import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { eq } from 'drizzle-orm';
import { ok, err, type Result, domainError } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { PASSWORD_HASHER, type PasswordHasher } from './password.js';

export interface SignUpCommand {
  email: string;
  password: string;
  displayName: string;
  requestId?: string;
}

export interface SignUpOutcome {
  userId: string;
  personalWorkspaceId: string;
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/**
 * Sign-up (ADR-0001/0005/0009): creates user + personal workspace + owner
 * membership + outbox/audit inside one transaction. Fails on duplicate email.
 */
@Injectable()
export class SignUpUseCase {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async execute(cmd: SignUpCommand): Promise<Result<SignUpOutcome>> {
    const email = cmd.email.trim().toLowerCase();

    const existing = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (existing.length > 0) {
      return err(domainError('CONFLICT', 'email already registered'));
    }

    const passwordHash = this.hasher.hash(cmd.password);

    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(schema.users)
          .values({ email, displayName: cmd.displayName, passwordHash })
          .returning({ id: schema.users.id });
        if (!user) throw new Error('user insert failed');

        const [ws] = await tx
          .insert(schema.workspaces)
          .values({
            name: `${cmd.displayName}'s Workspace`,
            slug: `personal-${slugify(cmd.displayName)}-${Date.now().toString(36)}`,
            isPersonal: 'true',
            ownerUserId: user.id,
          })
          .returning({ id: schema.workspaces.id });
        if (!ws) throw new Error('workspace insert failed');

        await tx.insert(schema.memberships).values({
          workspaceId: ws.id,
          userId: user.id,
          scopeType: 'workspace',
          scopeId: ws.id,
          role: 'owner',
        });

        await tx.insert(schema.outboxEvents).values({
          workspaceId: ws.id,
          eventType: 'WorkspaceCreated',
          aggregateType: 'workspace',
          aggregateId: ws.id,
          payload: { kind: 'personal', ownerUserId: user.id },
          idempotencyKey: `signup:${user.id}`,
          requestId: cmd.requestId ?? null,
        });

        await tx.insert(schema.auditEvents).values({
          workspaceId: ws.id,
          actorUserId: user.id,
          action: 'user.signup',
          scopeType: 'workspace',
          scopeId: ws.id,
          after: { email, displayName: cmd.displayName },
          requestId: cmd.requestId ?? null,
        });

        return ok({ userId: user.id, personalWorkspaceId: ws.id });
      });
    } catch {
      return err(domainError('INTERNAL', 'sign-up transaction failed'));
    }
  }
}
