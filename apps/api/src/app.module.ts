import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './infra/db.module.js';
import { RedisModule } from './infra/redis.module.js';
import { DrizzleModule } from './infra/drizzle.module.js';
import { HealthModule } from './health/health.module.js';
import { PermissionsModule } from './permissions/permissions.module.js';
import { AuthModule } from './auth/auth.module.js';
import { OrganizationModule } from './organization/organization.module.js';
import { SpacesModule } from './spaces/spaces.module.js';
import { ChatModule } from './chat/chat.module.js';
import { ArtifactsModule } from './artifacts/artifacts.module.js';
import { LibraryModule } from './library/library.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { QueuesModule } from './queues/queues.module.js';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    RedisModule,
    DrizzleModule,
    HealthModule,
    PermissionsModule,
    AuthModule,
    OrganizationModule,
    SpacesModule,
    ChatModule,
    ArtifactsModule,
    LibraryModule,
    ObservabilityModule,
    QueuesModule,
  ],
})
export class AppModule {}
