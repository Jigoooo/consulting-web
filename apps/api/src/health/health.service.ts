import { Inject, Injectable } from '@nestjs/common';
import type { HealthComponent } from '@consulting/contracts';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
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
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  live(): { status: 'ok'; time: string } {
    return { status: 'ok', time: new Date().toISOString() };
  }

  async ready(): Promise<HealthSnapshot> {
    const [db, redis, hermes] = await Promise.all([this.checkDb(), this.checkRedis(), this.checkHermes()]);
    // bullmq shares the redis connection health in Phase 0.
    const bullmq: HealthComponent = redis;

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

  private async checkHermes(): Promise<HealthComponent> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    try {
      const baseUrl = this.env.HERMES_API_BASE_URL.replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/v1/health`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.env.HERMES_API_KEY}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) return 'degraded';
      const body: unknown = await response.json().catch(() => null);
      if (body && typeof body === 'object' && 'status' in body && body.status === 'ok') return 'ok';
      return 'degraded';
    } catch {
      return 'degraded';
    } finally {
      clearTimeout(timeout);
    }
  }
}
