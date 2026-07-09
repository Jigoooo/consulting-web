import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { ObservabilityController } from './observability.controller.js';
import { ObservabilityStore } from './observability.store.js';

@Module({
  imports: [DrizzleModule, AuthModule, SpacesModule],
  controllers: [ObservabilityController],
  providers: [ObservabilityStore],
  exports: [ObservabilityStore],
})
export class ObservabilityModule {}
