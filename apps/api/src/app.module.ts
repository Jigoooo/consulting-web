import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './infra/db.module.js';
import { RedisModule } from './infra/redis.module.js';
import { DrizzleModule } from './infra/drizzle.module.js';
import { HealthModule } from './health/health.module.js';
import { PermissionsModule } from './permissions/permissions.module.js';
import { AuthModule } from './auth/auth.module.js';
import { OrganizationModule } from './organization/organization.module.js';

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
  ],
})
export class AppModule {}
