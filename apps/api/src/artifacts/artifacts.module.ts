import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { ConsultingModule } from '../consulting/consulting.module.js';
import { ArtifactsController } from './artifacts.controller.js';
import { ArtifactStore } from './artifact.store.js';
import { ArtifactExportService } from './artifact-export.service.js';

@Module({
  imports: [DrizzleModule, AuthModule, SpacesModule, ChatModule, ConsultingModule],
  controllers: [ArtifactsController],
  providers: [ArtifactStore, ArtifactExportService],
  exports: [ArtifactStore],
})
export class ArtifactsModule {}
