import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';

export const DB_POOL = Symbol('DB_POOL');

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): Pool => new Pool({ connectionString: env.DATABASE_URL, max: 10 }),
    },
  ],
  exports: [DB_POOL],
})
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
