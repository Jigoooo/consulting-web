import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { ScopeRepository } from './scope.repository.js';
import { CreateChannelUseCase } from './create-channel.usecase.js';
import { CreateProjectUseCase } from './create-project.usecase.js';

@Module({
  imports: [DrizzleModule],
  providers: [ScopeRepository, CreateChannelUseCase, CreateProjectUseCase],
  exports: [ScopeRepository, CreateChannelUseCase, CreateProjectUseCase],
})
export class SpacesModule {}
