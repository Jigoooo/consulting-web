import { Inject, Injectable } from '@nestjs/common';
import type { HealthComponent } from '@consulting/contracts';
import { DB_POOL } from '../infra/db.module.js';
import { REDIS_CLIENT } from '../infra/redis.module.js';
import type { Pool } from 'pg';
import type Redis from 'ioredis';

export interface HealthSnapshot {
  status: HealthComponent;
  components: {
    api: HealthComponent;
    db: HealthComponent;
    redis: HealthComponent;
    bullmq: HealthComponent;
    hermes: HealthComponent;
  };
  version: string;
  time: string;
}

const VERSION = '0.0.0';

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  live(): { status: 'ok'; time: string } {
    return { status: 'ok', time: new Date().toISOString() };
  }

  async ready(): Promise<HealthSnapshot> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    // bullmq shares the redis connection health in Phase 0.
    const bullmq: HealthComponent = redis;
    // hermes is optional in Phase 0 — degraded, not fatal.
    const hermes: HealthComponent = 'degraded';

    const critical: HealthComponent[] = [db, redis];
    const status: HealthComponent = critical.every((c) => c === 'ok')
      ? 'ok'
      : critical.some((c) => c === 'down')
        ? 'down'
        : 'degraded';

    return {
      status,
      components: { api: 'ok', db, redis, bullmq, hermes },
      version: VERSION,
      time: new Date().toISOString(),
    };
  }

  private async checkDb(): Promise<HealthComponent> {
    try {
      await this.pool.query('SELECT 1');
      return 'ok';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<HealthComponent> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG' ? 'ok' : 'degraded';
    } catch {
      return 'down';
    }
  }
}
