import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ScopeRepository } from './scope.repository.js';
import { SpaceAccessService } from './space-access.service.js';
import { SpaceReadService } from './space-read.service.js';
import { SpaceMutateService } from './space-mutate.service.js';
import { SpacesController } from './spaces.controller.js';
import { CreateChannelUseCase } from './create-channel.usecase.js';
import { CreateProjectUseCase } from './create-project.usecase.js';
import { CreateWorkspaceUseCase } from './create-workspace.usecase.js';
import { CreateTopicUseCase } from './create-topic.usecase.js';
import { CreateThreadUseCase } from './create-thread.usecase.js';

@Module({
  imports: [DrizzleModule, AuthModule],
  controllers: [SpacesController],
  providers: [ScopeRepository, SpaceAccessService, SpaceReadService, SpaceMutateService, CreateChannelUseCase, CreateProjectUseCase, CreateWorkspaceUseCase, CreateTopicUseCase, CreateThreadUseCase],
  exports: [ScopeRepository, SpaceAccessService, SpaceReadService, SpaceMutateService, CreateChannelUseCase, CreateProjectUseCase, CreateWorkspaceUseCase, CreateTopicUseCase, CreateThreadUseCase],
})
export class SpacesModule {}
