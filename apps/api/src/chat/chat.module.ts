import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { ConsultingModule } from '../consulting/consulting.module.js';
import { ChatStreamController } from './chat-stream.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { PushController } from './push.controller.js';
import { AttachmentsController } from './attachments.controller.js';
import { ChatStreamUseCase } from './chat-stream.usecase.js';
import { HermesRunsClient } from './hermes-runs-client.js';
import { RuntimeApprovalStore } from './runtime-approval.store.js';
import { ToolPolicyAuditStore } from '../security/tool-policy-audit.store.js';
import { ChatMessageStore } from './chat-message.store.js';
import { EvidenceStore } from './evidence.store.js';
import { NotificationStore } from './notification.store.js';
import { PushService } from './push.service.js';
import { DocumentExtractionService } from './document-extraction.service.js';
import { DocumentExtractionWorker } from './document-extraction.worker.js';
import { ChatTurnSettlementStore } from './chat-turn-settlement.store.js';
import { ChatTurnSettlementWorker } from './chat-turn-settlement.worker.js';
import { NotificationPushWorker } from './notification-push.worker.js';

@Module({
  imports: [DrizzleModule, AuthModule, SpacesModule, ConsultingModule],
  controllers: [ChatStreamController, NotificationsController, PushController, AttachmentsController],
  providers: [ChatStreamUseCase, HermesRunsClient, RuntimeApprovalStore, ToolPolicyAuditStore, ChatMessageStore, EvidenceStore, NotificationStore, PushService, NotificationPushWorker, DocumentExtractionService, DocumentExtractionWorker, ChatTurnSettlementStore, ChatTurnSettlementWorker],
  exports: [ChatStreamUseCase, HermesRunsClient, RuntimeApprovalStore, ChatMessageStore, EvidenceStore, NotificationStore, PushService, NotificationPushWorker, DocumentExtractionService, DocumentExtractionWorker, ChatTurnSettlementStore, ChatTurnSettlementWorker],
})
export class ChatModule {}
