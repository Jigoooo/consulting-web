import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ChatStreamController } from './chat-stream.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { AttachmentsController } from './attachments.controller.js';
import { ChatStreamUseCase } from './chat-stream.usecase.js';
import { HermesRunsClient } from './hermes-runs-client.js';
import { ChatMessageStore } from './chat-message.store.js';
import { EvidenceStore } from './evidence.store.js';
import { NotificationStore } from './notification.store.js';
import { DocumentExtractionService } from './document-extraction.service.js';

@Module({
  imports: [DrizzleModule, AuthModule],
  controllers: [ChatStreamController, NotificationsController, AttachmentsController],
  providers: [ChatStreamUseCase, HermesRunsClient, ChatMessageStore, EvidenceStore, NotificationStore, DocumentExtractionService],
  exports: [ChatStreamUseCase, HermesRunsClient, ChatMessageStore, EvidenceStore, NotificationStore, DocumentExtractionService],
})
export class ChatModule {}
