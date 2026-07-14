import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { ConsultingModule } from '../consulting/consulting.module.js';
import { ArtifactContractController, ArtifactsController } from './artifacts.controller.js';
import { ArtifactStore } from './artifact.store.js';
import { ArtifactExportService } from './artifact-export.service.js';
import { ARTIFACT_VERIFICATION_LEDGER, ArtifactVerificationService } from './artifact-verification.service.js';
import { ArtifactVerificationDbLedger } from './artifact-verification-db-ledger.js';
import { ArtifactHumanReviewService } from './artifact-human-review.service.js';
import { ReportWorkflowShadowService } from '../workflows/report-workflow-shadow.service.js';
import { ArtifactRedTeamDbLedger } from './artifact-red-team-db-ledger.js';
import { ArtifactRedTeamJobStore } from './artifact-red-team-job.store.js';
import { ArtifactRedTeamWorker } from './artifact-red-team.worker.js';
import {
  ARTIFACT_RED_TEAM_AGENT,
  ARTIFACT_RED_TEAM_LEDGER,
  ArtifactRedTeamService,
  HermesArtifactRedTeamAgent,
} from './artifact-red-team.service.js';

@Module({
  imports: [DrizzleModule, AuthModule, SpacesModule, ChatModule, ConsultingModule],
  controllers: [ArtifactsController, ArtifactContractController],
  providers: [
    ArtifactStore,
    ArtifactExportService,
    ArtifactVerificationDbLedger,
    { provide: ARTIFACT_VERIFICATION_LEDGER, useExisting: ArtifactVerificationDbLedger },
    ArtifactRedTeamDbLedger,
    ArtifactRedTeamJobStore,
    { provide: ARTIFACT_RED_TEAM_LEDGER, useExisting: ArtifactRedTeamDbLedger },
    HermesArtifactRedTeamAgent,
    { provide: ARTIFACT_RED_TEAM_AGENT, useExisting: HermesArtifactRedTeamAgent },
    ArtifactRedTeamService,
    ArtifactRedTeamWorker,
    ArtifactVerificationService,
    ArtifactHumanReviewService,
    ReportWorkflowShadowService,
  ],
  exports: [ArtifactStore],
})
export class ArtifactsModule {}
