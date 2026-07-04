import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ChatStreamController } from './chat-stream.controller.js';
import { ChatStreamUseCase } from './chat-stream.usecase.js';
import { HermesRunsClient } from './hermes-runs-client.js';

@Module({
  imports: [DrizzleModule, AuthModule],
  controllers: [ChatStreamController],
  providers: [ChatStreamUseCase, HermesRunsClient],
  exports: [ChatStreamUseCase, HermesRunsClient],
})
export class ChatModule {}
