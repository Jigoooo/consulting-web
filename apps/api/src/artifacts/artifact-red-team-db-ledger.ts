import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import type { ArtifactRedTeamSnapshot } from './artifact-export-preflight-audit.js';
import {
  ARTIFACT_RED_TEAM_POLICY_VERSION,
  parseArtifactRedTeamOutput,
  type ArtifactRedTeamLedger,
} from './artifact-red-team.service.js';
import type { ArtifactVerificationTarget } from './artifact-verification.service.js';

const MetaSchema = z.object({
  mode: z.enum(['shadow', 'warning']),
  status: z.enum(['completed', 'failed']),
  verdict: z.enum(['PASS', 'PASS_WITH_WARNINGS', 'BLOCKED']),
}).strict();

@Injectable()
export class ArtifactRedTeamDbLedger implements ArtifactRedTeamLedger {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async latest(target: ArtifactVerificationTarget): Promise<ArtifactRedTeamSnapshot | null> {
    const [row] = await this.db
      .select({
        artifactId: schema.artifactRedTeamRuns.artifactId,
        artifactVersionId: schema.artifactRedTeamRuns.artifactVersionId,
        workspaceId: schema.artifactRedTeamRuns.workspaceId,
        projectId: schema.artifactRedTeamRuns.projectId,
        contentHash: schema.artifactRedTeamRuns.contentHash,
        mode: schema.artifactRedTeamRuns.mode,
        status: schema.artifactRedTeamRuns.status,
        policyVersion: schema.artifactRedTeamRuns.policyVersion,
        attacks: schema.artifactRedTeamRuns.attacks,
        defenses: schema.artifactRedTeamRuns.defenses,
        verdict: schema.artifactRedTeamRuns.verdict,
        createdAt: schema.artifactRedTeamRuns.createdAt,
      })
      .from(schema.artifactRedTeamRuns)
      .where(and(
        eq(schema.artifactRedTeamRuns.workspaceId, target.workspaceId),
        eq(schema.artifactRedTeamRuns.projectId, target.projectId),
        eq(schema.artifactRedTeamRuns.artifactId, target.artifactId),
        eq(schema.artifactRedTeamRuns.artifactVersionId, target.artifactVersionId),
      ))
      .orderBy(desc(schema.artifactRedTeamRuns.sequenceNo))
      .limit(1);
    if (!row || row.policyVersion !== ARTIFACT_RED_TEAM_POLICY_VERSION) return null;
    try {
      const meta = MetaSchema.parse({ mode: row.mode, status: row.status, verdict: row.verdict });
      const parsed = parseArtifactRedTeamOutput(JSON.stringify({
        verdict: meta.verdict,
        attacks: row.attacks,
        defenses: row.defenses.map((defense) => ({
          attack_index: defense['attackIndex'],
          response: defense['response'],
          disposition: defense['disposition'],
        })),
      }));
      return {
        artifactId: row.artifactId,
        artifactVersionId: row.artifactVersionId,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        contentHash: row.contentHash,
        status: meta.status,
        verdict: parsed.verdict,
        policyVersion: row.policyVersion,
        reviewedAt: row.createdAt.toISOString(),
        attacks: parsed.attacks,
        defenses: parsed.defenses,
      };
    } catch {
      return {
        artifactId: row.artifactId,
        artifactVersionId: row.artifactVersionId,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        contentHash: row.contentHash,
        status: 'failed',
        verdict: 'BLOCKED',
        policyVersion: row.policyVersion,
        reviewedAt: row.createdAt.toISOString(),
        attacks: [],
        defenses: [],
      };
    }
  }

}
