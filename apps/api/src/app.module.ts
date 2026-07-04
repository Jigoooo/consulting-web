import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './infra/db.module.js';
import { RedisModule } from './infra/redis.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [ConfigModule, DbModule, RedisModule, HealthModule],
})
export class AppModule {}
