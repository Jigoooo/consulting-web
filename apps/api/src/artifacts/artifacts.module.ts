import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { ArtifactsController } from './artifacts.controller.js';
import { ArtifactStore } from './artifact.store.js';

@Module({
  imports: [DrizzleModule, AuthModule, SpacesModule, ChatModule],
  controllers: [ArtifactsController],
  providers: [ArtifactStore],
  exports: [ArtifactStore],
})
export class ArtifactsModule {}
