import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { ENV_TOKEN } from './config/config.module.js';
import type { Env } from './config/env.schema.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false, bodyParser: false });
  // G-3 attachments post base64 payloads (10MB binary ≈ 13.7MB base64).
  // Default parser is disabled above (100kb cap) and re-registered with a
  // raised limit via the platform adapter — no direct express import needed.
  app.useBodyParser('json', { limit: '15mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });
  // Phase 3 C-3: do not leak the Express implementation detail on public API responses.
  app.disable('x-powered-by');
  const env = app.get<Env>(ENV_TOKEN);
  await app.listen(env.PORT);
  console.log(`[api] listening on :${env.PORT} (${env.APP_ENV})`);
}

void bootstrap();
