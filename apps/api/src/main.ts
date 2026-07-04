import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ENV_TOKEN } from './config/config.module.js';
import type { Env } from './config/env.schema.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const env = app.get<Env>(ENV_TOKEN);
  await app.listen(env.PORT);
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${env.PORT} (${env.APP_ENV})`);
}

void bootstrap();
