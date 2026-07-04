import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ChatStreamController } from './chat-stream.controller.js';
import { ChatStreamUseCase } from './chat-stream.usecase.js';

@Module({
  imports: [DrizzleModule, AuthModule],
  controllers: [ChatStreamController],
  providers: [ChatStreamUseCase],
  exports: [ChatStreamUseCase],
})
export class ChatModule {}
